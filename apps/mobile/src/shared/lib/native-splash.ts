import { isRunningInExpoGo } from "expo";
import * as SplashScreen from "expo-splash-screen";

// The native splash is the empty canvas of the app. It stays until the first screen can draw, so no
// frame shows an empty app, and fades out quickly. Claim it at module scope: expo-router delays its
// own claim by a tick so an app-level call wins.
void SplashScreen.preventAutoHideAsync().catch(() => undefined);
if (!isRunningInExpoGo()) SplashScreen.setOptions({ fade: true, duration: 160 });

export const nativeSplash = {
  hide: () => SplashScreen.hide(),
};
