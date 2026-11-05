import type { TommyDesktopApi } from "@tommy/contracts/ipc";

/**
 * What the settings context reaches in main: the app-wide preferences, the switches for updates,
 * notifications and the Dynamic Island, the local agents and their background processes of the
 * Agents tab, and the agents and the user's own notification levels of each server for the
 * Notifications tab.
 */
export interface SettingsPort {
  getAgentDefaults: TommyDesktopApi["getAgentDefaults"];
  getAgentMemoryLimitPreference: TommyDesktopApi["getAgentMemoryLimitPreference"];
  getAppBehaviorPreference: TommyDesktopApi["getAppBehaviorPreference"];
  getApprovalAutomation: TommyDesktopApi["getApprovalAutomation"];
  getBusyMessageModePreference: TommyDesktopApi["getBusyMessageModePreference"];
  getExternalLinkPreference: TommyDesktopApi["getExternalLinkPreference"];
  listExternalLinkBrowsers: TommyDesktopApi["listExternalLinkBrowsers"];
  chooseExternalLinkApp: TommyDesktopApi["chooseExternalLinkApp"];
  onExternalLinkFallback: TommyDesktopApi["onExternalLinkFallback"];
  getRemoteNetworkRoute: TommyDesktopApi["getRemoteNetworkRoute"];
  getRemoteSessionReusePreference: TommyDesktopApi["getRemoteSessionReusePreference"];
  onAgentMemoryLimitPreference: TommyDesktopApi["onAgentMemoryLimitPreference"];
  onApprovalAutomation: TommyDesktopApi["onApprovalAutomation"];
  onOpenSettings: TommyDesktopApi["onOpenSettings"];
  setAgentDefaults: TommyDesktopApi["setAgentDefaults"];
  setAppBehaviorPreference: TommyDesktopApi["setAppBehaviorPreference"];
  setBusyMessageModePreference: TommyDesktopApi["setBusyMessageModePreference"];
  setExternalLinkPreference: TommyDesktopApi["setExternalLinkPreference"];
  setRemoteNetworkRoute: TommyDesktopApi["setRemoteNetworkRoute"];
  setRemoteSessionReusePreference: TommyDesktopApi["setRemoteSessionReusePreference"];
  agent: Pick<
    TommyDesktopApi["agent"],
    "listAgents" | "updateAgent" | "listAgentNotificationLevels" | "setAgentNotificationLevel" | "onScopedEvent"
  >;
  backgroundProcesses: TommyDesktopApi["backgroundProcesses"];
  dynamicIsland: Pick<
    TommyDesktopApi["dynamicIsland"],
    "getBuiltInDisplayGeometry" | "getPreference" | "setPreference"
  >;
  notifications: Pick<TommyDesktopApi["notifications"], "getPreference" | "openSettings" | "setPreference" | "test">;
}

/** Read on each call: tests and stories replace `window.tommy` per case. */
export function settingsPort(): SettingsPort {
  return window.tommy;
}
