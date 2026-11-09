import {
  ANDROID_PUSH_NOTIFICATIONS_CAPABILITY,
  ANDROID_PUSH_NOTIFICATIONS_ROUTES,
} from "@tommy/contracts/team-protocol/push-notifications-android-v1";
import { sourceText } from "@tommy/i18n/source";
import { readAndroidPushRegistration } from "../push-notification-store";
import type { PushNotificationService } from "../push-notifications";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson } from "./request-helpers";

/**
 * The phone of the calling member gives or removes its push token and the events it wants. The host
 * sends notifications only for what this member can see. Frozen by `push-notifications-android-v1`.
 */
export async function routePushNotifications(
  context: TeamApiRequestContext,
  notifications: PushNotificationService | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json, member, sessionId, protocol } = context;
  const { register, remove } = ANDROID_PUSH_NOTIFICATIONS_ROUTES;
  if (method !== "POST" || (url.pathname !== register && url.pathname !== remove)) return "unmatched";
  if (!notifications || !capabilities.has(ANDROID_PUSH_NOTIFICATIONS_CAPABILITY)) {
    throw new HttpError(400, sourceText("error.team.pushNotificationsUnsupported"));
  }
  // `readJson` has already run the body through the push-notifications wire codec.
  const body = await readJson(request);
  if (url.pathname === remove) {
    notifications.remove(sessionId);
    return json(200, {});
  }
  const value = readAndroidPushRegistration(body);
  if (!value) throw new HttpError(400, sourceText("error.team.pushNotificationsUnsupported"));
  notifications.register(sessionId, { memberId: member.id, protocol, capabilities }, { platform: "android", value });
  return json(200, {});
}
