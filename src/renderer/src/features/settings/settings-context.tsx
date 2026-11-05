import {
  AGENT_DEFAULT_KEYS,
  type ApprovalAutomationPreference,
  agentAutoApprovalEnabled,
  type DynamicIslandGeometry,
  type ExternalLinkTarget,
} from "@tommy/contracts/ipc";
import type { MarketplaceListingLink } from "@tommy/contracts/marketplace-links";
import { DEFAULT_GENERAL_SETTINGS, type GeneralSettingsValue } from "@tommy/ui/features/settings/app-settings";
import { currentText } from "@tommy/ui/text";
import { createEffect, createSignal, flush, onSettled } from "solid-js";
import { isActionSoundEnabled, readActionSoundTheme, setActionSoundChoice } from "../../action-sounds";
import { actionToast } from "../../action-toast";
import { readShowAgentSteps, setShowAgentSteps, useShowAgentSteps } from "../../agent-steps-preference";
import { playSoundChoice, readTaskSound, setTaskSound } from "../../completion-sound";
import { usePlatform } from "../../platform";
import { readSendShortcutMode, setSendShortcutMode, useSendShortcutMode } from "../../send-shortcut-preference";
import { createSimpleContext } from "../../simple-context";
import { settingsPort } from "./settings-port";
import { isOpenSettingsShortcut } from "./settings-shortcut";
import type { SettingsTab } from "./settings-tabs";

function sameExternalLinkTarget(left: ExternalLinkTarget, right: ExternalLinkTarget): boolean {
  return left.kind === right.kind && (left.kind !== "app" || right.kind !== "app" || left.path === right.path);
}

/** Tells the user why a switch went back to its previous value. */
function showSaveFailure(error: unknown): void {
  const { t, errorMessage } = currentText();
  actionToast.error(errorMessage(error, t("settings.preferences.saveFailed")), {
    // One save can revert two switches, such as both notification switches. The id shows one toast.
    id: "settings-preference-save-failed",
  });
}

/**
 * Application-wide preferences and the two surfaces that edit them: the
 * settings page and the skills marketplace.
 *
 * Ungated - every preference has a default the app runs on, so nothing waits
 * for the reads below.
 *
 * The owners in main: the updater and the
 * Dynamic Island each persist their own, so `updateGeneralSettings` diffs the
 * incoming value field by field and calls only the owners whose fields moved.
 * Each call sets optimistically and reverts its own fields on failure, which is
 * why the reverts are per-branch rather than one restore of `previous`.
 */
