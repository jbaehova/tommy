import Constants from "expo-constants";
import { type Directory, Paths } from "expo-file-system";
import { isIOS } from "@/shared/lib/platform";

const configured = Constants.expoConfig?.extra?.iosAppGroup;

/** The App Group of the iPhone app and its extensions, as `app.config.js` names it. `null` on Android. */
export const IOS_APP_GROUP = isIOS && typeof configured === "string" ? configured : null;

/**
 * The folder that the app shares with its extensions, such as the Notification Service Extension.
 * `null` on Android, and in a build without the App Group, such as Expo Go.
 */
export function appGroupDirectory(): Directory | null {
  if (!IOS_APP_GROUP) return null;
  try {
    return Paths.appleSharedContainers[IOS_APP_GROUP] ?? null;
  } catch {
    return null;
  }
}
