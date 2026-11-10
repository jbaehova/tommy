import { createHash } from "node:crypto";
import type { WorkflowGitHubCatalog, WorkflowIntegrationCatalog } from "@tommy/contracts/ipc";
import { isDynamicRecord } from "@tommy/contracts/runtime-values";
import { WEBHOOK_DELIVERY_BODY_BYTES_LIMIT } from "@tommy/contracts/signal-protocol/messages";
import { WEBHOOK_DELIVERY_ID_PATTERN } from "@tommy/contracts/signal-protocol/webhook-route";
import { redactText } from "@tommy/logging";
import { Effect, Schema } from "effect";
import type { MessagingPostFailure } from "../backend/workflows/discord-types";
import type { MessagingSlackSend, MessagingTelegramSend } from "../backend/workflows/workflow-chat-types";
import type { WorkflowsHandle } from "../backend/workflows/workflows";
import {
  registerWorkflowConnectorSecrets,
  type SlackWorkflowConnection,
  type TelegramWorkflowConnection,
  type WorkflowConnectorConfig,
} from "./workflow-connector-config";
import { WorkflowConnectorGitHub } from "./workflow-connector-github";
import { type ConnectorJson, type WorkflowConnectorFetch, WorkflowConnectorHttp } from "./workflow-connector-http";
import { equalWebhookSecret, verifyGitHubWebhook, verifySlackWebhook } from "./workflow-connector-security";

const text = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));
const identifier = text(128).check(Schema.isMinLength(1));
const integer = Schema.Number.check(Schema.isInt());
const positiveInteger = integer.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const slackFile = Schema.Struct({
  name: Schema.optionalKey(text(1_024)),
  mimetype: Schema.optionalKey(text(256)),
  size: Schema.optionalKey(integer.check(Schema.isGreaterThanOrEqualTo(0))),
});
const slackEvent = Schema.Struct({
  type: text(100),
  user: Schema.optionalKey(identifier),
  channel: Schema.optionalKey(identifier),
  text: Schema.optionalKey(text(64 * 1_024)),
  ts: Schema.optionalKey(text(64)),
  thread_ts: Schema.optionalKey(text(64)),
  subtype: Schema.optionalKey(text(100)),
  bot_id: Schema.optionalKey(identifier),
  files: Schema.optionalKey(Schema.Array(slackFile).check(Schema.isMaxLength(100))),
});
const SlackEnvelope = Schema.Struct({
  type: text(100),
  challenge: Schema.optionalKey(text(3_000)),
  team_id: Schema.optionalKey(identifier),
  event_id: Schema.optionalKey(identifier),
  event: Schema.optionalKey(slackEvent),
});
const telegramUser = Schema.Struct({
  id: positiveInteger,
  is_bot: Schema.Boolean,
  first_name: Schema.optionalKey(text(256)),
  last_name: Schema.optionalKey(text(256)),
  username: Schema.optionalKey(text(64)),
});
const telegramEntities = Schema.Array(
  Schema.Struct({
    type: text(100),
    offset: integer,
    length: integer,
    user: Schema.optionalKey(telegramUser),
  }),
).check(Schema.isMaxLength(100));
const TelegramUpdate = Schema.Struct({
  update_id: integer,
  message: Schema.optionalKey(
    Schema.Struct({
      message_id: positiveInteger,
      message_thread_id: Schema.optionalKey(positiveInteger),
      from: Schema.optionalKey(telegramUser),
      sender_chat: Schema.optionalKey(Schema.JsonObject),
      chat: Schema.Struct({ id: integer, type: text(32), title: Schema.optionalKey(text(256)) }),
      text: Schema.optionalKey(text(64 * 1_024)),
      caption: Schema.optionalKey(text(64 * 1_024)),
      entities: Schema.optionalKey(telegramEntities),
      caption_entities: Schema.optionalKey(telegramEntities),
      reply_to_message: Schema.optionalKey(Schema.Struct({ from: Schema.optionalKey(telegramUser) })),
    }),
  ),
});
const ApiResult = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(text(256)),
  error_code: Schema.optionalKey(integer),
});

export interface WorkflowConnectorWebhook {
  /** The HTTP adapter refuses duplicate headers before this accessor returns a value. */
  header(name: string): string;
  body: Uint8Array;
}

