import { router, useGlobalSearchParams, useSegments } from "expo-router";
import { Stack } from "expo-router/stack";
import { useThemeColor } from "heroui-native/hooks";
import { type PropsWithChildren, useCallback, useEffect, useRef } from "react";
import { TextInput } from "react-native";
import { useCSSVariable } from "uniwind";
import { AgentPinTransitionProvider } from "@/features/agents/components/agent-pin-transition";
import { ChatListPaneProvider } from "@/features/agents/components/chat-list-pane-context";
import { ConnectedScreen } from "@/features/agents/screens/connected-screen";
import { whenUnlocked } from "@/features/app-lock/model/app-lock";
import { sessionWorkspaceKey, useMobileSession } from "@/features/auth/context/mobile-session-context";
import { AudioWaveformHost } from "@/features/chat/components/audio-waveform-host";
import { MermaidRendererHost } from "@/features/chat/components/mermaid-renderer-host";
import { OutboxProvider } from "@/features/chat/context/outbox-context";
import { QueuedMessagesProvider } from "@/features/chat/context/queued-messages-context";
import { HomeOnboardingProvider, useHomeOnboarding } from "@/features/onboarding/context/home-onboarding-context";
import type { NotificationTarget } from "@/features/push-notifications/push-notifications-native.types";
import { useNotificationTaps } from "@/features/push-notifications/use-notification-taps";
import type { QuickActionTarget } from "@/features/quick-actions/model/quick-action-items";
import { setQuickActionNavigator } from "@/features/quick-actions/quick-actions-native";
import { requestHomeSearch } from "@/features/search/model/home-search-request";
import { setShareSheetOpener } from "@/features/share/model/share-sheet-opener";
import {
  MobileWorkspaceProvider,
  useMobileWorkspaceReader,
} from "@/features/workspace/context/mobile-workspace-context";
import { AdaptiveSplit, useSplitLayout } from "@/shared/components/adaptive-split";
import { useReducedMotion } from "@/shared/lib/motion";
import { useText } from "@/shared/lib/text";
import { Dock } from "@/shared/ui/dock";
import { appHeaderOptions } from "@/shared/ui/top-bar";

/** How long a notification tap waits for the channel list of its server before it opens the agent chat. */
const NOTIFICATION_CHANNEL_WAIT_MS = 8_000;

/**
 * Android: autoFocus focuses the name field of a form sheet while the sheet opens, and Android does
 * not show the keyboard then. Focusing the field again after the opening shows it.
 */
const refocusNameField = {
  transitionEnd: (event: { data: { closing: boolean } }) => {
    if (event.data.closing) return;
    const input = TextInput.State.currentlyFocusedInput();
    if (!input) return;
    input.blur();
    input.focus();
  },
};

export const unstable_settings = {
  anchor: "connected",
};

