import { Stack } from "expo-router/stack";
import { useEffect } from "react";
import { useCSSVariable } from "uniwind";
import { useWorkflowDraft } from "@/features/workflows/model/workflow-draft";
import { sheetBackHaptics } from "@/shared/lib/sheet-back-haptics";
import { useText } from "@/shared/lib/text";
import { appHeaderOptions } from "@/shared/ui/top-bar";

export const unstable_settings = { anchor: "index" };

/** The editor sheet: one sheet with the pages of the editor, which share one draft. */
export default function WorkflowEditorLayout() {
  const { t } = useText();
  const background = String(useCSSVariable("--tommy-bg-sheet"));
  // The draft lives while the sheet is open, so a closed sheet does not open on an old draft.
  useEffect(() => () => useWorkflowDraft.getState().clear(), []);
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
      <Stack.Screen name="index" options={{ title: t("mobile.workflow.editor.title") }} />
      <Stack.Screen name="step" options={{ title: t("mobile.workflow.editor.step") }} />
      <Stack.Screen name="add" options={{ title: t("mobile.workflow.add.title") }} />
      <Stack.Screen name="trigger" options={{ title: t("mobile.workflow.detail.trigger") }} />
      {/* The page names the list that it shows. */}
      <Stack.Screen name="github-pick" options={{ title: t("mobile.workflow.github.repository") }} />
    </Stack>
  );
}
