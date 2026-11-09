import Constants, { ExecutionEnvironment } from "expo-constants";
import * as LocalAuthentication from "expo-local-authentication";

/** `cancel`: the user closed the prompt. `unavailable`: the phone has no passcode or biometrics. */
export type DeviceUnlockResult = "success" | "cancel" | "unavailable" | "failed";

/** The name of the unlock that the phone offers: Face ID, Touch ID, or the Android unlock. */
export type DeviceUnlockKind = "phone";

export async function deviceUnlockKind(): Promise<"phone" | null> {
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (level === LocalAuthentication.SecurityLevel.NONE) return null;
    return "phone";
  } catch {
    return null;
  }
}

/** The phone's biometrics, with the phone's passcode as the fallback that the system offers. */
export async function authenticateWithDevice(promptMessage: string, cancelLabel: string): Promise<DeviceUnlockResult> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      cancelLabel,
      disableDeviceFallback: false,
      // Class 2 face unlock on Android uses the camera only, and a photo can pass it.
      biometricsSecurityLevel: "strong",
    });
    if (result.success) return "success";
    switch (result.error) {
      case "user_cancel":
      case "app_cancel":
      case "system_cancel":
        return "cancel";
      case "not_enrolled":
      case "not_available":
      case "passcode_not_set":
        return "unavailable";
      default:
        return "failed";
    }
  } catch {
    return "failed";
  }
}
