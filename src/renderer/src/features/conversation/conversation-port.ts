import type { DeleteSharedTableInput, SharedTable, TommyDesktopApi } from "@tommy/contracts/ipc";

/**
 * What the conversation domain reaches in main: agent and direct message pages, sends, reads,
 * shared tables, and the browser seams a view takes when no runtime is injected.
 */
export interface ConversationPort {
  agent: Pick<
    TommyDesktopApi["agent"],
    | "readAgentSessionSettings"
    | "listAgentNotificationLevels"
    | "askSideQuestion"
    | "setAgentSessionSetting"
    | "resetAgentSessionSetting"
    | "onScopedEvent"
    | "deleteTable"
    | "listMemories"
    | "listRoutines"
    | "listTables"
    | "markConversationRead"
    | "markConversationUnread"
    | "readConversationPage"
    | "releaseFilePreview"
    | "searchConversationMessages"
    | "sendMessage"
  >;
  browser: Pick<
    TommyDesktopApi["browser"],
    | "capturePreview"
    | "finishLocalSignIn"
    | "onLiveViewEvent"
    | "openLocalSignIn"
    | "sendLiveViewInput"
    | "startLiveView"
    | "stopLiveView"
  >;
  storage: Pick<TommyDesktopApi["storage"], "openLocation">;
  browserDock: Pick<TommyDesktopApi["browserDock"], "publishPresentation" | "onAction" | "onShown">;
}

/** Read on each call: tests and stories replace `window.tommy` per case. */
export function conversationPort(): ConversationPort {
  return window.tommy;
}

/** Cleanup can run after IPC shuts down; process shutdown also frees these in-memory pages. */
export function releaseFilePreviewPage(pageUrl: string | undefined): void {
  if (!pageUrl) return;
  void conversationPort()
    .agent.releaseFilePreview(pageUrl)
    .catch(() => undefined);
}

/** The tables every agent shares. The web client reaches them on the host through the Team API. */
export interface SharedTableCalls {
  listTables(): Promise<SharedTable[]>;
  deleteTable(input: DeleteSharedTableInput): Promise<void>;
}
