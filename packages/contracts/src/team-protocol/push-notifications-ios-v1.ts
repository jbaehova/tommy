// Frozen optional push-notifications-ios-v1 wire contract.
//
// What it grants, recorded here because freezing it makes it permanent: a signed-in member's iPhone
// gives the host its Apple push token when it takes notifications, the Apple environment of the token,
// a secret that only the phone and the host know, and the events the member wants to hear about.
// While the phone says it is away, the host sends a notification for each such event of an agent this
// member can see, from the host to the Apple Push Notification service, as
// `push-notifications-android-v1` does through Firebase Cloud Messaging. The host seals the agent
// name and the text with keys made from the secret, so Apple cannot read them, and the Notification
// Service Extension of the app opens the seal. The host keeps a registration for the session that sent
// it, also after it restarts, and forgets it when the phone removes it, when the member is removed or
// disabled, or when Apple refuses the token. Widening any of it needs a second capability string.
import {
  type AdminDecoder,
  adminRoute,
  boolean,
  count,
  empty,
  fields,
  identifier,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";
import {
  PUSH_NOTIFICATION_SOUNDS,
  type PushNotificationLevel,
  type PushNotificationSound,
} from "./push-notifications-android-v1";

export const IOS_PUSH_NOTIFICATIONS_CAPABILITY = "push-notifications-ios-v1";

export const IOS_PUSH_NOTIFICATIONS_ROUTES = {
  register: "/v1/push-notifications/ios-registration",
  remove: "/v1/push-notifications/ios-registration/remove",
} as const;

/**
 * The APNs environment of the token. iOS takes it from the provisioning profile that signed the app:
 * a build that Xcode signs for development gets sandbox tokens, a TestFlight or App Store build gets
 * production tokens. Apple refuses a token in the other environment.
 */
export type IosPushEnvironment = "production" | "development";

export interface IosPushNotificationRegistration {
  /** The phone's id for this host. The host puts it into the sealed notification for the tap. */
  serverId: string;
  /** The APNs device token of the app, as lowercase hex. */
  token: string;
  environment: IosPushEnvironment;
  /** 32 random bytes as base64url. */
  secret: string;
  /** The interface language of the phone. The host uses English for a language it does not have. */
  locale: string;
  /** `true` while the app is not on screen. Only then does the host send notifications. */
  away: boolean;
  level: PushNotificationLevel;
  /** No notification before this time, in seconds since 1970, or `null`. */
  mutedUntil: number | null;
  /** Whether the notification shows the start of a reply or a question, or only what happened. */
  preview: boolean;
  /**
   * The sound of notifications. "default" is the iOS notification sound, and with "none"
   * notifications are silent.
   */
  sound: PushNotificationSound;
}

/** An APNs device token: 32 bytes today, as hex. The limit leaves room for a longer format. */
export const IOS_PUSH_TOKEN_PATTERN = /^(?:[0-9a-f]{2}){8,256}$/u;

const pattern =
  (expression: RegExp, maximum: number): AdminDecoder =>
  (value) => {
    const text = string(maximum)(value);
    if (typeof text !== "string" || !expression.test(text)) throw new Error("Invalid push notification value.");
    return text;
  };

const pushToken = pattern(IOS_PUSH_TOKEN_PATTERN, 512);
const secret = pattern(/^[A-Za-z0-9_-]{43}$/u, 43);

export const IOS_PUSH_NOTIFICATIONS_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    IOS_PUSH_NOTIFICATIONS_ROUTES.register,
    adminRoute(
      fields({
        serverId: identifier,
        token: pushToken,
        environment: oneOf("production", "development"),
        secret,
        locale: string(35),
        away: boolean,
        level: oneOf("all", "needs-me"),
        mutedUntil: nullable(count),
        preview: boolean,
        sound: oneOf(...PUSH_NOTIFICATION_SOUNDS),
      }),
      empty,
    ),
  ],
  [IOS_PUSH_NOTIFICATIONS_ROUTES.remove, adminRoute(empty, empty)],
]);
