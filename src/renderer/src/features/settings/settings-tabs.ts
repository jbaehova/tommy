import type { AppInfo } from "@tommy/contracts/ipc";
import type { AppTextKey } from "@tommy/i18n";
import { Bell, Bot, Mic, PanelTop, Settings, Smartphone } from "@tommy/ui";

export type SettingsTab = "general" | "agents" | "notifications" | "voice" | "devices" | "dynamic-island";

/**
 * A row of a tab that the settings search finds. The title key is also the anchor of the row: the
 * row markup sets `data-settings-row` to this key, so a search result can move to the row.
 */
type SettingsRow = {
  titleKey: AppTextKey;
  descriptionKey?: AppTextKey;
  /** True: the row shows only on macOS. False: never on macOS. Missing: on each platform. */
  macOS?: boolean;
};

/** False for a row that this platform does not show, so the search does not find it. */
export function settingsRowShown(row: { macOS?: boolean }, platform: AppInfo["platform"] | undefined): boolean {
  return row.macOS === undefined || row.macOS === (platform === "darwin");
}

/**
 * A tab holds the keys of its label and its header text, not the text itself. The list is read at
 * module level, before any component exists to translate it, and a label captured there would keep
 * the language the app started in. `rows` lists the rows of the tab in page order, for the search.
 */
type SettingsNavItem = {
  value: SettingsTab;
  titleKey: AppTextKey;
  descriptionKey: AppTextKey;
  icon: typeof Settings;
  rows: ReadonlyArray<SettingsRow>;
};

export const navItems: ReadonlyArray<SettingsNavItem> = [
  {
    value: "general",
    titleKey: "settings.tab.general.title",
    descriptionKey: "settings.tab.general.description",
    icon: Settings,
    rows: [
      { titleKey: "settings.language.title", descriptionKey: "settings.language.description" },
      { titleKey: "settings.interfaceSize.title", descriptionKey: "settings.interfaceSize.description" },
      { titleKey: "settings.sendShortcut.title", descriptionKey: "settings.sendShortcut.description" },
      { titleKey: "settings.showAgentSteps.title", descriptionKey: "settings.showAgentSteps.description" },
      { titleKey: "settings.externalLinks.title", descriptionKey: "settings.externalLinks.description" },
      { titleKey: "settings.launchAtLogin.title", descriptionKey: "settings.launchAtLogin.description" },
      { titleKey: "settings.keepRemoteSessions.title", descriptionKey: "settings.keepRemoteSessions.description" },
      { titleKey: "settings.keepRunning.title", descriptionKey: "settings.keepRunning.description", macOS: false },
      { titleKey: "settings.menuBar.title", descriptionKey: "settings.menuBar.description", macOS: true },
      { titleKey: "settings.keepAwake.title", descriptionKey: "settings.keepAwake.description" },
      { titleKey: "settings.keepAwakeOnBattery.title", descriptionKey: "settings.keepAwakeOnBattery.description" },
      { titleKey: "settings.restoreWorkspace.title", descriptionKey: "settings.restoreWorkspace.description" },
    ],
  },
  {
    value: "agents",
    titleKey: "settings.tab.agents.title",
    descriptionKey: "settings.tab.agents.description",
    icon: Bot,
    rows: [
      { titleKey: "agentSettings.automation.title" },
      { titleKey: "agentSettings.agentNewChat.title" },
      { titleKey: "agentSettings.quickAcknowledgement.title" },
      { titleKey: "settings.busyMessage.title", descriptionKey: "settings.busyMessage.description" },
      { titleKey: "settings.backgroundProcesses.title", descriptionKey: "settings.backgroundProcesses.description" },
    ],
  },
  {
    value: "notifications",
    titleKey: "settings.tab.notifications.title",
    descriptionKey: "settings.tab.notifications.description",
    icon: Bell,
    rows: [
      { titleKey: "settings.notifications.whatYouHear" },
      { titleKey: "settings.desktopNotifications.title", descriptionKey: "settings.desktopNotifications.description" },
      { titleKey: "settings.notificationPreview.title", descriptionKey: "settings.notificationPreview.description" },
      { titleKey: "settings.testNotification.title", descriptionKey: "settings.testNotification.description" },
      { titleKey: "settings.taskSound.title", descriptionKey: "settings.taskSound.description" },
      { titleKey: "settings.soundFeedback.title", descriptionKey: "settings.soundFeedback.description" },
    ],
  },
  {
    value: "voice",
    titleKey: "settings.tab.voice.title",
    descriptionKey: "settings.tab.voice.description",
    icon: Mic,
    rows: [{ titleKey: "settings.voice.openaiKey.title" }],
  },
  {
    value: "devices",
    titleKey: "settings.tab.devices.title",
    descriptionKey: "settings.tab.devices.description",
    icon: Smartphone,
    rows: [
      { titleKey: "settings.devices.connect.title", descriptionKey: "settings.devices.connect.description" },
      { titleKey: "settings.devices.list.title", descriptionKey: "settings.devices.list.description" },
    ],
  },
  {
    value: "dynamic-island",
    titleKey: "settings.tab.dynamicIsland.title",
    descriptionKey: "settings.tab.dynamicIsland.description",
    icon: PanelTop,
    rows: [
      { titleKey: "settings.notch.show.title", descriptionKey: "settings.notch.show.description" },
      { titleKey: "settings.notch.idle.title", descriptionKey: "settings.notch.idle.description" },
      { titleKey: "settings.notch.displays.title", descriptionKey: "settings.notch.displays.description" },
      { titleKey: "settings.notch.haptics.title", descriptionKey: "settings.notch.haptics.description" },
      { titleKey: "settings.notch.servers.title", descriptionKey: "settings.notch.servers.description" },
      { titleKey: "settings.notch.size.title", descriptionKey: "settings.notch.size.description" },
    ],
  },
];

export function navItem(tab: SettingsTab): SettingsNavItem {
  const found = navItems.find((item) => item.value === tab);
  if (!found) throw new Error(`Unknown settings tab: ${tab}`);
  return found;
}

/**
 * Whether the settings panel and its search show the tab. Hosted servers opens from its own entry, not
 * from this panel.
 */
export function settingsTabShown(tab: SettingsTab, dynamicIslandShown: boolean): boolean {
  return tab !== "dynamic-island" || dynamicIslandShown;
}

/**
 * The Dynamic Island exists only on macOS, and only the main window owns it: main rejects its calls
 * from a chat window.
 */
export function dynamicIslandSettingsShown(platform: AppInfo["platform"] | undefined, chatWindow: boolean): boolean {
  return platform === "darwin" && !chatWindow;
}