export interface WorkflowConnectorWebhookResult {
  status: number;
  challenge?: string;
}

export interface WorkflowConnectorsOptions {
  config: WorkflowConnectorConfig;
  workflows(): Pick<WorkflowsHandle, "receiveGitHub" | "receiveSlack" | "receiveTelegram"> | null;
  request?: WorkflowConnectorFetch;
  /** Used only to confirm repository hook subscriptions in the GitHub catalog. */
  publicWebhookOrigin?: string | null;
}

type PostResult = { posted: true } | { failure: MessagingPostFailure };
const posted: PostResult = { posted: true };
const refused: PostResult = { failure: "refused" };
const gone: PostResult = { failure: "gone" };
const stopped: PostResult = { failure: "not-running" };
const uncertain: PostResult = { failure: "unknown" };

/** The body limit of the GitHub route. It equals the limit of the proxy location in nginx-tommy.conf. */
export const GITHUB_WEBHOOK_BODY_BYTES_LIMIT = 1024 * 1024;

function decodeBody(body: Uint8Array, limitBytes = WEBHOOK_DELIVERY_BODY_BYTES_LIMIT): ConnectorJson | null {
  if (body.byteLength > limitBytes) return null;
  try {
    return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
  } catch {
    return null;
  }
}

/** Splits on Unicode code points, so a split cannot corrupt a surrogate pair. */
function chunks(text: string, limit: number): string[] {
  const result: string[] = [];
  let chunk = "";
  for (const point of text) {
    if (chunk.length + point.length > limit) {
      result.push(chunk);
      chunk = "";
    }
    chunk += point;
  }
  if (chunk) result.push(chunk);
  return result;
}

/** Optional host-owned integrations. Startup does not contact a provider or create a cloud account. */
export class WorkflowConnectors {
  readonly #options: WorkflowConnectorsOptions;
  readonly #http: WorkflowConnectorHttp;
  readonly #github: WorkflowConnectorGitHub | null;
  #running = false;

