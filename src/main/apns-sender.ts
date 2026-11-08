import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type ClientHttp2Session, connect, constants } from "node:http2";
import { type IosNotificationRelayPush, NOTIFICATION_SOUND_FILES } from "@tommy/contracts/notification-relay";
import { Effect, Schema } from "effect";

const PRODUCTION_ORIGIN = "https://api.push.apple.com";
const SANDBOX_ORIGIN = "https://api.sandbox.push.apple.com";
/** Apple refuses a provider token older than one hour, and a new one more often than every 20 minutes. */
const TOKEN_REUSE_SECONDS = 40 * 60;
/** Apple keeps a notification this long for a phone that is off. */
const NOTIFICATION_LIFETIME_SECONDS = 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 5_000;
/** A connection with no request for this long closes. Apple asks to keep it open while sends go out. */
const IDLE_CLOSE_MS = 10 * 60 * 1000;
/** Apple answers these for a token that no longer reaches the app. */
const GONE_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);
/** The only text that Apple gets. The Notification Service Extension replaces it with the sealed text. */
const NOTIFICATION_TITLE = "Tommy";

/**
 * The APNs key of the app owner: the `.p8` key from the Apple Developer account, its key ID, the
 * team ID, and the bundle ID of the app (the APNs topic).
 */
const ApnsKey = Schema.Struct({
  keyId: Schema.String,
  teamId: Schema.String,
  topic: Schema.String,
  privateKey: Schema.String,
});
type ApnsKey = typeof ApnsKey.Type;

const ApnsErrorBody = Schema.Struct({ reason: Schema.String });

/** The text is fixed: a cause can hold the key, the token or the phone's token. */
class ApnsSendError extends Schema.TaggedError<ApnsSendError>()("ApnsSendError", { message: Schema.String }) {}

const failure = (message: string) => () => new ApnsSendError({ message });

/** One answer of Apple: the HTTP status and the body text. */
interface ApnsResponse {
  status: number;
  body: string;
}

/** Sends one request to an APNs origin. Tests give their own. */
export type ApnsRequest = (
  origin: string,
  path: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
) => Promise<ApnsResponse>;

/**
 * Sends a sealed iPhone notification from this server to the Apple Push Notification service. The
 * server sealed the content with keys that only the phone has, so Apple sees the app name only. The
 * Notification Service Extension of the app opens the seal before iOS shows the notification
 * (`NotificationService.swift`).
 */
export class ApnsSender {
  readonly #key: ApnsKey;
  readonly #signingKey: KeyObject;
  readonly #request: ApnsRequest;
  readonly #now: () => number;
  #token: { value: string; issuedAt: number } | null = null;

  constructor(key: ApnsKey, request: ApnsRequest = http2Request(), now: () => number = Date.now) {
    this.#key = key;
    this.#signingKey = createPrivateKey(key.privateKey);
    this.#request = request;
    this.#now = now;
  }

  /** Null when the server has no key. Then an iPhone gets no notifications. */
  static async load(path: string, request?: ApnsRequest): Promise<ApnsSender | null> {
    try {
      return new ApnsSender(Schema.decodeUnknownSync(ApnsKey)(JSON.parse(await readFile(path, "utf8"))), request);
    } catch {
      return null;
    }
  }

  /** `gone` means that the token no longer reaches the app. */
  readonly send = Effect.fn("ApnsSender.send")(function* (this: ApnsSender, push: IosNotificationRelayPush) {
    const token = yield* Effect.try({
      try: () => this.#providerToken(),
      catch: failure("The APNs key is not valid."),
    });
    const origin = push.environment === "development" ? SANDBOX_ORIGIN : PRODUCTION_ORIGIN;
    const sound =
      push.sound === null ? {} : { sound: push.sound === "default" ? "default" : NOTIFICATION_SOUND_FILES[push.sound] };
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        this.#request(
          origin,
          `/3/device/${push.token}`,
          {
            authorization: `bearer ${token}`,
            "apns-push-type": "alert",
            "apns-topic": this.#key.topic,
            "apns-priority": "10",
            "apns-expiration": String(push.timestamp + NOTIFICATION_LIFETIME_SECONDS),
            "content-type": "application/json",
          },
          // The extension replaces the title and adds the text when it opens `sealed`.
          JSON.stringify({
            aps: { alert: { title: NOTIFICATION_TITLE }, "mutable-content": 1, ...sound },
            sealed: push.sealed,
          }),
          AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        ),
      catch: failure("Apple cannot be reached."),
    });
    if (response.status === 200) return "sent" as const;
    if (response.status === 410) return "gone" as const;
    const reason = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(ApnsErrorBody)(JSON.parse(response.body)).reason,
      catch: failure("Apple sent an unknown answer."),
    }).pipe(Effect.orElseSucceed(() => ""));
    // Apple refused the provider token, as after a key change. The next send makes a new one.
    if (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") this.#token = null;
    if (GONE_REASONS.has(reason)) return "gone" as const;
    return yield* new ApnsSendError({ message: `Apple refused the notification: ${response.status} ${reason}` });
  }).bind(this);

  #providerToken(): string {
    const now = Math.floor(this.#now() / 1_000);
    if (this.#token && now - this.#token.issuedAt < TOKEN_REUSE_SECONDS) return this.#token.value;
    const header = base64Url(JSON.stringify({ alg: "ES256", kid: this.#key.keyId }));
    const claims = base64Url(JSON.stringify({ iss: this.#key.teamId, iat: now }));
    const signature = createSign("SHA256")
      .update(`${header}.${claims}`)
      .sign({ key: this.#signingKey, dsaEncoding: "ieee-p1363" });
    const value = `${header}.${claims}.${base64Url(signature)}`;
    this.#token = { value, issuedAt: now };
    return value;
  }
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * APNs takes HTTP/2 only, and `fetch` of Node uses HTTP/1.1. One connection per origin stays open
 * while notifications go out, and closes after a quiet time.
 */
function http2Request(): ApnsRequest {
  const sessions = new Map<string, ClientHttp2Session>();
  const session = (origin: string): ClientHttp2Session => {
    const open = sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const created = connect(origin);
    created.setTimeout(IDLE_CLOSE_MS, () => created.close());
    created.on("error", () => created.destroy());
    created.on("close", () => {
      if (sessions.get(origin) === created) sessions.delete(origin);
    });
    // An open connection must not keep the process running at quit.
    created.unref();
    sessions.set(origin, created);
    return created;
  };
  return (origin, path, headers, body, signal) =>
    new Promise((resolve, reject) => {
      const stream = session(origin).request(
        { [constants.HTTP2_HEADER_METHOD]: "POST", [constants.HTTP2_HEADER_PATH]: path, ...headers },
        { signal },
      );
      let status = 0;
      let text = "";
      stream.setEncoding("utf8");
      stream.on("response", (responseHeaders) => {
        status = Number(responseHeaders[constants.HTTP2_HEADER_STATUS]);
      });
      stream.on("data", (chunk: string) => {
        text += chunk;
      });
      stream.on("end", () => resolve({ status, body: text }));
      stream.on("error", reject);
      stream.end(body);
    });
}