function AuthenticatedStack() {
  const segments = useSegments();
  // Reduced motion, from the device or from Settings, replaces the full-screen slide with a cross-fade.
  const pushAnimation = useReducedMotion() ? "fade" : "ios_from_right";
  // Beside the chat list pane, a chat takes the place of the chat before it, so it fades in place.
  const chatAnimation = useSplitLayout() ? "fade" : pushAnimation;
  const { t } = useText();
  const background = useThemeColor("background");
  const sheetBackground = String(useCSSVariable("--tommy-bg-sheet") ?? background);
  // iOS shows the native bar over a chat and the browser, so its bar items morph with the items of the
  // screen under it. The screen fills the bar with Back, the title and the buttons. Android draws them.
  const nativeBarOptions = {
    headerShown: false,
    headerBackVisible: false,
    scrollEdgeEffects: { top: "hidden" },
    title: "",
  } as const;
  const largeTitlePage = {
    animation: pushAnimation,
    contentStyle: { backgroundColor: sheetBackground },
    headerTransparent: true,
    scrollEdgeEffects: { top: "hidden", bottom: "soft" },
    title: "",
  } as const;
  const { agentId: openAgentId } = useGlobalSearchParams<{ agentId?: string }>();
  const openChat = useRef<string | null>(null);
  openChat.current = segments.at(-2) === "chat" && typeof openAgentId === "string" ? openAgentId : null;
  /** Opens a chat, or the chat list for `null`, from a Live Activity or a notification. */
  const openFromOutside = useCallback(
    (agentId: string | null) =>
      // A locked app opens the chat after the user unlocks it.
      whenUnlocked(() => {
        // Opening the chat that shows already would mount it again and load it again.
        if (agentId !== null && openChat.current === agentId) return;
        // The chat opens on top of the main screen, so Back returns there and not to an earlier chat.
        if (router.canDismiss()) router.dismissAll();
        if (agentId === null) return;
        requestAnimationFrame(() => router.push({ pathname: "/chat/[agentId]", params: { agentId } }));
      }),
    [],
  );
  /** Opens the screen of a quick action of the app icon, on top of the main screen. */
  const openQuickAction = useCallback(
    (target: QuickActionTarget) => {
      if (target.type === "chat") {
        openFromOutside(target.agentId);
        return;
      }
      whenUnlocked(() => {
        if (router.canDismiss()) router.dismissAll();
        requestAnimationFrame(() =>
          target.type === "routines"
            ? router.push({ pathname: "/server-routines", params: { serverId: target.serverId } })
            : requestHomeSearch(),
        );
      });
    },
    [openFromOutside],
  );
  useEffect(() => setQuickActionNavigator(openQuickAction), [openQuickAction]);
  useEffect(() => setShareSheetOpener(() => whenUnlocked(() => router.push("/share"))), []);
  const workspace = useMobileWorkspaceReader();
  /**
   * A prompt, an approval or a takeover on a channel thread opens the channel, as on desktop. A tap
   * at a cold start comes before the server connects, so it waits a short time for the channel list.
   */
  const openFromNotification = useCallback(
    ({ agentId, serverId, threadId }: NotificationTarget) => {
      if (!serverId || !threadId) {
        openFromOutside(agentId);
        return;
      }
      void workspace()
        .channelStore.whenListed(serverId, NOTIFICATION_CHANNEL_WAIT_MS)
        .then((state) => {
          const channel = state.channels.find(
            (item) => !item.archived && item.threads?.some((thread) => thread.threadId === threadId),
          );
          if (!channel) {
            openFromOutside(agentId);
            return;
          }
          whenUnlocked(() => {
            if (router.canDismiss()) router.dismissAll();
            requestAnimationFrame(() =>
              router.push({ pathname: "/channel/[channelId]", params: { channelId: channel.id, serverId } }),
            );
          });
        });
    },
    [workspace, openFromOutside],
  );
  useNotificationTaps(openFromNotification, () => openChat.current);

  return (
    <Stack
      screenOptions={{
        // The full screens put the back arrow in the glass circle, as the home buttons are.
        headerBackButtonDisplayMode: "minimal",
        ...appHeaderOptions,
        headerShadowVisible: false,
        headerTransparent: false,
      }}
    >
      <Stack.Screen name="connected" options={{ animation: "fade", gestureEnabled: false, title: "" }} />
      <Stack.Screen
        name="chat/[agentId]"
        options={{
          animation: chatAnimation,
          contentStyle: { backgroundColor: background },
          // A swipe to the right anywhere in the chat goes back. A message bubble keeps its swipe to
          // reply: react-native-screens is patched so that the back swipe waits for it.
          fullScreenGestureEnabled: true,
          gestureEnabled: true,
          ...nativeBarOptions,
        }}
      />
      <Stack.Screen
        name="task/[taskId]"
        // A task is a chat of its own, so it opens as the agent's chat does.
        options={{
          animation: chatAnimation,
          contentStyle: { backgroundColor: background },
          // A swipe to the right anywhere in the chat goes back. A message bubble keeps its swipe to
          // reply: react-native-screens is patched so that the back swipe waits for it.
          fullScreenGestureEnabled: true,
          gestureEnabled: true,
          ...nativeBarOptions,
        }}
      />
      <Stack.Screen
        name="code-preview/[previewId]"
        options={{
          animation: pushAnimation,
          contentStyle: { backgroundColor: background },
          // The diagram pans with one finger, so only the screen edge goes back.
          fullScreenGestureEnabled: false,
          gestureEnabled: true,
          // The screen draws the app's glass header, as the chat does.
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="browser/[agentId]"
        options={{
          animation: pushAnimation,
          contentStyle: { backgroundColor: background },
          // Every finger on the page is the page's mouse, so only the screen edge goes back.
          fullScreenGestureEnabled: false,
          gestureEnabled: true,
          ...nativeBarOptions,
        }}
      />
      <Stack.Screen
        name="browser-tabs/[agentId]"
        // No header: the address bar is the sheet's first row, and the page shows above it.
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
      <Stack.Screen
        name="browser-help"
        // The header comes from the route's `_layout.tsx`: Android draws no header on a formSheet route.
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
      <Stack.Screen
        name="channel/[channelId]"
        options={{
          animation: chatAnimation,
          contentStyle: { backgroundColor: background },
          // A swipe to the right anywhere in the chat goes back. A message bubble keeps its swipe to
          // reply: react-native-screens is patched so that the back swipe waits for it.
          fullScreenGestureEnabled: true,
          gestureEnabled: true,
          ...nativeBarOptions,
        }}
      />
      <Stack.Screen
        name="channel-info/[channelId]"
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
      <Stack.Screen
        name="channel-actions/[channelId]"
        // The header comes from the route's `_layout.tsx`: Android draws no header on a formSheet route.
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
      <Stack.Screen
        name="add-channel"
        // The header comes from the route's `_layout.tsx`: Android draws no header on a formSheet route.
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
      <Stack.Screen
        name="add-agent"
        // The header comes from the route's `_layout.tsx`: Android draws no header on a formSheet route.
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
      <Stack.Screen
        name="agent-info/[agentId]"
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
      <Stack.Screen
        name="section-form"
        // The header comes from the route's `_layout.tsx`: Android draws no header on a formSheet route.
        listeners={refocusNameField}
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
      <Stack.Screen
        name="thread-rename"
        // The header comes from the route's `_layout.tsx`, as for the section form.
        listeners={refocusNameField}
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
      <Stack.Screen
        name="new-task"
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
      <Stack.Screen
        name="hidden-chats"
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
      <Stack.Screen
        name="deleted-chats"
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
      <Stack.Screen
        name="server-settings"
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
      {/* Full screens with a big header that the screen draws: the native bar keeps only its buttons. */}
      <Stack.Screen name="server-routines/index" options={largeTitlePage} />
      <Stack.Screen
        name="server-routines/agent-routine"
        options={{
          animation: pushAnimation,
          contentStyle: { backgroundColor: sheetBackground },
          headerStyle: { backgroundColor: sheetBackground },
          headerBlurEffect: "none",
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
          title: t("mobile.app.route.routine"),
        }}
      />
      <Stack.Screen
        name="server-routines/channel-routine"
        options={{
          animation: pushAnimation,
          contentStyle: { backgroundColor: sheetBackground },
          headerStyle: { backgroundColor: sheetBackground },
          headerBlurEffect: "none",
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
          title: t("mobile.app.route.routine"),
        }}
      />
      <Stack.Screen name="server-tasks" options={largeTitlePage} />
      <Stack.Screen name="server-workflows/index" options={largeTitlePage} />
      <Stack.Screen name="server-workflows/workflow" options={largeTitlePage} />
      <Stack.Screen name="server-workflows/runs" options={largeTitlePage} />
      <Stack.Screen name="server-workflows/run" options={largeTitlePage} />
      <Stack.Screen name="server-workflows/versions" options={largeTitlePage} />
      <Stack.Screen name="server-workflows/version" options={largeTitlePage} />
      <Stack.Screen name="server-workflows/github-events" options={largeTitlePage} />
      <Stack.Screen
        name="workflow-editor"
        // One sheet for the editor: its pages are in the stack of `workflow-editor/_layout.tsx`.
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
      <Stack.Screen name="server-usage/index" options={largeTitlePage} />
      <Stack.Screen
        name="share"
        // The header comes from the route's `_layout.tsx`: Android draws no header on a formSheet route.
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
      <Stack.Screen
        name="queued-messages"
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
      <Stack.Screen
        name="vault-request"
        // The header comes from the route's `_layout.tsx`: Android draws no header on a formSheet route.
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
      <Stack.Screen
        name="turn-thinking"
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
      <Stack.Screen
        name="settings"
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
      <Stack.Screen
        name="plan-limits"
        // The header comes from the route's `_layout.tsx`: Android draws no header here.
        options={{
          contentStyle: { backgroundColor: sheetBackground },
          headerShown: false,
          scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        }}
      />
    </Stack>
  );
}

/**
 * On a wide window, such as iPad or the open iPhone Duo, the chat list stays in a pane beside the stack,
 * and the chats open beside it. The first-run flow keeps the whole window.
 */
function AuthenticatedSplit({ children }: PropsWithChildren) {
  const onboarding = useHomeOnboarding();
  const { t } = useText();
  return (
    <AdaptiveSplit
      enabled={!onboarding.active}
      resizeLabel={t("mobile.agent.home.chatListWidth")}
      pane={
        <ChatListPaneProvider>
          <ConnectedScreen variant="pane" />
        </ChatListPaneProvider>
      }
    >
      {children}
    </AdaptiveSplit>
  );
}

export default function AuthenticatedLayout() {
  const { session } = useMobileSession();
  const workspaceKey = session ? sessionWorkspaceKey(session) : "signed-out";

  return (
    <MobileWorkspaceProvider key={workspaceKey}>
      <HomeOnboardingProvider>
        <OutboxProvider>
          <AgentPinTransitionProvider>
            <QueuedMessagesProvider>
              <AuthenticatedSplit>
                <AuthenticatedStack />
              </AuthenticatedSplit>
              <Dock />
              <MermaidRendererHost />
              <AudioWaveformHost />
            </QueuedMessagesProvider>
          </AgentPinTransitionProvider>
        </OutboxProvider>
      </HomeOnboardingProvider>
    </MobileWorkspaceProvider>
  );
}
