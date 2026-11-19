import { isDynamicRecord } from "@tommy/contracts/runtime-values";
import { redactText, registerSecretValue } from "@tommy/logging";
import { Effect, Option, Schema } from "effect";
import { type ConnectorJson, type WorkflowConnectorFetch, WorkflowConnectorHttp } from "./workflow-connector-http";

const accountId = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 ** 52 - 1 }));
const username = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_]{1,32}$/));
const userFields = {
  id: accountId,
  first_name: Schema.String.check(Schema.isBetweenLength(1, 256)),
  username: Schema.optionalKey(username),
  language_code: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(1, 64))),
};
const telegramAccount = Schema.Struct({
  ...userFields,
  is_bot: Schema.Literal(true),
  username,
  can_manage_bots: Schema.optionalKey(Schema.Boolean),
});
const managedUpdate = Schema.Struct({
  user: Schema.Struct({ ...userFields, is_bot: Schema.Literal(false) }),
  bot: telegramAccount,
});
const fileId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,256}$/));
const incomingMessage = Schema.Struct({
  message_id: Schema.Int.check(Schema.isGreaterThan(0)),
  chat: Schema.Struct({
    id: Schema.Int.check(
      Schema.isBetween({ minimum: -(2 ** 52 - 1), maximum: 2 ** 52 - 1 }),
      Schema.makeFilter((id) => id !== 0),
    ),
    type: Schema.Literals(["private", "group", "supergroup"]),
  }),
  from: Schema.Struct({ ...userFields, is_bot: Schema.Boolean }),
  // A channel, anonymous administrator, or business connection can act on behalf of a different identity.
  sender_chat: Schema.optionalKey(Schema.Never),
  business_connection_id: Schema.optionalKey(Schema.Never),
  text: Schema.optionalKey(Schema.String.check(Schema.isBetweenCodePoints(1, 4096))),
  caption: Schema.optionalKey(Schema.String.check(Schema.isBetweenCodePoints(1, 1024))),
  photo: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        file_id: fileId,
        file_size: Schema.optionalKey(Schema.Int),
        width: Schema.Int,
        height: Schema.Int,
      }),
    ),
  ),
  document: Schema.optionalKey(
    Schema.Struct({
      file_id: fileId,
      file_name: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(1, 255))),
      mime_type: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(1, 255))),
      file_size: Schema.optionalKey(Schema.Int),
    }),
  ),
});
const updateId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const update = Schema.Union([
  Schema.Struct({ update_id: updateId, managed_bot: managedUpdate, message: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ update_id: updateId, message: incomingMessage, managed_bot: Schema.optionalKey(Schema.Never) }),
]);
type DecodedMessage = typeof incomingMessage.Type;
/** A file the owner sent. The bot that received it downloads it with its own token. */
export interface TelegramFileRef {
  fileId: string;
  name: string;
  mimeType: string;
  size: number | null;
}
export type TelegramMessage = Omit<DecodedMessage, "text" | "caption" | "photo" | "document"> & {
  /** The text, or the caption of a photo or file. Empty when a file came without one. */
  text: string;
  files: TelegramFileRef[];
};
export type TelegramUpdate =
  | Extract<typeof update.Type, { managed_bot: unknown }>
  | { update_id: number; message: TelegramMessage; managed_bot?: never };
export type TelegramAccount = typeof telegramAccount.Type;

const decodeUpdate = Schema.decodeUnknownOption(update);
export function decodeTelegramUpdate(body: unknown): TelegramUpdate | null {
  const decoded = Option.getOrNull(decodeUpdate(body));
  if (!decoded) return null;
  if (decoded.managed_bot) return { update_id: decoded.update_id, managed_bot: decoded.managed_bot };
  if (!decoded.message) return null;
  const { text, caption, photo, document, ...rest } = decoded.message;
  const files: TelegramFileRef[] = [];
  // Telegram sends each photo in several sizes. The last is the largest.
  const largest = photo?.at(-1);
  if (largest)
    files.push({ fileId: largest.file_id, name: "photo.jpg", mimeType: "image/jpeg", size: largest.file_size ?? null });
  if (document)
    files.push({
      fileId: document.file_id,
      name: document.file_name ?? "file",
      mimeType: document.mime_type ?? "application/octet-stream",
      size: document.file_size ?? null,
    });
  const messageText = text ?? caption ?? "";
  if (!messageText && files.length === 0) return null;
  return { update_id: decoded.update_id, message: { ...rest, text: messageText, files } };
}

type TelegramLinkButton = { text: string; url: string } | { text: string; web_app: { url: string } };
export type TelegramReplyMarkup =
  | { inline_keyboard: TelegramLinkButton[][] }
  | {
      keyboard: {
        text: string;
        request_managed_bot?: { request_id: number; suggested_name?: string; suggested_username?: string };
      }[][];
      resize_keyboard?: boolean;
      one_time_keyboard?: boolean;
    }
  | { remove_keyboard: true };