const Settings = createSimpleContext({
  name: "Settings",
  init: () => {
    const platform = usePlatform();

    /**
     * The state of the preference reads below. "failed" when one or more reads failed: the rows of
     * that read show defaults, not the saved values, so the settings page tells the user and offers
     * a retry.
     */
    const [preferencesLoad, setPreferencesLoad] = createSignal<"loading" | "loaded" | "failed">("loading");
    const [skillsMarketplaceOpen, setSkillsMarketplaceOpen] = createSignal(false);
    // Undefined until main answers. The Settings preview then draws the notch it had before.
    const [builtInDisplayGeometry, setBuiltInDisplayGeometry] = createSignal<DynamicIslandGeometry | undefined>();
    /**
     * The agent or skill that a Marketplace link named, held as the plugin slug is. It is a kind and
     * an id, never a listing: the page loads the listing, and only Add on that page adds it.
     */
    const [pendingMarketplaceListing, setPendingMarketplaceListing] = createSignal<MarketplaceListingLink | null>(null);
    const [appSettingsOpen, setAppSettingsOpen] = createSignal(false);
    /** Counts each open request, so the settings page can tell a new request while it is open. */
    const [appSettingsOpenRequest, setAppSettingsOpenRequest] = createSignal(0);
    /** The tab that the next opening shows. Undefined keeps the tab that was open last. */
    const [appSettingsTab, setAppSettingsTab] = createSignal<SettingsTab | undefined>();
    /** The server that the Notifications tab shows first. Each nonce moves to it once. */
    const [notificationFocusRequest, setNotificationFocusRequest] = createSignal<{
      serverId: string;
      nonce: number;
    } | null>(null);
    let notificationFocusNonce = 0;
    // A request moves the tab once. A later opening of the settings shows the tab from the top.
    createEffect(appSettingsOpen, (open) => {
      if (!open) setNotificationFocusRequest(null);
    });
    /** A hosted server that the server menu asked to delete. The nonce repeats a request for the same server. */
    const [generalSettings, setGeneralSettings] = createSignal<GeneralSettingsValue>({
      ...DEFAULT_GENERAL_SETTINGS,
      taskSound: readTaskSound(),
      sendShortcut: readSendShortcutMode(),
      showAgentSteps: readShowAgentSteps(),
      soundFeedback: isActionSoundEnabled(),
      soundTheme: readActionSoundTheme(),
    });
    // The mode also changes outside this dialog: another window, or the web Preferences tab on
    // the same page. The shared signal carries those changes into the displayed settings value.
    // Two-arg form: compute tracks the signal, apply writes the store outside tracking.
    const sendShortcutMode = useSendShortcutMode();
    createEffect(
      () => sendShortcutMode(),
      (mode) => {
        setGeneralSettings((current) => (current.sendShortcut === mode ? current : { ...current, sendShortcut: mode }));
      },
    );
    const showAgentSteps = useShowAgentSteps();
    createEffect(
      () => showAgentSteps(),
      (show) => {
        setGeneralSettings((current) =>
          current.showAgentSteps === show ? current : { ...current, showAgentSteps: show },
        );
      },
    );
    const [approvalAutomation, setApprovalAutomation] = createSignal<ApprovalAutomationPreference>({
      defaultAutoApprove: false,
      autoApproveOverrides: {},
    });
    let appSettingsRestoreTarget: HTMLElement | null = null;
    let notificationPreferenceChanged = false;
    let busyMessageModeChanged = false;
    let agentDefaultsChanged = false;
    let agentMemoryLimitChanged = false;
    let keepRemoteSessionsChanged = false;
    let externalLinkTargetChanged = false;
    let launchAtLoginChanged = false;
    let keepRunningInBackgroundChanged = false;
    let keepAwakeChanged = false;
    let keepAwakeOnBatteryChanged = false;

    let dynamicIslandSaveCount = 0;

    function updateGeneralSettings(value: GeneralSettingsValue): void {
      const previous = generalSettings();
      function persistField<Key extends keyof GeneralSettingsValue, Response>(
        key: Key,
        request: Promise<Response>,
        read: (response: Response) => GeneralSettingsValue[Key],
      ): void {
        void request
          .then((response) => setGeneralSettings((current) => ({ ...current, [key]: read(response) })))
          .catch((error: unknown) => {
            setGeneralSettings((current) => ({ ...current, [key]: previous[key] }));
            showSaveFailure(error);
          });
      }

      setGeneralSettings(value);
      if (previous.taskSound !== value.taskSound) {
        setTaskSound(value.taskSound);
        playSoundChoice(value.taskSound);
      }
      if (previous.sendShortcut !== value.sendShortcut) {
        setSendShortcutMode(value.sendShortcut);
      }
      if (previous.showAgentSteps !== value.showAgentSteps) {
        setShowAgentSteps(value.showAgentSteps);
      }
      if (previous.soundFeedback !== value.soundFeedback || previous.soundTheme !== value.soundTheme) {
        setActionSoundChoice(value.soundFeedback ? value.soundTheme : "off");
      }
      if (
        previous.desktopNotifications !== value.desktopNotifications ||
        previous.notificationPreview !== value.notificationPreview
      ) {
        notificationPreferenceChanged = true;
        const saved = settingsPort().notifications.setPreference({
          desktopNotifications: value.desktopNotifications,
          messagePreview: value.notificationPreview,
        });
        // Each answer writes back only the switch that this change set, so that an older answer does
        // not undo a later change of the other switch.
        if (previous.desktopNotifications !== value.desktopNotifications)
          persistField("desktopNotifications", saved, (preference) => preference.desktopNotifications);
        if (previous.notificationPreview !== value.notificationPreview)
          persistField("notificationPreview", saved, (preference) => preference.messagePreview);
      }
      if (previous.busyMessageMode !== value.busyMessageMode) {
        busyMessageModeChanged = true;
        persistField(
          "busyMessageMode",
          settingsPort().setBusyMessageModePreference({ mode: value.busyMessageMode }),
          (preference) => preference.mode,
        );
      }
      if (AGENT_DEFAULT_KEYS.some((key) => previous.agentDefaults[key] !== value.agentDefaults[key])) {
        agentDefaultsChanged = true;
        persistField("agentDefaults", settingsPort().setAgentDefaults({ ...value.agentDefaults }), (saved) => saved);
      }
      // A hidden switch is null and cannot change.
      if (value.launchAtLogin !== null && previous.launchAtLogin !== value.launchAtLogin) {
        launchAtLoginChanged = true;
        persistField(
          "launchAtLogin",
          settingsPort().setAppBehaviorPreference({ launchAtLogin: value.launchAtLogin }),
          (preference) => preference.launchAtLogin,
        );
      }
      if (
        value.keepRunningInBackground !== null &&
        previous.keepRunningInBackground !== value.keepRunningInBackground
      ) {
        keepRunningInBackgroundChanged = true;
        persistField(
          "keepRunningInBackground",
          settingsPort().setAppBehaviorPreference({ keepRunningInBackground: value.keepRunningInBackground }),
          (preference) => preference.keepRunningInBackground,
        );
      }
      if (value.keepAwake !== null && previous.keepAwake !== value.keepAwake) {
        keepAwakeChanged = true;
        persistField(
          "keepAwake",
          settingsPort().setAppBehaviorPreference({ keepAwake: value.keepAwake }),
          (preference) => preference.keepAwake,
        );
      }
      if (value.keepAwakeOnBattery !== null && previous.keepAwakeOnBattery !== value.keepAwakeOnBattery) {
        keepAwakeOnBatteryChanged = true;
        persistField(
          "keepAwakeOnBattery",
          settingsPort().setAppBehaviorPreference({ keepAwakeOnBattery: value.keepAwakeOnBattery }),
          (preference) => preference.keepAwakeOnBattery,
        );
      }
      if (!sameExternalLinkTarget(previous.externalLinkTarget, value.externalLinkTarget)) {
        externalLinkTargetChanged = true;
        persistField(
          "externalLinkTarget",
          settingsPort().setExternalLinkPreference({ target: value.externalLinkTarget }),
          (preference) => preference.target,
        );
      }
      if (previous.keepRemoteSessions !== value.keepRemoteSessions) {
        keepRemoteSessionsChanged = true;
        persistField(
          "keepRemoteSessions",
          settingsPort().setRemoteSessionReusePreference({ keepBetweenRuns: value.keepRemoteSessions }),
          (preference) => preference.keepBetweenRuns,
        );
      }
      if (
        previous.macBookNotch !== value.macBookNotch ||
        previous.macBookNotchHaptics !== value.macBookNotchHaptics ||
        previous.macBookNotchIdle !== value.macBookNotchIdle ||
        previous.macBookNotchAdditionalDisplays !== value.macBookNotchAdditionalDisplays ||
        previous.macBookNotchWidthPercent !== value.macBookNotchWidthPercent ||
        previous.macBookNotchHeightPercent !== value.macBookNotchHeightPercent ||
        previous.macBookNotchServers !== value.macBookNotchServers ||
        previous.macBookNotchNewServers !== value.macBookNotchNewServers
      ) {
        // A slider drag sends one save per step. Only the reply to the newest save may change the
        // form, or an older reply would move the slider back while the user drags.
        const save = ++dynamicIslandSaveCount;
        void settingsPort()
          .dynamicIsland.setPreference({
            enabled: value.macBookNotch,
            hapticsEnabled: value.macBookNotchHaptics,
            idleVisible: value.macBookNotchIdle,
            additionalDisplaysEnabled: value.macBookNotchAdditionalDisplays,
            widthPercent: value.macBookNotchWidthPercent,
            heightPercent: value.macBookNotchHeightPercent,
            serverVisibility: value.macBookNotchServers,
            newServersVisible: value.macBookNotchNewServers,
          })
          .then((preference) => {
            if (save !== dynamicIslandSaveCount) return;
            setGeneralSettings((current) => ({
              ...current,
              macBookNotch: preference.enabled,
              macBookNotchHaptics: preference.hapticsEnabled,
              macBookNotchIdle: preference.idleVisible,
              macBookNotchAdditionalDisplays: preference.additionalDisplaysEnabled,
              macBookNotchWidthPercent: preference.widthPercent,
              macBookNotchHeightPercent: preference.heightPercent,
              macBookNotchServers: preference.serverVisibility,
              macBookNotchNewServers: preference.newServersVisible,
            }));
          })
          .catch((error: unknown) => {
            if (save !== dynamicIslandSaveCount) return;
            showSaveFailure(error);
            setGeneralSettings((current) => ({
              ...current,
              macBookNotch: previous.macBookNotch,
              macBookNotchHaptics: previous.macBookNotchHaptics,
              macBookNotchIdle: previous.macBookNotchIdle,
              macBookNotchAdditionalDisplays: previous.macBookNotchAdditionalDisplays,
              macBookNotchWidthPercent: previous.macBookNotchWidthPercent,
              macBookNotchHeightPercent: previous.macBookNotchHeightPercent,
              macBookNotchServers: previous.macBookNotchServers,
              macBookNotchNewServers: previous.macBookNotchNewServers,
            }));
          });
      }
    }

    /** Whether this agent acts without asking at Full access. */
    function agentAutoApproves(agentId: string): boolean {
      return agentAutoApprovalEnabled(approvalAutomation(), agentId);
    }

    /** Remembers what to focus when the dialog closes; the dialog itself restores it. */
    function openAppSettings(trigger?: HTMLElement | null, tab?: SettingsTab): void {
      const target = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      appSettingsRestoreTarget = target;
      setAppSettingsTab(tab);
      setAppSettingsOpen(true);
      setAppSettingsOpenRequest((count) => count + 1);
    }

    /**
     * Opens the Notifications tab, the one place where the user changes the level of a server and its
     * agents. With a server, the tab moves to the row of that server.
     */
    function openNotificationLevels(serverId?: string, trigger?: HTMLElement | null): void {
      if (serverId) setNotificationFocusRequest({ serverId, nonce: ++notificationFocusNonce });
      // The modal applies a tab when the requested tab changes, so a repeated request clears it first.
      setAppSettingsTab(undefined);
      flush();
      openAppSettings(trigger, "notifications");
    }

    onSettled(() => {
      // The native Preferences menu item sends the same request from main, so the shortcut below only
      // covers the window itself: both land here, and the dialog owns the open state either way.
      const handleSettingsShortcut = (event: KeyboardEvent) => {
        if (!isOpenSettingsShortcut(event)) return;
        event.preventDefault();
        openAppSettings(event.target instanceof HTMLElement ? event.target : null);
      };
      window.addEventListener("keydown", handleSettingsShortcut);
      const unsubscribe = settingsPort().onOpenSettings(() => openAppSettings());
      // A remote owner or admin can change an agent's grant from a phone or the web client.
      const unsubscribeApprovals = settingsPort().onApprovalAutomation(setApprovalAutomation);
      // An admin of a joined server can change how many memories each agent of this computer keeps.
      const unsubscribeMemoryLimit = settingsPort().onAgentMemoryLimitPreference(({ limit }) => {
        agentMemoryLimitChanged = true;
        setGeneralSettings((current) => ({ ...current, agentMemoryLimit: limit }));
      });
      // A page can open from main with no click here, such as a sign-in page, so main sends the notice.
      const unsubscribeLinkFallback = settingsPort().onExternalLinkFallback(({ name }) => {
        const { t } = currentText();
        actionToast.warning(t("settings.externalLinks.fallback.title", { name }), {
          id: "external-link-fallback",
          description: t("settings.externalLinks.fallback.description"),
        });
      });
      return () => {
        window.removeEventListener("keydown", handleSettingsShortcut);
        unsubscribeLinkFallback();
        unsubscribe();
        unsubscribeApprovals();
        unsubscribeMemoryLimit();
      };
    });

    /**
     * Reads the saved preferences. A failed read keeps the default value of its rows, and marks the
     * load as failed so that the settings page can show the error and read again.
     */
    function loadPreferences(): void {
      setPreferencesLoad("loading");
      void Promise.allSettled([
        settingsPort()
          .getBusyMessageModePreference()
          .then((preference) => {
            if (busyMessageModeChanged) return;
            setGeneralSettings((current) => ({ ...current, busyMessageMode: preference.mode }));
          }),
        settingsPort()
          .getAgentDefaults()
          .then((defaults) => {
            if (agentDefaultsChanged) return;
            setGeneralSettings((current) => ({ ...current, agentDefaults: defaults }));
          }),
        settingsPort()
          .getAgentMemoryLimitPreference()
          .then((preference) => {
            if (agentMemoryLimitChanged) return;
            setGeneralSettings((current) => ({ ...current, agentMemoryLimit: preference.limit }));
          }),
        settingsPort()
          .getAppBehaviorPreference()
          .then((preference) => {
            setGeneralSettings((current) => ({
              ...current,
              launchAtLogin: launchAtLoginChanged ? current.launchAtLogin : preference.launchAtLogin,
              keepRunningInBackground: keepRunningInBackgroundChanged
                ? current.keepRunningInBackground
                : preference.keepRunningInBackground,
              keepAwake: keepAwakeChanged ? current.keepAwake : preference.keepAwake,
              keepAwakeOnBattery: keepAwakeOnBatteryChanged
                ? current.keepAwakeOnBattery
                : preference.keepAwakeOnBattery,
            }));
          }),
        settingsPort()
          .getExternalLinkPreference()
          .then((preference) => {
            if (externalLinkTargetChanged) return;
            setGeneralSettings((current) => ({ ...current, externalLinkTarget: preference.target }));
          }),
        settingsPort()
          .getRemoteSessionReusePreference()
          .then((preference) => {
            if (keepRemoteSessionsChanged) return;
            setGeneralSettings((current) => ({ ...current, keepRemoteSessions: preference.keepBetweenRuns }));
          }),
        settingsPort()
          .notifications.getPreference()
          .then((preference) => {
            if (notificationPreferenceChanged) return;
            setGeneralSettings((current) => ({
              ...current,
              desktopNotifications: preference.desktopNotifications,
              notificationPreview: preference.messagePreview,
            }));
          }),
        // Main accepts island calls only from the main window, which owns the island.
        platform.chatWindow
          ? Promise.resolve()
          : settingsPort()
              .dynamicIsland.getPreference()
              .then((preference) =>
                setGeneralSettings((current) => ({
                  ...current,
                  macBookNotch: preference.enabled,
                  macBookNotchHaptics: preference.hapticsEnabled,
                  macBookNotchIdle: preference.idleVisible,
                  macBookNotchAdditionalDisplays: preference.additionalDisplaysEnabled,
                  macBookNotchWidthPercent: preference.widthPercent,
                  macBookNotchHeightPercent: preference.heightPercent,
                  macBookNotchServers: preference.serverVisibility,
                  macBookNotchNewServers: preference.newServersVisible,
                })),
              ),
      ]).then((results) => {
        setPreferencesLoad(results.some((result) => result.status === "rejected") ? "failed" : "loaded");
      });
    }

    onSettled(() => {
      loadPreferences();
      void settingsPort()
        .getApprovalAutomation()
        .then(setApprovalAutomation)
        .catch(() => undefined);
      if (platform.chatWindow) return;
      void settingsPort()
        .dynamicIsland.getBuiltInDisplayGeometry()
        .then((geometry) => setBuiltInDisplayGeometry(geometry))
        .catch(() => undefined);
    });

    const sendTestNotification = () => settingsPort().notifications.test();
    const openNotificationSettings = () => settingsPort().notifications.openSettings();

    return {
      preferencesLoadFailed: () => preferencesLoad() === "failed",
      reloadPreferences: loadPreferences,
      generalSettings,
      builtInDisplayGeometry,
      updateGeneralSettings,
      sendTestNotification,
      openNotificationSettings,
      agentAutoApproves,
      appSettingsOpen,
      setAppSettingsOpen,
      appSettingsOpenRequest,
      appSettingsRestoreTarget: () => appSettingsRestoreTarget,
      appSettingsTab,
      openAppSettings,
      notificationFocusRequest,
      openNotificationLevels,
      skillsMarketplaceOpen,
      setSkillsMarketplaceOpen,
      pendingMarketplaceListing,
      setPendingMarketplaceListing,
    };
  },
});

export const SettingsProvider = Settings.provider;
export const useSettings = Settings.use;
