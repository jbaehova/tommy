import { Stack } from "expo-router/stack";
import { useCSSVariable } from "uniwind";
import { sheetBackHaptics } from "@/shared/lib/sheet-back-haptics";
import { useText } from "@/shared/lib/text";
import { appHeaderOptions } from "@/shared/ui/top-bar";

export const unstable_settings = { anchor: "index" };

export default function QueuedMessagesLayout() {
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
      <Stack.Screen name="index" options={{ title: t("mobile.app.route.queuedMessages") }} />
      <Stack.Screen name="actions" options={{ title: t("mobile.app.route.messageOptions") }} />
      <Stack.Screen name="edit" options={{ title: t("mobile.app.route.editMessage") }} />
    </Stack>
  );
}
