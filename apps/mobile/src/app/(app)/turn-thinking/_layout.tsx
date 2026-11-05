import { Stack } from "expo-router/stack";
import { useCSSVariable } from "uniwind";
import { useText } from "@/shared/lib/text";
import { appHeaderOptions } from "@/shared/ui/top-bar";

export default function TurnThinkingLayout() {
  const { t } = useText();
  const background = String(useCSSVariable("--tommy-bg-sheet"));
  return (
    <Stack
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
      <Stack.Screen name="index" options={{ title: t("mobile.app.route.thinking") }} />
    </Stack>
  );
}
