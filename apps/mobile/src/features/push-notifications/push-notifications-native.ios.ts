import { NOTIFICATION_SOUND_FILES } from "@tommy/contracts/notification-relay";
import { IOS_PUSH_TOKEN_PATTERN } from "@tommy/contracts/team-protocol/push-notifications-ios-v1";
import { File } from "expo-file-system";
import * as Notifications from "expo-notifications";
import type { NotificationPermission } from "@/features/settings/model/push-notifications";
import { appGroupDirectory } from "@/shared/lib/app-group";
import { type PushNotificationsNative, SOUND_PREVIEW_KEY } from "./push-notifications-native.types";

/** `NotificationService.swift` reads this file in the App Group. */
const KEYS_FILE = "push-notifications.json";

/**
 * The Notification Service Extension cannot read the app keychain, so the app writes the keys of
 * each server into the App Group, which only the app and its extensions can read. The keys open
 * notifications only, and a new phone secret after sign-out makes them useless.
 */
export const pushNotificationsNative: PushNotificationsNative | null = {
  async permission(asked) {
    const current = await Notifications.getPermissionsAsync();
    if (current.ios?.status !== Notifications.IosAuthorizationStatus.NOT_DETERMINED) return permissionOf(current);
    const answer = permissionOf(
      await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true } }),
    );
    asked?.(answer);
    return answer;
  },
  async deviceToken() {
    return hexToken((await Notifications.getDevicePushTokenAsync()).data);
  },
  onDeviceToken(listener) {
    const subscription = Notifications.addPushTokenListener((device) => listener(hexToken(device.data)));
    return () => subscription.remove();
  },
  writeKeys(servers) {
    const directory = appGroupDirectory();
    // The App Group is missing in a build without the extension, such as Expo Go.
    if (!directory) return;
    const text = JSON.stringify({ version: 1, servers });
    const file = new File(directory, KEYS_FILE);
    if (file.exists && file.textSync() === text) return;
    file.writeSync(text);
  },
  removeKeys() {
    const directory = appGroupDirectory();
    if (!directory) return;
    const file = new File(directory, KEYS_FILE);
    if (file.exists) file.delete();
  },
  async previewSound(sound) {
    // A local notification goes through the same iOS sound path as a real one. The handler shows nothing.
    await Notifications.scheduleNotificationAsync({
      content: {
        sound: sound === "default" ? "default" : NOTIFICATION_SOUND_FILES[sound],
        data: { [SOUND_PREVIEW_KEY]: true },
      },
      trigger: null,
    });
  },
};

function permissionOf(status: Notifications.NotificationPermissionsStatus): NotificationPermission {
  switch (status.ios?.status) {
    case Notifications.IosAuthorizationStatus.AUTHORIZED:
    case Notifications.IosAuthorizationStatus.PROVISIONAL:
    case Notifications.IosAuthorizationStatus.EPHEMERAL:
      return "granted";
    case Notifications.IosAuthorizationStatus.NOT_DETERMINED:
      return "undetermined";
    default:
      return "denied";
  }
}

/** The APNs token as lowercase hex, or `null` when iOS gave something else. */
function hexToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.toLowerCase();
  return IOS_PUSH_TOKEN_PATTERN.test(token) ? token : null;
}
