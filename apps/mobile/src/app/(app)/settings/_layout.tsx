import { Stack } from "expo-router/stack";
import { useCSSVariable } from "uniwind";
import { sheetBackHaptics } from "@/shared/lib/sheet-back-haptics";
import { useText } from "@/shared/lib/text";
import { appHeaderOptions } from "@/shared/ui/top-bar";

export const unstable_settings = { anchor: "index" };

export default function SettingsLayout() {
  const { t } = useText();
  const background = String(useCSSVariable("--tommy-bg-sheet"));
  return (
    <Stack
      screenListeners={sheetBackHaptics}
      screenOptions={{
        presentation: "card",
        headerBackButtonDisplayMode: "minimal",
        ...appHeaderOptions,
        headerShadowVisible: false,
        headerTransparent: false,
        headerStyle: { backgroundColor: background },
        headerBlurEffect: "none",
        scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        contentStyle: { backgroundColor: background },
      }}
    >
      <Stack.Screen name="index" options={{ title: t("mobile.app.route.settings") }} />
      <Stack.Screen name="profile" options={{ title: t("mobile.app.route.profile") }} />
      <Stack.Screen name="appearance" options={{ title: t("mobile.settings.appearance.title") }} />
      <Stack.Screen name="animations" options={{ title: t("mobile.settings.animations.title") }} />
      <Stack.Screen name="language" options={{ title: t("mobile.settings.language.title") }} />
      <Stack.Screen name="voice" options={{ title: t("mobile.settings.voice.title") }} />
      <Stack.Screen name="voice-choice" options={{ title: t("mobile.settings.voice.voice") }} />
      <Stack.Screen name="assistant" options={{ title: t("mobile.settings.assistant.title") }} />
      <Stack.Screen name="haptics" options={{ title: t("mobile.settings.feedback.haptics") }} />
      <Stack.Screen name="notifications" options={{ title: t("mobile.settings.notifications.title") }} />
      <Stack.Screen name="app-lock" options={{ title: t("mobile.appLock.title") }} />
      <Stack.Screen name="app-lock-pin" options={{ title: t("mobile.appLock.pinSetup.title") }} />
      <Stack.Screen name="sessions" options={{ title: t("mobile.app.route.accountSessions") }} />
      <Stack.Screen name="about" options={{ title: t("mobile.app.route.about") }} />
      <Stack.Screen name="support" options={{ title: t("mobile.app.route.support") }} />
      <Stack.Screen name="hidden-chats" options={{ title: t("mobile.app.route.hiddenChats") }} />
      <Stack.Screen name="crop-photo" options={{ title: t("mobile.app.route.cropPhoto") }} />
    </Stack>
  );
}
