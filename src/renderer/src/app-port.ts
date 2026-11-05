import type { TommyDesktopApi } from "@tommy/contracts/ipc";

/**
 * What the app shell and the cross-domain root modules reach in main, plus the shell actions
 * (`openUrl`, `openExternal`) that several domains share.
 */
export interface AppPort {
  getAppInfo: TommyDesktopApi["getAppInfo"];
  getAppAppearancePreference: TommyDesktopApi["getAppAppearancePreference"];
  getAppInterfaceSizePreference: TommyDesktopApi["getAppInterfaceSizePreference"];
  getAppLanguagePreference: TommyDesktopApi["getAppLanguagePreference"];
  onAppAppearancePreference: TommyDesktopApi["onAppAppearancePreference"];
  onAppInterfaceSizePreference: TommyDesktopApi["onAppInterfaceSizePreference"];
  onAppLanguagePreference: TommyDesktopApi["onAppLanguagePreference"];
  openExternal: TommyDesktopApi["openExternal"];
  openUrl: TommyDesktopApi["openUrl"];
  openChatWindow: TommyDesktopApi["openChatWindow"];
  getChatWindows: TommyDesktopApi["getChatWindows"];
  onChatWindows: TommyDesktopApi["onChatWindows"];
  onQuitShortcutHint: TommyDesktopApi["onQuitShortcutHint"];
  setAppAppearancePreference: TommyDesktopApi["setAppAppearancePreference"];
  setAppInterfaceSizePreference: TommyDesktopApi["setAppInterfaceSizePreference"];
  setAppLanguagePreference: TommyDesktopApi["setAppLanguagePreference"];
  agent: Pick<
    TommyDesktopApi["agent"],
    "readConversationPage" | "searchConversationMessages" | "searchConversationFiles" | "listRoutines" | "listAgents"
  >;
  routineFeed: TommyDesktopApi["routineFeed"];
  events: TommyDesktopApi["events"];
}

/** Read on each call: tests and stories replace `window.tommy` per case. */
export function appPort(): AppPort {
  return window.tommy;
}