  constructor(options: WorkflowConnectorsOptions) {
    this.#options = options;
    registerWorkflowConnectorSecrets(options.config);
    this.#http = new WorkflowConnectorHttp(options.request);
    this.#github = options.config.github
      ? new WorkflowConnectorGitHub(options.config.github, this.#http, options.publicWebhookOrigin ?? null)
      : null;
  }

  readonly start = Effect.fn("WorkflowConnectors.start")(function* (this: WorkflowConnectors) {
    this.#running = true;
    yield* Effect.void;
  }).bind(this);

  readonly stop = Effect.fn("WorkflowConnectors.stop")(function* (this: WorkflowConnectors) {
    this.#running = false;
    yield* Effect.void;
  }).bind(this);

  githubApi(): WorkflowConnectorGitHub | undefined {
    return this.#github ?? undefined;
  }

  githubApp(): string | null {
    return this.#options.config.github?.appSlug ?? null;
  }

  readonly githubCatalog = Effect.fn("WorkflowConnectors.githubCatalog")(function* (this: WorkflowConnectors) {
    if (!this.#github) return { connected: false, repositories: [] } satisfies WorkflowGitHubCatalog;
    return yield* this.#github.catalog();
  }).bind(this);

  connectionOn(connectionId: string): boolean {
    return (
      this.#running &&
      [...(this.#options.config.slack ?? []), ...(this.#options.config.telegram ?? [])].some(
        (connection) => connection.id === connectionId,
      )
    );
  }

  /** This is the only connector metadata allowed to cross IPC or WSS. It contains no credential. */
  catalog(): WorkflowIntegrationCatalog {
    const slack = this.#options.config.slack ?? [];
    const telegram = this.#options.config.telegram ?? [];
    return {
      github: this.#github !== null,
      slack: slack.map((connection) => ({
        connectionId: connection.id,
        name: connection.name,
        channels: connection.channels.map((channel) => ({ id: channel.id, name: channel.name })),
      })),
      telegram: telegram.map((connection) => ({ connectionId: connection.id, name: connection.name })),
      discord: [],
      places: [
        ...slack.flatMap((connection) =>
          connection.channels.map((channel) => ({
            connectionId: connection.id,
            placeId: channel.id,
            label: `${connection.name} / ${channel.name}`,
            platform: "slack" as const,
            connection: connection.name,
            name: channel.name,
          })),
        ),
        ...telegram.map((connection) => ({
          connectionId: connection.id,
          placeId: connection.chatId,
          label: connection.name,
          platform: "telegram" as const,
          connection: connection.name,
          name: connection.name,
        })),
      ],
    };
  }

  readonly post = Effect.fn("WorkflowConnectors.post")(function* (
    this: WorkflowConnectors,
    connectionId: string,
    placeId: string,
    markdown: string,
  ): Effect.fn.Return<PostResult> {
    const telegram = this.#options.config.telegram?.find((connection) => connection.id === connectionId);
    if (telegram) {
      if (telegram.chatId !== placeId) return refused;
      return yield* this.telegramSend(connectionId, { action: "post", text: markdown });
    }
    return yield* this.slackSend(connectionId, { action: "post", channelId: placeId, text: markdown });
  }).bind(this);

  readonly slackSend = Effect.fn("WorkflowConnectors.slackSend")(function* (
    this: WorkflowConnectors,
    connectionId: string,
    send: MessagingSlackSend,
  ): Effect.fn.Return<PostResult> {
    const connection = this.#options.config.slack?.find((candidate) => candidate.id === connectionId);
    if (!connection) return gone;
    if (!this.#running) return stopped;
    if (!connection.channels.some((channel) => channel.id === send.channelId)) return refused;
    if (send.action === "react") {
      if (
        !/^\d+\.\d+$/.test(send.messageId) ||
        !/^[a-z0-9_+-]{1,64}$/.test(send.emoji) ||
        redactText(send.emoji) !== send.emoji
      )
        return refused;
      return yield* this.#slackCall(connection, "reactions.add", {
        channel: send.channelId,
        timestamp: send.messageId,
        name: send.emoji,
      });
    }
    if (send.text.length > 64 * 1_024 || (send.action === "reply" && !/^\d+\.\d+$/.test(send.threadId))) return refused;
    for (const text of chunks(redactText(send.text), 3_500)) {
      const result = yield* this.#slackCall(connection, "chat.postMessage", {
        channel: send.channelId,
        text,
        unfurl_links: false,
        unfurl_media: false,
        ...(send.action === "reply" ? { thread_ts: send.threadId } : {}),
      });
      if ("failure" in result) return result;
    }
    return posted;
  }).bind(this);

