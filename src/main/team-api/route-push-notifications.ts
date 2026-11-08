import {
  ANDROID_PUSH_NOTIFICATIONS_CAPABILITY,
  ANDROID_PUSH_NOTIFICATIONS_ROUTES,
} from "@tommy/contracts/team-protocol/push-notifications-android-v1";
import {
  IOS_PUSH_NOTIFICATIONS_CAPABILITY,
  IOS_PUSH_NOTIFICATIONS_ROUTES,
} from "@tommy/contracts/team-protocol/push-notifications-ios-v1";
import { sourceText } from "@tommy/i18n/source";
import { type PushTarget, readAndroidPushRegistration, readIosPushRegistration } from "../push-notification-store";
import type { PushNotificationService } from "../push-notifications";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson } from "./request-helpers";

const PLATFORMS = [
  {
    platform: "android",
    capability: ANDROID_PUSH_NOTIFICATIONS_CAPABILITY,
    routes: ANDROID_PUSH_NOTIFICATIONS_ROUTES,
    read: (body: unknown): PushTarget | null => {
      const value = readAndroidPushRegistration(body);
      return value ? { platform: "android", value } : null;
    },
  },
  {
    platform: "ios",
    capability: IOS_PUSH_NOTIFICATIONS_CAPABILITY,
    routes: IOS_PUSH_NOTIFICATIONS_ROUTES,
    read: (body: unknown): PushTarget | null => {
      const value = readIosPushRegistration(body);
      return value ? { platform: "ios", value } : null;
    },
  },
] as const;

/**
 * The phone of the calling member gives or removes its push token and the events it wants. The host
 * sends notifications only for what this member can see. Frozen by `push-notifications-android-v1`
 * for Android and `push-notifications-ios-v1` for iPhone.
 */
export async function routePushNotifications(
  context: TeamApiRequestContext,
  notifications: PushNotificationService | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json, member, sessionId, protocol } = context;
  if (method !== "POST") return "unmatched";
  const entry = PLATFORMS.find(({ routes }) => url.pathname === routes.register || url.pathname === routes.remove);
  if (!entry) return "unmatched";
  if (!notifications?.sends(entry.platform) || !capabilities.has(entry.capability)) {
    throw new HttpError(400, sourceText("error.team.pushNotificationsUnsupported"));
  }
  // `readJson` has already run the body through the push-notifications wire codec.
  const body = await readJson(request);
  if (url.pathname === entry.routes.remove) {
    notifications.remove(sessionId);
    return json(200, {});
  }
  const target = entry.read(body);
  if (!target) throw new HttpError(400, sourceText("error.team.pushNotificationsUnsupported"));
  notifications.register(sessionId, { memberId: member.id, protocol, capabilities }, target);
  return json(200, {});
}
