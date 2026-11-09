/** The sounds of the app bundle (`NOTIFICATION_SOUND_FILES`), and `default` for the system sound. */
export const NOTIFICATION_SOUNDS = ["tommy", "warm", "mech", "bubble", "press", "default"] as const;
export type NotificationSound = (typeof NOTIFICATION_SOUNDS)[number];

/**
 * One Android notification that a host sends through Firebase Cloud Messaging. It is a data message
 * with the sealed bytes and the sound only, and the app opens the seal before Android shows the
 * notification. Google sees no text.
 */
export interface AndroidNotificationRelayPush {
  /**
   * The Firebase Cloud Messaging registration token of the app (`ANDROID_PUSH_TOKEN_PATTERN` of
   * `push-notifications-android-v1`).
   */
  token: string;
  /** The session of the phone on this host. */
  sessionId: string;
  /** The sealed notification, base64url. */
  sealed: string;
  /** The sound that the app plays, or `null` for none. */
  sound: NotificationSound | null;
  /** When the host made the notification, in seconds. */
  timestamp: number;
}

/**
 * A sealed notification above this size would not fit the 4 KB Apple payload with its envelope.
 * Firebase Cloud Messaging data messages have the same 4 KB limit.
 */
export const NOTIFICATION_SEALED_LIMIT = 3_600;
/**
 * The sound files in the app bundle, at the level of an alert. `tommy` is the sound of the desktop
 * app when a task finishes (`completion-sound.ts`), with the same sweep and envelope. The others are
 * the `success` cue of each desktop sound theme (`cuelume`; `warm` is its `default` theme), rendered
 * offline.
 */
export const NOTIFICATION_SOUND_FILES: Readonly<Record<Exclude<NotificationSound, "default">, string>> = {
  tommy: "tommy-task.wav",
  warm: "tommy-warm.wav",
  mech: "tommy-mech.wav",
  bubble: "tommy-bubble.wav",
  press: "tommy-press.wav",
};
