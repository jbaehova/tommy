import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AndroidNotificationRelayPush } from "@tommy/contracts/notification-relay";
import { Effect, Schema } from "effect";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MESSAGING_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/** Google gives an access token for one hour. A new one is made 5 minutes before it ends. */
const ASSERTION_LIFETIME_SECONDS = 60 * 60;
const TOKEN_MARGIN_SECONDS = 5 * 60;
/** Firebase keeps a notification this long for a phone that is off. */
const NOTIFICATION_LIFETIME = "86400s";
const REQUEST_TIMEOUT_MS = 5_000;
/** Firebase answers these for a token that no longer reaches the app. */
const GONE_ERRORS = new Set(["UNREGISTERED", "SENDER_ID_MISMATCH"]);

const ServiceAccount = Schema.Struct({
  project_id: Schema.String,
  client_email: Schema.String,
  private_key: Schema.String,
  private_key_id: Schema.String,
});
type ServiceAccount = typeof ServiceAccount.Type;

const AccessToken = Schema.Struct({ access_token: Schema.String, expires_in: Schema.Number });
const FcmErrorBody = Schema.Struct({
  error: Schema.Struct({
    details: Schema.optional(Schema.Array(Schema.Struct({ errorCode: Schema.optional(Schema.String) }))),
  }),
});

/** The text is fixed: a cause can hold the key, the token or the phone's token. */
class FcmSendError extends Schema.TaggedError<FcmSendError>()("FcmSendError", { message: Schema.String }) {}

const failure = (message: string) => () => new FcmSendError({ message });

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Sends a sealed Android notification from this server to Firebase Cloud Messaging. The server sealed
 * the content with keys that only the phone has, so Firebase cannot read it. It is a data message, so
 * that Android gives it to the app also when the app does not run (`TommyMessagingService.kt`).
 */
export class FcmSender {
  readonly #account: ServiceAccount;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  #token: { value: string; expiresAt: number } | null = null;

  constructor(account: ServiceAccount, fetchFn: Fetch = fetch, now: () => number = Date.now) {
    this.#account = account;
    this.#fetch = fetchFn;
    this.#now = now;
  }

  /** Null when the server has no key. Then an Android phone gets no notifications. */
  static async load(path: string, fetchFn?: Fetch): Promise<FcmSender | null> {
    try {
      return new FcmSender(Schema.decodeUnknownSync(ServiceAccount)(JSON.parse(await readFile(path, "utf8"))), fetchFn);
    } catch {
      return null;
    }
  }

  /** `gone` means that the token no longer reaches the app. */
  readonly send = Effect.fn("FcmSender.send")(function* (this: FcmSender, push: AndroidNotificationRelayPush) {
    const token = yield* this.#accessToken();
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        this.#fetch(
          `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.#account.project_id)}/messages:send`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({
              message: {
                token: push.token,
                data: { sealed: push.sealed, ...(push.sound === null ? {} : { sound: push.sound }) },
                android: { priority: "HIGH", ttl: NOTIFICATION_LIFETIME },
              },
            }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          },
        ),
      catch: failure("Firebase cannot be reached."),
    });
    if (response.ok) return "sent" as const;
    // Google refused the access token, as after a key change. The next send makes a new one.
    if (response.status === 401) this.#token = null;
    const errors = yield* Effect.tryPromise({
      try: async () => Schema.decodeUnknownSync(FcmErrorBody)(await response.json()),
      catch: failure("Firebase sent an unknown answer."),
    }).pipe(
      Effect.map((body) =>
        (body.error.details ?? []).flatMap((detail) => (detail.errorCode ? [detail.errorCode] : [])),
      ),
      Effect.orElseSucceed((): readonly string[] => []),
    );
    if (response.status === 404 || errors.some((error) => GONE_ERRORS.has(error))) return "gone" as const;
    return yield* new FcmSendError({ message: `Firebase refused the notification: ${response.status}` });
  }).bind(this);

  readonly #accessToken = Effect.fn("FcmSender.accessToken")(function* (this: FcmSender) {
    const now = Math.floor(this.#now() / 1_000);
    if (this.#token && now < this.#token.expiresAt - TOKEN_MARGIN_SECONDS) return this.#token.value;
    const assertion = yield* Effect.try({
      try: () => this.#assertion(now),
      catch: failure("The Firebase key is not valid."),
    });
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        this.#fetch(TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
          }).toString(),
          signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        }),
      catch: failure("Google sign-in cannot be reached."),
    });
    if (!response.ok)
      return yield* new FcmSendError({ message: `Google refused the Firebase key: ${response.status}` });
    const value = yield* Effect.tryPromise({
      try: async () => Schema.decodeUnknownSync(AccessToken)(await response.json()),
      catch: failure("Google sent an unknown answer."),
    });
    this.#token = { value: value.access_token, expiresAt: now + Math.floor(value.expires_in) };
    return value.access_token;
  });

  #assertion(now: number): string {
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: this.#account.private_key_id }));
    const claims = base64Url(
      JSON.stringify({
        iss: this.#account.client_email,
        scope: MESSAGING_SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + ASSERTION_LIFETIME_SECONDS,
      }),
    );
    const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(this.#account.private_key);
    return `${header}.${claims}.${base64Url(signature)}`;
  }
}
