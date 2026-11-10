import { Stack } from "expo-router/stack";
import { useCSSVariable } from "uniwind";
import { sheetBackHaptics } from "@/shared/lib/sheet-back-haptics";
import { useText } from "@/shared/lib/text";
import { appHeaderOptions } from "@/shared/ui/top-bar";

export const unstable_settings = { anchor: "index" };

export default function ServerSettingsLayout() {
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
      <Stack.Screen name="index" options={{ title: t("mobile.server.route.settings") }} />
      {/* The page names its role in the name field. */}
      <Stack.Screen name="audit" options={{ title: t("mobile.server.route.audit") }} />
      <Stack.Screen name="timezone" options={{ title: t("mobile.server.route.timezone") }} />
      <Stack.Screen name="connectors" options={{ title: t("mobile.server.route.connectors") }} />
      {/* The page names its connector. */}
      <Stack.Screen name="connector" options={{ title: t("mobile.server.route.connectors") }} />
      <Stack.Screen name="storage" options={{ title: t("mobile.server.route.storage") }} />
      <Stack.Screen name="storage-files" options={{ title: t("mobile.server.route.storageFiles") }} />
      <Stack.Screen name="library" options={{ title: t("mobile.server.library.title") }} />
      <Stack.Screen name="providers" options={{ title: t("mobile.server.route.providers") }} />
      <Stack.Screen name="provider" options={{ title: t("mobile.server.route.provider") }} />
      {/* The page names its account. */}
      <Stack.Screen name="provider-account" options={{ title: t("mobile.server.route.provider") }} />
      {/* The page names its agent, or says Add custom agent. */}
      {/* The page names its endpoint, or says Add custom provider. */}
      <Stack.Screen name="mcp" options={{ title: t("mobile.server.route.mcp") }} />
      <Stack.Screen name="mcp-server" options={{ title: t("mobile.server.route.mcpServer") }} />
      <Stack.Screen name="crop-logo" options={{ title: t("mobile.server.route.cropLogo") }} />
      <Stack.Screen name="vault" options={{ title: t("mobile.server.route.vault") }} />
      {/* The page names its item. */}
      <Stack.Screen name="vault-item" options={{ title: t("mobile.server.route.vault") }} />
      {/* The page names its source. */}
      <Stack.Screen name="transfer" options={{ title: t("mobile.server.route.transfer") }} />
      <Stack.Screen name="transfer-export" options={{ title: t("mobile.server.route.transferExport") }} />
      <Stack.Screen name="transfer-import" options={{ title: t("mobile.server.route.transferImport") }} />
      <Stack.Screen name="browser-profiles" options={{ title: t("mobile.server.route.browserProfiles") }} />
      {/* The page names its profile. */}
      <Stack.Screen name="browser-profile" options={{ title: t("mobile.server.route.browserProfiles") }} />
      <Stack.Screen name="browser-profile-agents" options={{ title: t("mobile.server.browserProfiles.agentsTitle") }} />
    </Stack>
  );
}
