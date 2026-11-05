import type { ServerNotificationLevel, ServerSummary } from "@tommy/contracts/ipc";
import type { AppFormat, AppTextKey, AppTranslate } from "@tommy/i18n";

// No duration mutes until the user unmutes.
export const SERVER_MUTE_CHOICES: readonly { label: AppTextKey; durationMs?: number }[] = [
  { label: "server.mute.for15Minutes", durationMs: 15 * 60_000 },
  { label: "server.mute.for1Hour", durationMs: 60 * 60_000 },
  { label: "server.mute.for3Hours", durationMs: 3 * 60 * 60_000 },
  { label: "server.mute.for8Hours", durationMs: 8 * 60 * 60_000 },
  { label: "server.mute.for24Hours", durationMs: 24 * 60 * 60_000 },
  { label: "server.mute.untilTurnedOn" },
];

export const SERVER_NOTIFICATION_LEVEL_LABELS = {
  all: "server.notificationLevel.all",
  "needs-me": "server.notificationLevel.needsMe",
  nothing: "server.notificationLevel.nothing",
} as const satisfies Record<ServerNotificationLevel, AppTextKey>;

/** "Muted until 14:30", with the weekday when the mute ends on another day. */
export function serverMuteDescription(
  server: Pick<ServerSummary, "notificationsMutedUntil">,
  t: AppTranslate,
  format: AppFormat,
  now = new Date(),
): string {
  if (server.notificationsMutedUntil === null) return t("server.mute.muted");
  const until = new Date(server.notificationsMutedUntil);
  const sameDay = until.toDateString() === now.toDateString();
  const time = format.date(until, {
    hour: "numeric",
    minute: "2-digit",
    ...(sameDay ? {} : { weekday: "short" }),
  });
  return t("server.mute.mutedUntil", { time });
}
