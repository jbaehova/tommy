import { Stack } from "expo-router/stack";
import { useCSSVariable } from "uniwind";
import { sheetBackHaptics } from "@/shared/lib/sheet-back-haptics";
import { useText } from "@/shared/lib/text";
import { appHeaderOptions } from "@/shared/ui/top-bar";

export const unstable_settings = { anchor: "index" };

export default function ChannelInfoLayout() {
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
      <Stack.Screen name="index" options={{ title: t("mobile.channel.route.info") }} />
      <Stack.Screen name="memories" options={{ title: t("mobile.channel.route.memories") }} />
      <Stack.Screen name="memory" options={{ title: t("mobile.channel.route.memory") }} />
      <Stack.Screen name="routines" options={{ title: t("mobile.channel.route.routines") }} />
      <Stack.Screen name="routine" options={{ title: t("mobile.channel.route.routine") }} />
    </Stack>
  );
}