  readonly telegramSend = Effect.fn("WorkflowConnectors.telegramSend")(function* (
    this: WorkflowConnectors,
    connectionId: string,
    send: MessagingTelegramSend,
  ): Effect.fn.Return<PostResult> {
    const connection = this.#options.config.telegram?.find((candidate) => candidate.id === connectionId);
    if (!connection) return gone;
    if (!this.#running) return stopped;
    if (send.action === "react") {
      if (!/^\d{1,16}$/.test(send.messageId) || !["👍", "👀", "🎉", "👌"].includes(send.emoji)) return refused;
      return yield* this.#telegramCall(connection, "setMessageReaction", {
        chat_id: connection.chatId,
        message_id: Number(send.messageId),
        reaction: [{ type: "emoji", emoji: send.emoji }],
      });
    }
    if (send.text.length > 64 * 1_024) return refused;
    if (send.action === "reply" && (!/^\d{1,16}$/.test(send.messageId) || !/^\d{0,16}$/.test(send.threadKey)))
      return refused;
    for (const text of chunks(redactText(send.text), 4_000)) {
      const result = yield* this.#telegramCall(connection, "sendMessage", {
        chat_id: connection.chatId,
        text,
        link_preview_options: { is_disabled: true },
        ...(send.action === "reply"
          ? {
              reply_parameters: { message_id: Number(send.messageId), allow_sending_without_reply: false },
              ...(send.threadKey ? { message_thread_id: Number(send.threadKey) } : {}),
            }
          : {}),
      });
      if ("failure" in result) return result;
    }
    return posted;
  }).bind(this);

  readonly #slackCall = Effect.fn("WorkflowConnectors.slackCall")(function* (
    this: WorkflowConnectors,
    connection: SlackWorkflowConnection,
    method: "chat.postMessage" | "reactions.add",
    body: ConnectorJson,
  ): Effect.fn.Return<PostResult> {
    const result = yield* Effect.result(
      this.#http.json({
        url: `https://slack.com/api/${method}`,
        method: "POST",
        headers: { Authorization: `Bearer ${connection.token}` },
        body,
      }),
    );
    if (result._tag === "Failure")
      return result.failure.status === 403 || result.failure.status === 401 ? refused : uncertain;
    try {
      const response = Schema.decodeUnknownSync(ApiResult)(result.success);
      return response.ok || response.error === "already_reacted" ? posted : refused;
    } catch {
      return uncertain;
    }
  }).bind(this);

  readonly #telegramCall = Effect.fn("WorkflowConnectors.telegramCall")(function* (
    this: WorkflowConnectors,
    connection: TelegramWorkflowConnection,
    method: "sendMessage" | "setMessageReaction",
    body: ConnectorJson,
  ): Effect.fn.Return<PostResult> {
    const result = yield* Effect.result(
      this.#http.json({
        // This path is defined by Telegram's released API. Register its token before creating the URL.
        url: `https://api.telegram.org/bot${connection.token}/${method}`,
        method: "POST",
        body,
      }),
    );
    if (result._tag === "Failure")
      return result.failure.status >= 400 && result.failure.status < 500 ? refused : uncertain;
    try {
      return Schema.decodeUnknownSync(ApiResult)(result.success).ok ? posted : refused;
    } catch {
      return uncertain;
    }
  }).bind(this);

  readonly receiveGitHub = Effect.fn("WorkflowConnectors.receiveGitHub")(function* (
    this: WorkflowConnectors,
    input: WorkflowConnectorWebhook,
  ): Effect.fn.Return<WorkflowConnectorWebhookResult> {
    const connection = this.#options.config.github;
    if (!connection || !this.#github) return { status: 404 };
    if (!this.#running) return { status: 503 };
    if (input.body.byteLength > GITHUB_WEBHOOK_BODY_BYTES_LIMIT) return { status: 413 };
    if (!verifyGitHubWebhook(connection.webhookSecret, input.body, input.header("x-hub-signature-256")))
      return { status: 401 };
    const delivery = input.header("x-github-delivery");
    const event = input.header("x-github-event");
    if (!WEBHOOK_DELIVERY_ID_PATTERN.test(delivery) || !/^[a-z_]{1,100}$/.test(event)) return { status: 400 };
    const body = decodeBody(input.body, GITHUB_WEBHOOK_BODY_BYTES_LIMIT);
    if (!isDynamicRecord(body)) return { status: 400 };
    if (event === "ping") return { status: 200 };
    if (
      !isDynamicRecord(body.repository) ||
      typeof body.repository.full_name !== "string" ||
      !this.#github.allows(body.repository.full_name)
    )
      return { status: 403 };
    const workflows = this.#options.workflows();
    if (!workflows) return { status: 503 };
    // GitHub does not sign its delivery header. The signed body hash prevents a replay under a new ID.
    const deliveryId = `github:${createHash("sha256").update(input.body).digest("hex")}`;
    const result = yield* Effect.result(workflows.receiveGitHub({ event, deliveryId, body }));
    return { status: result._tag === "Success" ? 202 : 503 };
  }).bind(this);

  readonly receiveSlack = Effect.fn("WorkflowConnectors.receiveSlack")(function* (
    this: WorkflowConnectors,
    connectionId: string,
    input: WorkflowConnectorWebhook,
  ): Effect.fn.Return<WorkflowConnectorWebhookResult> {
    const connection = this.#options.config.slack?.find((candidate) => candidate.id === connectionId);
    if (!connection) return { status: 404 };
    if (!this.#running) return { status: 503 };
    if (input.body.byteLength > WEBHOOK_DELIVERY_BODY_BYTES_LIMIT) return { status: 413 };
    if (
      !verifySlackWebhook(
        connection.signingSecret,
        input.body,
        input.header("x-slack-request-timestamp"),
        input.header("x-slack-signature"),
      )
    )
      return { status: 401 };
    let envelope: typeof SlackEnvelope.Type;
    try {
      envelope = Schema.decodeUnknownSync(SlackEnvelope)(decodeBody(input.body));
    } catch {
      return { status: 400 };
    }
    if (envelope.type === "url_verification" && envelope.challenge)
      return { status: 200, challenge: envelope.challenge };
    const event = envelope.event;
    if (envelope.type !== "event_callback" || envelope.team_id !== connection.workspaceId) return { status: 403 };
    const channel = connection.channels.find((candidate) => candidate.id === event?.channel);
    if (
      !event ||
      event.type !== "app_mention" ||
      !channel ||
      !event.user ||
      event.user === connection.serviceUserId ||
      event.bot_id ||
      event.subtype
    )
      return { status: 202 };
    if (!event.ts || !/^\d+\.\d+$/.test(event.ts) || (event.thread_ts && !/^\d+\.\d+$/.test(event.thread_ts)))
      return { status: 400 };
    const workflows = this.#options.workflows();
    if (!workflows) return { status: 503 };
    const result = yield* Effect.result(
      workflows.receiveSlack({
        connectionId,
        workspaceName: connection.name,
        channelId: channel.id,
        channelName: channel.name,
        messageId: event.ts,
        threadId: event.thread_ts ?? event.ts,
        authorId: event.user,
        authorName: event.user,
        text: (event.text ?? "")
          .replaceAll(`<@${connection.serviceUserId}>`, "")
          .replace(/<@([A-Za-z0-9]+)>/g, "@$1")
          .trim(),
        files: (event.files ?? []).map((file) => ({
          name: file.name ?? "attachment",
          mimeType: file.mimetype ?? "application/octet-stream",
          size: file.size ?? 0,
        })),
        receivedAt: new Date().toISOString(),
      }),
    );
    return { status: result._tag === "Success" ? 202 : 503 };
  }).bind(this);

  readonly receiveTelegram = Effect.fn("WorkflowConnectors.receiveTelegram")(function* (
    this: WorkflowConnectors,
    connectionId: string,
    input: WorkflowConnectorWebhook,
  ): Effect.fn.Return<WorkflowConnectorWebhookResult> {
    const connection = this.#options.config.telegram?.find((candidate) => candidate.id === connectionId);
    if (!connection) return { status: 404 };
    if (!this.#running) return { status: 503 };
    if (input.body.byteLength > WEBHOOK_DELIVERY_BODY_BYTES_LIMIT) return { status: 413 };
    if (!equalWebhookSecret(connection.webhookSecret, input.header("x-telegram-bot-api-secret-token")))
      return { status: 401 };
    let update: typeof TelegramUpdate.Type;
    try {
      update = Schema.decodeUnknownSync(TelegramUpdate)(decodeBody(input.body));
    } catch {
      return { status: 400 };
    }
    const message = update.message;
    if (
      !message ||
      String(message.chat.id) !== connection.chatId ||
      !message.from ||
      message.from.is_bot ||
      message.sender_chat ||
      String(message.from.id) === connection.serviceUserId
    )
      return { status: 202 };
    const text = message.text ?? message.caption ?? "";
    const addressed =
      message.chat.type === "private" ||
      String(message.reply_to_message?.from?.id) === connection.serviceUserId ||
      ((message.text === undefined ? message.caption_entities : message.entities) ?? []).some((entity) => {
        if (entity.type === "text_mention") return String(entity.user?.id) === connection.serviceUserId;
        if (entity.offset < 0 || entity.length < 1) return false;
        const value = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
        return (
          (entity.type === "mention" && value === `@${connection.username.toLowerCase()}`) ||
          (entity.type === "bot_command" && value.endsWith(`@${connection.username.toLowerCase()}`))
        );
      });
    if (!addressed) return { status: 202 };
    const workflows = this.#options.workflows();
    if (!workflows) return { status: 503 };
    const result = yield* Effect.result(
      workflows.receiveTelegram({
        connectionId,
        chatId: connection.chatId,
        chatName: message.chat.title ?? connection.name,
        threadKey: message.message_thread_id ? String(message.message_thread_id) : "",
        messageId: String(message.message_id),
        authorId: String(message.from.id),
        authorName:
          [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") ||
          message.from.username ||
          String(message.from.id),
        text: text.replace(new RegExp(`@${connection.username}\\b`, "gi"), "").trim(),
        receivedAt: new Date().toISOString(),
      }),
    );
    return { status: result._tag === "Success" ? 202 : 503 };
  }).bind(this);
}