const credential = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,15}:[A-Za-z0-9_-]{1,256}$/));
const validCredential = Schema.is(credential);
const posted = Schema.Struct({ message_id: Schema.Int });
const downloadLimit = 20 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Untrusted response bodies and request URLs can contain credentials. Only the category and status may leave here. */
export class TelegramApiFailure extends Schema.TaggedError<TelegramApiFailure>()("TelegramApiFailure", {
  kind: Schema.Literals(["input", "transport", "api", "response"]),
  status: Schema.Int,
}) {}

export class TelegramApi {
  readonly #http: WorkflowConnectorHttp;

  constructor(request?: WorkflowConnectorFetch) {
    this.#http = new WorkflowConnectorHttp(request);
  }

  readonly #request = <S extends Schema.ConstraintDecoder<unknown>>(
    token: string,
    method:
      | "getMe"
      | "getWebhookInfo"
      | "getManagedBotToken"
      | "setMyName"
      | "setMyCommands"
      | "sendChatAction"
      | "deleteMessage"
      | "getFile"
      | "sendMessage"
      | "sendPhoto"
      | "setWebhook",
    payload: () => ConnectorJson | FormData,
    resultSchema: S,
  ) =>
    Effect.gen({ self: this }, function* () {
      if (!validCredential(token)) return yield* Effect.fail(new TelegramApiFailure({ kind: "input", status: 0 }));
      registerSecretValue(token);
      const envelope = yield* this.#http
        .json({ url: `https://api.telegram.org/bot${token}/${method}`, method: "POST", body: payload() })
        .pipe(
          Effect.mapError(
            (error) => new TelegramApiFailure({ kind: error.status === 0 ? "transport" : "api", status: error.status }),
          ),
        );
      if (!isDynamicRecord(envelope) || envelope.ok !== true) {
        const status = isDynamicRecord(envelope) && typeof envelope.error_code === "number" ? envelope.error_code : 0;
        return yield* Effect.fail(new TelegramApiFailure({ kind: "api", status }));
      }
      const decoded = Schema.decodeUnknownOption(resultSchema)(envelope.result);
      if (Option.isNone(decoded)) return yield* Effect.fail(new TelegramApiFailure({ kind: "response", status: 0 }));
      return decoded.value;
    });

  readonly getMe = Effect.fn("TelegramApi.getMe")(function* (this: TelegramApi, token: string) {
    const account = yield* this.#request(token, "getMe", () => ({}), telegramAccount);
    if (!token.startsWith(`${account.id}:`))
      return yield* Effect.fail(new TelegramApiFailure({ kind: "response", status: 0 }));
    return account;
  }).bind(this);

  readonly webhookInfo = Effect.fn("TelegramApi.webhookInfo")(function* (this: TelegramApi, token: string) {
    return yield* this.#request(
      token,
      "getWebhookInfo",
      () => ({}),
      Schema.Struct({
        url: Schema.String,
        pending_update_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        allowed_updates: Schema.optionalKey(Schema.Array(Schema.String)),
        last_error_date: Schema.optionalKey(Schema.Int),
      }),
    );
  }).bind(this);

  readonly getManagedBotToken = Effect.fn("TelegramApi.getManagedBotToken")(function* (
    this: TelegramApi,
    managerToken: string,
    id: number,
  ) {
    const token = yield* this.#request(managerToken, "getManagedBotToken", () => ({ user_id: id }), credential);
    if (!token.startsWith(`${id}:`)) return yield* Effect.fail(new TelegramApiFailure({ kind: "response", status: 0 }));
    registerSecretValue(token);
    return token;
  }).bind(this);

  readonly setMyName = Effect.fn("TelegramApi.setMyName")(function* (
    this: TelegramApi,
    token: string,
    name: string,
  ): Effect.fn.Return<void, TelegramApiFailure> {
    registerSecretValue(token);
    if (!name || [...name].length > 64 || redactText(name) !== name)
      return yield* Effect.fail(new TelegramApiFailure({ kind: "input", status: 0 }));
    yield* this.#request(token, "setMyName", () => ({ name }), Schema.Literal(true));
  }).bind(this);

  readonly sendMessage = Effect.fn("TelegramApi.sendMessage")(function* (
    this: TelegramApi,
    token: string,
    chat: number | string,
    text: string,
    markup?: TelegramReplyMarkup,
    /** The text is Telegram HTML from telegramHtml. */
    html = false,
  ): Effect.fn.Return<void, TelegramApiFailure> {
    // Redaction inside a button URL could change the destination. Reject that keyboard as a unit.
    registerSecretValue(token);
    const keyboard = JSON.stringify(markup);
    if (keyboard && redactText(keyboard) !== keyboard) {
      return yield* Effect.fail(new TelegramApiFailure({ kind: "input", status: 0 }));
    }
    yield* this.#request(
      token,
      "sendMessage",
      () => ({
        chat_id: chat,
        text: redactText(text),
        ...(html ? { parse_mode: "HTML" } : {}),
        ...(markup ? { reply_markup: markup } : {}),
      }),
      posted,
    );
  }).bind(this);

  /** The command menu that Telegram shows after "/". An empty language is the default menu. */
  readonly setMyCommands = Effect.fn("TelegramApi.setMyCommands")(function* (
    this: TelegramApi,
    token: string,
    commands: readonly { command: string; description: string }[],
    languageCode: string,
  ): Effect.fn.Return<void, TelegramApiFailure> {
    registerSecretValue(token);
    yield* this.#request(
      token,
      "setMyCommands",
      () => ({
        commands: commands.map(({ command, description }) => ({ command, description: description.slice(0, 256) })),
        ...(languageCode ? { language_code: languageCode } : {}),
      }),
      Schema.Literal(true),
    );
  }).bind(this);

  /** The bytes of a file the owner sent, up to the Bot API limit of 20 MB. */
  readonly downloadFile = Effect.fn("TelegramApi.downloadFile")(function* (
    this: TelegramApi,
    token: string,
    fileId: string,
  ): Effect.fn.Return<Uint8Array, TelegramApiFailure> {
    registerSecretValue(token);
    const file = yield* this.#request(
      token,
      "getFile",
      () => ({ file_id: fileId }),
      Schema.Struct({
        file_path: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_./-]{1,512}$/)),
        file_size: Schema.optionalKey(Schema.Int),
      }),
    );
    if (file.file_path.includes("..") || (file.file_size ?? 0) > downloadLimit)
      return yield* Effect.fail(new TelegramApiFailure({ kind: "input", status: 0 }));
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
          redirect: "error",
        });
        if (!response.ok) throw new Error(String(response.status));
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > downloadLimit) throw new Error("too large");
        return bytes;
      },
      catch: () => new TelegramApiFailure({ kind: "transport", status: 0 }),
    });
  }).bind(this);

  readonly deleteMessage = Effect.fn("TelegramApi.deleteMessage")(function* (
    this: TelegramApi,
    token: string,
    chat: number,
    messageId: number,
  ): Effect.fn.Return<void, TelegramApiFailure> {
    registerSecretValue(token);
    yield* this.#request(
      token,
      "deleteMessage",
      () => ({ chat_id: chat, message_id: messageId }),
      Schema.Literal(true),
    );
  }).bind(this);

  /** Shows "typing" in the chat for about five seconds. */
  readonly sendTyping = Effect.fn("TelegramApi.sendTyping")(function* (
    this: TelegramApi,
    token: string,
    chat: number,
  ): Effect.fn.Return<void, TelegramApiFailure> {
    registerSecretValue(token);
    yield* this.#request(token, "sendChatAction", () => ({ chat_id: chat, action: "typing" }), Schema.Literal(true));
  }).bind(this);

  readonly sendPhoto = Effect.fn("TelegramApi.sendPhoto")(function* (
    this: TelegramApi,
    token: string,
    chat: number,
    image: Buffer,
    caption: string,
  ): Effect.fn.Return<void, TelegramApiFailure> {
    if (image.byteLength > 10 * 1024 * 1024 || !image.subarray(0, pngSignature.length).equals(pngSignature)) {
      return yield* Effect.fail(new TelegramApiFailure({ kind: "input", status: 0 }));
    }
    yield* this.#request(
      token,
      "sendPhoto",
      () => {
        const form = new FormData();
        form.set("chat_id", String(chat));
        form.set("caption", redactText(caption));
        form.set("photo", new Blob([Uint8Array.from(image)], { type: "image/png" }), "preview.png");
        return form;
      },
      posted,
    );
  }).bind(this);

  readonly setWebhook = Effect.fn("TelegramApi.setWebhook")(function* (
    this: TelegramApi,
    token: string,
    url: string,
    secret: string,
  ) {
    const endpoint = URL.parse(url);
    if (
      endpoint?.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(secret)
    ) {
      return yield* Effect.fail(new TelegramApiFailure({ kind: "input", status: 0 }));
    }
    registerSecretValue(secret);
    yield* this.#request(
      token,
      "setWebhook",
      () => ({
        url,
        secret_token: secret,
        allowed_updates: ["message", "managed_bot"],
        max_connections: 1,
      }),
      Schema.Literal(true),
    );
  }).bind(this);
}
