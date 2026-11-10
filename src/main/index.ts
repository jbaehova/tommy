import { join, resolve } from "node:path";
import { type AgentEvent, type CentralAuthState, type HostStatus, IPC_ENDPOINTS } from "@tommy/contracts/ipc";
import { createFormat, resolveLocale, translateFor, withHourCycle } from "@tommy/i18n";
import { localizeSourceText, sourceText } from "@tommy/i18n/source";
import { createTommyLogger, toLogValue } from "@tommy/logging";
import { createRemoteDirectoryRefresh } from "@tommy/team-client/remote-directory";
import { Effect, Semaphore } from "effect";
import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  type NativeImage,
  Notification,
  nativeImage,
  net,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  screen,
  shell,
} from "electron";
import { runCauseEffect } from "../backend/effect-boundary";
import { OWNER_NOTIFICATION_KEY } from "./agent-notification-level-store";
import { watchAppArchive } from "./app-archive-watch";
import { readAppVariant, resolveAppIconPath, resolveMenuBarIconPath } from "./app-icon";
import { type ApplicationServices, createApplicationServices } from "./application-services";
import { type BackgroundTray, createBackgroundTray } from "./background-tray";
import { removeClaudeCodeSessionEnvironment } from "./claude-session-environment";
import { findDeepLink, parseDeepLink } from "./deep-link-router";
import { requestNotificationPermission, showRetainedNotification } from "./desktop-notifications";
import { guardDevelopmentOutput } from "./development-output";
import {
  developmentUserDataName,
  readDevelopmentInstanceId,
  readDevelopmentProfile,
  readDevelopmentRemoteDebuggingPort,
  shouldAutoStartHost,
} from "./development-profile";
import { stopStuckExitAfterLimit } from "./exit-watchdog";
import { filePreviewPages } from "./file-preview-pages";
import { accountIpcHandlers } from "./ipc/account-handlers";
import { agentAdminIpcHandlers } from "./ipc/agent-admin-handlers";
import { agentFolderIpcHandlers } from "./ipc/agent-folder-handlers";
import { agentIpcHandlers } from "./ipc/agent-handlers";
import { agentInstructionsIpcHandlers } from "./ipc/agent-instructions-handlers";
import { appIpcHandlers } from "./ipc/app-handlers";
import { attachmentIpcHandlers } from "./ipc/attachment-handlers";
import { backgroundProcessIpcHandlers } from "./ipc/background-process-handlers";
import { browserDockIpcHandlers } from "./ipc/browser-dock-handlers";
import { browserIpcHandlers } from "./ipc/browser-handlers";
import { channelMemoryIpcHandlers } from "./ipc/channel-memory-handlers";
import { channelRoutineIpcHandlers } from "./ipc/channel-routine-handlers";
import { registerIpcGroups } from "./ipc/define-ipc-group";
import { dynamicIslandIpcHandlers } from "./ipc/dynamic-island-handlers";
import { eventsIpcHandlers } from "./ipc/events-handlers";
import { hostAdminIpcHandlers } from "./ipc/host-admin-handlers";
import { instanceTransferIpcHandlers } from "./ipc/instance-transfer-handlers";
import { macAutomationIpcHandlers } from "./ipc/mac-automation-handlers";
import { mcpServerIpcHandlers } from "./ipc/mcp-server-handlers";
import { memoryIpcHandlers } from "./ipc/memory-handlers";
import { messageDeletionIpcHandlers } from "./ipc/message-deletion-handlers";
import { notificationIpcHandlers } from "./ipc/notification-handlers";
import { providerAdminIpcHandlers } from "./ipc/provider-admin-handlers";
import { providerIpcHandlers } from "./ipc/provider-handlers";
import { routineFeedIpcHandlers } from "./ipc/routine-feed-handlers";
import { routineFlowIpcHandlers } from "./ipc/routine-flow-handlers";
import { routineIpcHandlers } from "./ipc/routine-handlers";
import { routineResultIpcHandlers } from "./ipc/routine-result-handlers";
import { sharedTableIpcHandlers } from "./ipc/shared-table-handlers";
import { skillIpcHandlers } from "./ipc/skill-handlers";
import { skillLearningIpcHandlers } from "./ipc/skill-learning-handlers";
import { storageIpcHandlers } from "./ipc/storage-handlers";
import { teamIpcHandlers } from "./ipc/team-handlers";
import { vaultIpcHandlers } from "./ipc/vault-handlers";
import { voiceIpcHandlers } from "./ipc/voice-handlers";
import { remoteLiveVoiceEventTarget } from "./ipc/voice-live-handlers";
import { workflowIpcHandlers } from "./ipc/workflow-handlers";
import { KeepAwake } from "./keep-awake";
import { stopAppImageCrashpadHandlerAtExit } from "./linux-appimage-crashpad";
import { installLinuxDesktopEntry } from "./linux-desktop-entry";
import { configureLinuxGpu } from "./linux-gpu-mode";
import { configureLinuxPasswordStore } from "./linux-password-store";
import { MacHapticFeedback } from "./mac-haptic-feedback";
import {
  configureApplicationMenu,
  createMainWindowController,
  createMainWindowHolder,
  hideWindowsForQuit,
  keepWindowsHidden,
  showMainWindow,
} from "./main-window";
import { ensureMacApplicationPresence, secondLaunchResponse } from "./main-window-state";
import { MessageLinkRelay, openHttpLink } from "./message-link-relay";
import { startMainLog } from "./provider-log";
import { watchRemoteHostDirectory } from "./remote-server-host-directory";
import { createRendererForwarders } from "./renderer-forwarders";
import { sendToRenderer } from "./renderer-ipc";
import { RoutineWake } from "./routine-wake";
import { memberAuditName } from "./server-audit-store";
import { takeServerModeEnvironment } from "./server-mode";
import { configureContentSecurityPolicy, configureRendererPermissions } from "./session-configuration";
import { OWNER_PIN_KEY } from "./sidebar-pin-store";
import { trustSystemCertificates } from "./system-certificates";
import { systemHourCycle } from "./system-hour-cycle";
import { TeardownRegistry } from "./teardown-registry";
import type { TraceFile } from "./trace-file";
import { setIpcCallObserver } from "./trusted-ipc";
import { setWindowAppearance } from "./window-appearance";

const logger = createTommyLogger("main");

// Electron keeps running after both events: an unhandled rejection only prints a warning, and a
// monitor leaves the default exception handling in place, except after `hideExceptionErrorBox`. These
// add a redacted log line and a trace span, so a diagnostics export shows that the main process failed
// and how often.
let crashTrace: TraceFile | null = null;
process.on("unhandledRejection", (reason) => reportMainProcessFailure("unhandledRejection", reason));
process.on("uncaughtExceptionMonitor", (error, origin) => reportMainProcessFailure(origin, error));

let exceptionErrorBoxHidden = false;

/**
 * Electron shows its error box for an uncaught exception only while no other listener handles it.
 * The box blocks the main thread: on a server nobody can close it, and during a quit it also holds
 * back the shutdown deadline (#3808). The monitor above still logs the exception.
 */
function hideExceptionErrorBox(): void {
  if (exceptionErrorBoxHidden) return;
  exceptionErrorBoxHidden = true;
  process.on("uncaughtException", () => {
    // Electron's own listener keeps the process running too.
  });
}

/**
 * `menu` and `shortcut` are the macOS Quit item by click and by `Cmd + Q`, `tray` is the tray item on
 * Windows and Linux, and `update` is an update install. `quit` is any other request: the Dock, another
 * app, or a system logout on macOS.
 */
type ExitReason = "main_window_closed" | "signal" | "session_end" | "menu" | "shortcut" | "tray" | "update" | "quit";
let exitRecorded = false;

/**
 * Records once why Tommy quits, in the main log and in the trace, before the teardown closes the
 * trace. The first reason wins: closing the window then also quits. A process that ends with no such
 * line and no crash dump stopped from outside with a signal that cannot be caught, such as SIGKILL or
 * Task Manager.
 */
function recordExit(reason: ExitReason): void {
  if (exitRecorded) return;
  exitRecorded = true;
  logger.info(`Quitting: ${reason}.`);
  if (!crashTrace) return;
  crashTrace.record({ kind: "exit", name: reason, durationMs: 0, outcome: "requested" });
  Effect.runFork(crashTrace.flush());
}

function quitFor(reason: ExitReason): void {
  recordExit(reason);
  app.quit();
}

function reportMainProcessFailure(origin: "uncaughtException" | "unhandledRejection", error: unknown): void {
  logger.error(`Main process ${origin}:`, toLogValue(error));
  if (!crashTrace) return;
  crashTrace.record({ kind: "crash", name: origin, durationMs: 0, outcome: "reported" });
  Effect.runFork(crashTrace.flush());
}

// Before any network call: a TLS-inspecting company network needs the roots that IT installed.
try {
  trustSystemCertificates();
} catch (error) {
  logger.warn("Could not read the system certificate store; Node uses its bundled roots only:", toLogValue(error));
}

const commandLineUserDataDirectory = app.commandLine.getSwitchValue("user-data-dir").trim();
const developmentProfile = !app.isPackaged ? readDevelopmentProfile(process.env.TOMMY_DEV_PROFILE) : null;
const backgroundDevelopment = !app.isPackaged && process.env.TOMMY_DEV_BACKGROUND === "1";
// Before any child process starts: agents must not run as part of a Claude Code session that started Tommy.
removeClaudeCodeSessionEnvironment(process.env);
const serverMode = takeServerModeEnvironment(process.env, app.isPackaged, process.platform);
if (serverMode || backgroundDevelopment) {
  hideExceptionErrorBox();
  keepWindowsHidden();
}
if (backgroundDevelopment) {
  app.on("browser-window-created", (_event, window) => window.setFocusable(false));
}
const developmentRemoteDebuggingPort = !app.isPackaged
  ? readDevelopmentRemoteDebuggingPort(process.env.TOMMY_DEV_REMOTE_DEBUGGING_PORT)
  : null;
// Electron exposes FedCM without an account chooser, so every request fails with a NetworkError.
// Sites such as Google Sign-In use FedCM when it exists and fall back to their popup when it does not.
app.commandLine.appendSwitch("disable-features", "FedCm");
if (developmentRemoteDebuggingPort) {
  app.commandLine.appendSwitch("remote-debugging-port", developmentRemoteDebuggingPort);
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}
// Development only: a smoke test on a Mac does not stop at the Keychain password dialog.
if (!app.isPackaged && process.env.TOMMY_DEV_MOCK_KEYCHAIN === "1") app.commandLine.appendSwitch("use-mock-keychain");
// Linux #2374: name the Secret Service where Chromium would keep no sign-in.
if (configureLinuxPasswordStore())
  logger.info(`No Chromium keyring for "${process.env.XDG_CURRENT_DESKTOP ?? ""}"; using gnome-libsecret.`);
if (commandLineUserDataDirectory) {
  app.setPath("userData", resolve(commandLineUserDataDirectory));
} else if (!app.isPackaged) {
  app.setPath(
    "userData",
    join(
      app.getPath("appData"),
      developmentUserDataName(
        developmentProfile ?? "app",
        readDevelopmentInstanceId(process.env.TOMMY_DEV_INSTANCE_ID),
      ),
    ),
  );
}
// The data folder and the keyring item use this name.
app.setName("Tommy");
app.enableSandbox();
const hasSingleInstanceLock = app.requestSingleInstanceLock();
// A second launch exits at once and must not write into the files of the instance that runs.
if (hasSingleInstanceLock) {
  startMainLog(join(app.getPath("userData"), "logs"));
  // Crash dumps stay in `crashDumps` on this computer. Crashpad removes old reports itself. Without
  // them, a window that disappeared on Windows left nothing to tell a crash from a quit (#2675).
  crashReporter.start({ uploadToServer: false });
  // Linux AppImage: the handler must stop before the AppImage unmounts (#3066).
  stopAppImageCrashpadHandlerAtExit();
  // A file request that never finishes must not keep the process and its lock after an exit.
  stopStuckExitAfterLimit(join(app.getPath("userData"), "logs"));
}
// Linux: the GPU stays on until it fails on this computer (#992). `userData` has its final path here.
configureLinuxGpu({
  userDataPath: app.getPath("userData"),
  ownsInstance: hasSingleInstanceLock,
  server: serverMode !== null,
});
const appVariant = readAppVariant(process.env.TOMMY_APP_VARIANT, app.isPackaged);
if (!app.isPackaged) guardDevelopmentOutput([process.stdout, process.stderr], () => app.quit());
const appIconPath = resolveAppIconPath({
  variant: appVariant,
  platform: process.platform,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  sourceRoot: resolve(__dirname, "../.."),
});
protocol.registerSchemesAsPrivileged([
  {
    scheme: "tommy-app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  // `stream` lets an <audio> or <video> element play a file from the scheme: without it the
  // element cannot make the range requests that playback needs.
  {
    scheme: "tommy-attachment",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
  {
    scheme: "tommy-remote-attachment",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
  // A visual reply page. It needs no fetch or CORS support: only a frame loads it.
  {
    scheme: "tommy-visual",
    privileges: { standard: true, secure: true },
  },
  {
    scheme: "tommy-remote-visual",
    privileges: { standard: true, secure: true },
  },
  {
    scheme: "tommy-avatar",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "tommy-remote-avatar",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "tommy-server-logo",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "tommy-remote-server-logo",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

/**
 * The one handle that replaces the fourteen module-scope service `let`s this file used to keep.
 * Null until `createApplicationServices` returns, and never null again - which is why nothing below
 * treats a null as a recoverable state beyond the startup window it really is.
 */
let services: ApplicationServices | null = null;
let activeRemotePrincipalId: string | null = null;
/** Counts account transitions, so queued work for a superseded one is dropped rather than applied. */
let centralAuthGeneration = 0;
const remoteAccountGate = Semaphore.makeUnsafe(1);
const macHapticFeedback = new MacHapticFeedback();
let isQuitting = false;
let shutdownStarted = false;
const systemSessionEnding = false;
let relaunchRequested = false;
/**
 * Set by a quit signal, by `before-quit` and by a Windows `session-end`, and never cleared. Not
 * `isQuitting`: a Windows session end that another app cancels also sets that, and then Tommy
 * keeps running.
 */
let quitStarted = false;

const MAIN_WINDOW_STATE_FILE = "tommy-main-window-state-v1.json";

// A server is stopped with SIGTERM (systemd, Docker). Without a handler, Electron ends at once and its
// services do not stop. A hosted server's boat pre-stop hook stops it this way before the disk save
// (`scripts/hosting/tommy-boat-pre-stop`). The desktop app quits the same way, so a `kill` from a
// terminal or another app also stops its services and leaves a "Quitting: signal." line (#4149).
{
  const quitAfterSignal = () => {
    // Before `app.quit()`: the same signal can stop the Computer Use driver first.
    quitStarted = true;
    quitFor("signal");
  };
  process.once("SIGINT", quitAfterSignal);
  process.once("SIGTERM", quitAfterSignal);
  process.once("SIGHUP", quitAfterSignal);
}

/**
 * Filled in as `createApplicationServices` builds, so a quit that arrives part-way through stops
 * exactly what exists. Each step's position in the sequence is declared where the service is built.
 */
const teardown = new TeardownRegistry({
  reportError: (name, error) => logger.error(`Unable to shut down ${name}:`, toLogValue(error)),
});

// Declared before the forwarders and the window surface because both read it, and it outlives any
// one window: macOS destroys the main window on close and `activate` rebuilds it into this slot.
const windowHolder = createMainWindowHolder();

// Destructured so every `service.on("event", forwardX)` registration below reads as it always has.
const {
  forwardAgentEvent,
  forwardWorkflowNotice,
  forwardBrowserDisplayState,
  forwardVoiceStreamTranscript,
  forwardProviderRuntimeStatus,
  forwardVaultState,
  forwardHostStatus,
  forwardServers,
  forwardTeamPresence,
  forwardAttachmentDownload,
} = createRendererForwarders({
  getMainWindow: () => windowHolder.current,
  // A function: the window controller is made after the forwarders, and no event comes before it.
  getChatWindows: () => windows.getChatWindows(),
  getAgentService: () => services?.service ?? null,
  getHostService: () => services?.host ?? null,
  getRemoteServerManager: () => services?.remoteServers ?? null,
  showMainWindow,
  // An agent event cannot arrive before the services that raise it, so the fallback stands only so
  // that this module-level value needs no null check on the notification path.
  getTranslate: () => services?.language.translate ?? translateFor("en"),
  getFormat: () => {
    const locale = services?.language.locale ?? "en";
    return createFormat(locale, withHourCycle(locale, systemHourCycle()));
  },
  // The desktop app shows the notifications of a local server, as it does for every joined server.
  desktopNotificationsEnabled: () => services?.notificationPreference.get().desktopNotifications ?? true,
  notificationPreviewEnabled: () => services?.notificationPreference.get().messagePreview ?? true,
  ownAgentNotificationLevels: () => services?.agentNotificationLevels.levels(OWNER_NOTIFICATION_KEY) ?? new Map(),
});

// Resolved once, safely: every `app.setPath("userData", ...)` above has already run.
const windows = createMainWindowController({
  holder: windowHolder,
  statePath: join(app.getPath("userData"), MAIN_WINDOW_STATE_FILE),
  appIconPath,
  developmentProfile,
  isQuitting: () => isQuitting,
  keepRunningInBackground: () => services?.appBehavior.keepRunningInBackground ?? false,
  getServices: () => services,
  getTranslate: () => services?.language.translate ?? translateFor(resolveLocale("system", app.getLocale())),
  onRendererLoadStarted: () => {
    filePreviewPages.clear();
  },
  onRendererGone: () => {
    filePreviewPages.clear();
    services?.browser.releaseUserControlHeldBy({ kind: "local" });
  },
  onMainWindowCreated: (window) => {
    attachQuitOnMainWindowClose(window);
  },
  reportError: (message, error) => logger.error(message, toLogValue(error)),
  quitFromShortcut: () => quitFor("shortcut"),
});

let backgroundTray: BackgroundTray | null = null;

/**
 * Outside macOS, closing the main window ends Tommy, unless the user chose to keep it running in
 * the background. The window is then hidden, not closed, so this event does not come.
 *
 * `window-all-closed` cannot carry that on its own any more. The Computer Use overlays are hidden
 * between actions and closed only after a minute of idle, and a hidden window is still a window,
 * so the event may never arrive: the user would close the last window they can see and leave Tommy
 * and the driver running with no way back to them.
 */
function attachQuitOnMainWindowClose(window: BrowserWindow): void {
  if (process.platform === "darwin") return;
  window.on("closed", () => {
    recordExit("main_window_closed");
    // `quit`, not a teardown of its own: `before-quit` below is what Tommy shuts down through,
    // and it already ignores a second request while the first one runs.
    app.quit();
  });
}

function registerIpcHandlers({
  service,
  signInRelayClient,
  providerRuntimes,
  providerCredentials,
  mailbox,
  browser,
  browserPictureInPicture,
  localSignIn,
  browserDock,
  browserView,
  setupFile,
  approvalAutomation,
  agentAdminSettings,
  agentHostSettings,
  agentFolders,
  agentInstructions,
  browserProfiles,
  language,
  appearance,
  interfaceSize,
  notificationPreference,
  busyMessageMode,
  agentDefaults,
  agentMemoryLimit,
  memoryReview,
  agentAccess,
  serverAudit,
  teamStore,
  serverTimezone,
  promptCacheTtl,
  remoteSessionReuse,
  externalLinkPreference,
  externalLinks,
  openLink,
  remoteNetworkRoute,
  remoteSessionCache,
  appBehavior,
  agentInitialization,
  sidebarLayout,
  sidebarPins,
  host,
  remoteServers,
  centralAuth,
  pairedServer,
  skills,
  skillLearning,
  workflowConnectors,
  vault,
  routineFeed,
  events,
  instanceTransfer,
  dynamicIsland,
  storageUsage,
  machineAlerts,
  trace,
  resourceMonitor,
  routineFlows,
  workflows,
  routineResults,
}: ApplicationServices): void {
  // Every renderer-to-main endpoint is bound by one of these, one file per domain under ./ipc.
  // Nothing is bound inline here: this is the trust boundary, and a reviewer should be able to read
  // a domain's whole surface in one file rather than find it interleaved with window and lifecycle
  // code. `registerIpcGroups` takes one entry per group in `IPC_ENDPOINTS`, so a group no registrar
  // covers - or a registrar that stops covering one - fails to compile here, naming the group.
  // Every handler below reads this only as the parent of a native dialog. A dialog opens on the
  // window that the user works in: when a chat window has focus, the main window can be hidden.
  const getDialogParent = () => windows.getChatWindows().find((window) => window.isFocused()) ?? windowHolder.current;

  registerIpcGroups({
    ...appIpcHandlers({
      service,
      mailbox,
      browser,
      setupFile,
      approvalAutomation,
      busyMessageMode,
      agentDefaults,
      agentMemoryLimit,
      remoteSessionReuse,
      externalLinkPreference,
      externalLinks,
      openLink,
      remoteNetworkRoute,
      applyRemoteNetworkRoute: () => runCauseEffect(host.applyNetworkRoute()),
      remoteSessionCache,
      appBehavior,
      language,
      appearance,
      interfaceSize,
      initializeAgent: () => (serverMode ? runCauseEffect(agentInitialization.start()) : Promise.resolve()),
      appVariant,
      getMainWindow: getDialogParent,
      openChatWindow: windows.openChatWindow,
      chatWindowTargets: windows.chatWindowTargets,
      trace,
      resources: resourceMonitor,
    }),
    ...dynamicIslandIpcHandlers({ dynamicIsland }),
    ...browserDockIpcHandlers({ browserDock }),

    ...macAutomationIpcHandlers({ platform: process.platform }),
    ...backgroundProcessIpcHandlers({ platform: process.platform, agents: () => service.listAgents() }),
    ...providerIpcHandlers({ service, providerRuntimes, credentials: providerCredentials, openLink }),
    ...voiceIpcHandlers({
      remoteServers,
      liveVoice: service.liveVoice,
      forwardTranscript: forwardVoiceStreamTranscript,
    }),
    ...accountIpcHandlers({ centralAuth, pairedServer, remoteServers }),
    ...skillLearningIpcHandlers({
      skillLearning,
      saveSuggestion: (input) => service.saveSkillSuggestion(input),
      remoteServers,
    }),
    ...messageDeletionIpcHandlers({
      deleteMessage: (input) => service.deleteMessage(input),
      deleteTaskMessage: (input) => service.deleteTaskMessage(input),
      deleteChannelMessage: (input) => service.deleteChannelMessage(input),
      deleteAgentHistory: (input) => service.deleteAgentHistory(input),
      deleteChannelHistory: (input) => service.deleteChannelHistory(input),
      remoteServers,
    }),
    ...skillIpcHandlers({ skills, getMainWindow: getDialogParent, translate: language.translate }),
    ...agentFolderIpcHandlers({
      folders: agentFolders,
      remoteServers,
      getMainWindow: getDialogParent,
      translate: language.translate,
    }),
    ...agentInstructionsIpcHandlers({ files: agentInstructions, remoteServers }),
    ...vaultIpcHandlers({ vault, getMainWindow: getDialogParent, translate: language.translate, remoteServers }),
    ...routineFeedIpcHandlers({ routineFeed }),
    ...eventsIpcHandlers({ events, remoteServers }),

    ...instanceTransferIpcHandlers({
      instanceTransfer,
      remoteServers,
      getMainWindow: getDialogParent,
      translate: language.translate,
    }),
    ...notificationIpcHandlers({
      notificationPreference,
      translate: language.translate,
      requestPermission: () => requestDesktopNotificationPermission(notificationPreference, language.translate),
      openExternal: (url) => shell.openExternal(url),
    }),
    ...teamIpcHandlers({ host, remoteServers }),
    ...memoryIpcHandlers({ service, remoteServers }),
    ...sharedTableIpcHandlers({ service, remoteServers }),
    ...routineIpcHandlers({ service, remoteServers }),
    ...routineFlowIpcHandlers({ routineFlows, remoteServers }),
    ...workflowIpcHandlers({
      workflows,
      events,
      remoteServers,
      integrationCatalog: () => workflowConnectors.catalog(),
      githubCatalog: () => workflowConnectors.githubCatalog(),
      githubOptions: (repository) =>
        workflowConnectors.githubApi()?.options(repository) ??
        Effect.fail({ code: "noAccess" as const, message: sourceText("error.workflow.outputRefused") }),
    }),
    ...routineResultIpcHandlers({ routineResults }),
    ...channelMemoryIpcHandlers({ service, remoteServers }),
    ...channelRoutineIpcHandlers({ service, remoteServers }),
    ...agentAdminIpcHandlers({
      settings: agentAdminSettings,
      hostSettings: agentHostSettings,
      browserProfiles,
      skills,
      remoteServers,
    }),
    ...hostAdminIpcHandlers({
      host,
      remoteServers,
      serverTimezone,
      agentMemoryLimit,
      memoryReview,
      machineAlerts,
      promptCacheTtl,
      agentAccess,
      serverAudit,
      localServerId: () => teamStore.getIdentity()?.serverId,
      localAgentIds: () => service.listAgents().map((agent) => agent.id),
      localOwner: () => {
        const owner = teamStore.configured
          ? teamStore.listMembers().find((member) => member.role === "owner")
          : undefined;
        return owner ? memberAuditName(owner) : null;
      },
    }),
    ...providerAdminIpcHandlers({
      service,
      credentials: providerCredentials,
      runtimes: providerRuntimes,
      remoteServers,
      relay: signInRelayClient,
    }),
    ...mcpServerIpcHandlers({
      service,
      remoteServers,
      startToolRuntimes: () => {
        Effect.runFork(providerRuntimes.ensureToolRuntimes());
      },
      ensureToolRuntimesReady: () => providerRuntimes.ensureToolRuntimesReady(),
      toolRuntimes: () => providerRuntimes.mcpToolRuntimes(),
      relay: signInRelayClient,
    }),
    ...attachmentIpcHandlers({
      service,
      mailbox,
      remoteServers,
      getMainWindow: getDialogParent,
      translate: language.translate,
    }),
    ...storageIpcHandlers({
      storage: storageUsage,
      machine: machineAlerts,
      providerRuntimes,
      mailbox,
      remoteServers,
      getMainWindow: getDialogParent,
      translate: language.translate,
      agents: () => service.listAgents(),
      openPath: (path) => shell.openPath(path),
    }),
    ...agentIpcHandlers({
      service,
      sidebarLayout,
      sidebarPins,
      host,
      remoteServers,
      skills,
      messageLinks: new MessageLinkRelay({
        remoteServers,
        relay: signInRelayClient,
        openUrl: (url) => openHttpLink(url, openLink),
      }),
      openExternal: openLink,
    }),
    ...browserIpcHandlers({ browserPictureInPicture, browser, remoteServers, browserView, localSignIn }),
  });
}

function requestDesktopNotificationPermission(
  preference: ApplicationServices["notificationPreference"],
  translate: ApplicationServices["language"]["translate"],
): Promise<void> {
  return runCauseEffect(
    requestNotificationPermission({
      platform: process.platform,
      preference,
      showWelcome: () => {
        if (!Notification.isSupported()) return;
        showRetainedNotification(new Notification({ title: "Tommy", body: translate("notification.welcome") }));
      },
    }),
  );
}

/** `null` for every state but a signed-in one, matching what the two principal trackers store. */
/** The Dock tile, the Linux desktop entry and the `tommy://` scheme. A local server has none of them. */
async function presentApplication(): Promise<void> {
  if (backgroundDevelopment) {
    if (process.platform === "darwin") app.setActivationPolicy("accessory");
    return;
  }
  await ensureMacApplicationPresence(
    process.platform,
    (policy) => app.setActivationPolicy(policy),
    () => app.dock?.show() ?? Promise.resolve(),
  );
  // Linux registers the scheme through xdg-settings, which can only name a desktop entry that
  // exists, so an AppImage writes its own first. On Windows the NSIS installer writes the scheme
  // (`build/installer.nsh`), and each start writes it again for installs from before that script.
  // A Windows development build does not register: the handler would be bare `electron.exe`.
  // A macOS development build does not register either: macOS ignores the path and arguments and
  // names the `com.github.Electron` bundle, so the link took `tommy://` from an installed
  // Tommy and opened some worktree's bare Electron.app. `bun run dev:slack` has a loopback return.
  await Effect.runPromise(
    installLinuxDesktopEntry({ platform: process.platform, environment: process.env, iconPath: appIconPath }),
  );
  if (process.platform === "linux" || (process.platform === "darwin" && app.isPackaged)) {
    if (!app.setAsDefaultProtocolClient("tommy")) {
      logger.warn("Unable to register the tommy:// scheme. MCP sign-ins may not return to this app.");
    }
  }
}

function centralAuthPrincipalId(state: CentralAuthState): string | null {
  return state.status === "signed_in" ? state.user.id : null;
}

function forwardCentralAuth(state: CentralAuthState): void {
  // The renderer is told about the new account at the end of this function, before the
  // queued work below can finish, so the host stops answering for the previous account now.
  // The file is left alone until `applySignedInAccount` records the switch.
  services?.host.unbindChangedAccount(state.status === "signed_in" ? state.user : null);
  const generation = ++centralAuthGeneration;
  void runCauseEffect(
    remoteAccountGate.withPermit(
      Effect.gen(function* () {
        // Sign-outs and sign-ins can queue up behind one slow teardown. Only the account the
        // renderer was last told about may be activated; an earlier one would put a host the
        // user has already left back within reach.
        if (generation !== centralAuthGeneration) return;
        const nextPrincipalId = state.status === "signed_in" ? state.user.id : null;
        if (activeRemotePrincipalId && activeRemotePrincipalId !== nextPrincipalId && services) {
          // Best-effort, like every other network step here: a bridge disconnect that
          // rejects must not stop the local host from leaving the previous account.
          yield* services.remoteServers
            .disconnectRemoteSessions()
            .pipe(
              Effect.catch((error) =>
                Effect.sync(() =>
                  logger.error("Unable to disconnect the previous account's remote sessions:", toLogValue(error.cause)),
                ),
              ),
            );
        }
        // Rechecked after the disconnect: another account can be announced while it awaits,
        // and activating this one now would put its host back within the newer account's reach.
        if (generation !== centralAuthGeneration) return;
        activeRemotePrincipalId = nextPrincipalId;
        if (state.status !== "signed_in") {
          if (state.status === "signed_out" && services) {
            // Stopping is best-effort; unbinding the host is not, so a failed teardown
            // must not leave the signed-out account's host bound.
            yield* services.host
              .stop(false)
              .pipe(
                Effect.catch((error) =>
                  Effect.sync(() =>
                    logger.error("Unable to stop the host while signing out:", toLogValue(error.cause)),
                  ),
                ),
              );
            yield* services.host.applySignedInAccount(null);
          }
          return;
        }
        const host = services?.host ?? null;
        // The local host is rebound before the joined-server list is synchronized, and the
        // network failure is contained: this account must not end up signed in while the
        // previous account's host is still selected and possibly online.
        if (host) {
          yield* host.applySignedInAccount(state.user);
          if (generation !== centralAuthGeneration) {
            // Another account was announced while this one was being activated. Its own queued
            // callback binds it; until then no host answers for either.
            host.unbindChangedAccount(null);
            return;
          }
        }
        if (services)
          yield* services.remoteServers
            .syncRemoteHosts()
            .pipe(
              Effect.catch((error) =>
                Effect.sync(() => logger.error("Unable to synchronize the joined servers:", toLogValue(error.cause))),
              ),
            );
        // A self-hosted server exists to be a host, so its first sign-in names and starts it too.
        if (host && services?.serverMode) yield* services.serverMode.publish();
        else if (host && shouldAutoStartHost({ ...host.getStatus(), remoteRole: null })) yield* host.start();
      }),
    ),
  ).catch((error) => {
    logger.error("Unable to synchronize the signed-in account:", toLogValue(error));
  });
  // A chat window shows the workspace only while the account is signed in, as the main window does.
  for (const chatWindow of windows.getChatWindows()) sendToRenderer(chatWindow, IPC_ENDPOINTS.auth.event, state);
  const window = windowHolder.current;
  if (!window || window.isDestroyed()) return;
  sendToRenderer(window, IPC_ENDPOINTS.auth.event, state);
}

/**
 * Hands one MCP sign-in the grant it is waiting for, and shows the window that asked for it.
 *
 * The grant travels no further, except to the joined server whose relayed sign-in waits for that
 * `state`. A `state` that nothing started finds no sign-in and does nothing, which is what makes a
 * forged or replayed link inert - so an unknown one raises no window either.
 */
function receiveMcpAuthorizationCode(state: string, code: string): void {
  const elsewhere = services?.mcpOAuth.openedElsewhere(state) ?? false;
  if (!services?.mcpOAuth.receiveAuthorizationCode(state, code)) {
    // A joined server's sign-in that waits on this computer; it ends on the host, so no window shows.
    services?.signInRelayClient.deliver(state, new URLSearchParams({ code, state }).toString());
    return;
  }
  if (elsewhere) return;
  const window = windowHolder.current;
  if (window && !window.isDestroyed()) showMainWindow(window);
}

app.on("open-url", (event, url) => {
  const link = parseDeepLink(url);
  if (!link) return;
  event.preventDefault();
  receiveMcpAuthorizationCode(link.state, link.code);
});

if (!hasSingleInstanceLock) {
  // No application services exist yet, so the secondary process can exit without shutdown work.
  process.exit(0);
} else {
  app.on("second-instance", (_event, argv) => {
    const deepLink = findDeepLink(argv);
    if (deepLink) receiveMcpAuthorizationCode(deepLink.state, deepLink.code);
    const window = windowHolder.current;
    const hasMainWindow = Boolean(window && !window.isDestroyed());
    const response = secondLaunchResponse({
      sessionEnding: systemSessionEnding,
      quitting: isQuitting,
      hasMainWindow,
      started: services !== null,
    });
    if (response === "present" && window) showMainWindow(window);
    else if (response === "reopen") reopenMainWindow();
    else if (response === "relaunch" && !relaunchRequested) {
      relaunchRequested = true;
      // The new instance takes this launch's link, not the one this process may have started with.
      const isLink = (value: string) => parseDeepLink(value) !== null;
      const link = argv.find(isLink);
      const args = process.argv.slice(1).filter((value) => !isLink(value));
      app.relaunch({ args: link ? [...args, link] : args });
    }
  });

  void app
    .whenReady()
    .then(async () => {
      // Startup marks for `dev:bench`, which reads them over the inspector. They change nothing.
      performance.mark("tommy:when-ready");
      // Set the Dock icon before `dock.show()` below. A development build runs the stock Electron.app,
      // so until this call its Dock tile shows the Electron logo.
      if (process.platform === "darwin") app.dock?.setIcon(appIconPath);
      await presentApplication();
      configureContentSecurityPolicy();
      configureRendererPermissions();
      // A local server keeps a window that never loads: the agent browser and the services attach to it.
      await Effect.runPromise(windows.restoreMainWindowBounds());
      const mainWindow = windows.openMainWindow();

      const built = await createApplicationServices({
        mainWindow,
        windows,
        appIconPath,
        appVariant,
        serverMode,
        macHapticFeedback,
        teardown,
        forwardCentralAuth,
        forwardBrowserDisplayState,
        forwardProviderRuntimeStatus,
        forwardWorkflowNotice,
        quitting: () => quitStarted,
      });
      services = built;
      performance.mark("tommy:services-built");
      // A server has nobody to read the warning; a development build runs no `app.asar`.
      if (app.isPackaged && !serverMode) {
        teardown.push(0, "app archive watch", watchAppArchive(process.resourcesPath, built.language.translate));
      }
      // `forwardCentralAuth` reaches the host, the remote servers and analytics only through
      // `services`, so every account change announced during construction was dropped.
      // `createApplicationServices` bound the local host to the one state it read and attributed the
      // queued analytics to it, so adopt that as the active principal; then apply the current state
      // if the account moved on after that read - a sign-in settling while `remoteServers.initialize()`
      // awaits would otherwise leave the previous account's host selected, with nothing to replay it.
      const appliedAccount = built.appliedAccount;
      activeRemotePrincipalId = centralAuthPrincipalId(appliedAccount);
      const currentAccount = built.centralAuth.getState();
      if (
        currentAccount.status !== appliedAccount.status ||
        centralAuthPrincipalId(currentAccount) !== centralAuthPrincipalId(appliedAccount)
      ) {
        forwardCentralAuth(currentAccount);
      }
      const {
        service,
        sidebarLayout,
        host,
        remoteServers,
        dynamicIsland,
        teamStore,
        language,
        appearance,
        interfaceSize,
        trace,
        appBehavior,
      } = built;

      crashTrace = trace;
      setIpcCallObserver((call) => trace.record({ kind: "ipc", ...call }));
      service.on("event", (event) => trace.observeAgentEvent(event));
      service.on("event", (event) => forwardAgentEvent("local", event));
      // A routine or its owner can be deleted outside the events API. Its route is then revoked here.
      // Turns and channel messages also send these events, so only a deleted owner starts a sync.
      let webhookAgentIds = new Set(service.listAgents().map((agent) => agent.id));
      const onRoutineEvent = (event: AgentEvent): void => {
        switch (event.type) {
          case "routines-changed":
          case "channel-routines-changed":
          // A save or a delete can remove a webhook trigger, and a new secret can add a route.
          case "workflows-changed":
            built.eventsRuntime.syncRoutes({ all: false });
            return;
          case "agents-changed": {
            const previous = webhookAgentIds;
            webhookAgentIds = new Set(event.agents.map((agent) => agent.id));
            if ([...previous].some((id) => !webhookAgentIds.has(id))) built.eventsRuntime.syncRoutes({ all: false });
            return;
          }
          case "channels-changed":
            if (!service.routineRecords.ownerExists({ kind: "channel", id: event.channelId }))
              built.eventsRuntime.syncRoutes({ all: false });
            return;
        }
      };
      // Routes belong to the signed-in account. A token refresh does not change them.
      let webhookPrincipalId = centralAuthPrincipalId(built.centralAuth.getState());
      built.eventsRuntime.setAccountPrincipal(webhookPrincipalId);
      const refreshWebhookRoutes = (state: CentralAuthState): void => {
        const principalId = centralAuthPrincipalId(state);
        if (principalId === webhookPrincipalId) return;
        webhookPrincipalId = principalId;
        built.eventsRuntime.setAccountPrincipal(principalId);
        if (principalId !== null) built.eventsRuntime.syncRoutes({ all: true });
      };
      service.on("event", onRoutineEvent);
      built.centralAuth.on("changed", refreshWebhookRoutes);
      let webhookHostId = host.getStatus().serverId;
      const onHostChanged = (status: HostStatus): void => {
        const hostIdentityChanged = status.serverId !== webhookHostId;
        webhookHostId = status.serverId;
        forwardHostStatus(status);
        const principalId = centralAuthPrincipalId(built.centralAuth.getState());
        if (hostIdentityChanged && principalId !== null && status.serverId !== null)
          built.eventsRuntime.syncRoutes({ all: true });
      };
      teardown.push(0, "event service listeners", () => {
        service.off("event", onRoutineEvent);
        built.centralAuth.off("changed", refreshWebhookRoutes);
        host.off("changed", onHostChanged);
      });
      sidebarLayout.on("changed", (layout) => forwardAgentEvent("local", { type: "sidebar-layout-changed", layout }));
      // A pin from the owner's phone shows at once in the sidebar of this computer.
      built.sidebarPins.subscribe((key) => {
        if (key === OWNER_PIN_KEY)
          forwardAgentEvent("local", { type: "sidebar-pins-changed", ...built.sidebarPins.snapshot(OWNER_PIN_KEY) });
      });
      built.approvalAutomation.subscribe((preference) => {
        for (const window of BrowserWindow.getAllWindows()) {
          sendToRenderer(window, IPC_ENDPOINTS.app.approvalAutomation, preference);
        }
      });
      built.agentMemoryLimit.subscribe((preference) => {
        for (const window of BrowserWindow.getAllWindows()) {
          sendToRenderer(window, IPC_ENDPOINTS.app.agentMemoryLimitPreference, preference);
        }
      });
      host.on("changed", onHostChanged);
      host.on("presence", (snapshot) => forwardTeamPresence("local", snapshot));
      built.vault.onChanged(forwardVaultState);
      remoteServers.on("changed", forwardServers);
      remoteServers.on("agent", (serverId, event, bufferedLive) => {
        forwardAgentEvent(serverId, event, bufferedLive);
      });
      remoteServers.on("liveVoice", (serverId, event) => {
        const target = remoteLiveVoiceEventTarget(serverId, event);
        const window = target ? BrowserWindow.fromWebContents(target) : null;
        if (window) sendToRenderer(window, IPC_ENDPOINTS.voice.liveEvent, { serverId, event });
      });
      service.on("liveVoice", (event, ownerId) => {
        if (ownerId.startsWith("local:")) {
          const senderId = Number(ownerId.slice("local:".length));
          const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.id === senderId);
          if (window) sendToRenderer(window, IPC_ENDPOINTS.voice.liveEvent, { serverId: "local", event });
        } else host.publishLiveVoice(ownerId, event);
      });
      remoteServers.on("presence", forwardTeamPresence);
      remoteServers.on("attachmentDownload", forwardAttachmentDownload);
      // Machine alerts are hidden for now: the check does not start, and no alert notification shows.
      // The selected server connects while the window loads. Its WebRTC setup takes seconds, and
      // the first screen waits for it. The other servers start after the load, below. The connection
      // needs the signed-in account, so it starts only after the account loads. A failed account
      // load is logged where it starts, and the event connections try again later.
      void Effect.runPromise(
        built.centralAuthInitialization.pipe(
          Effect.flatMap(() =>
            Effect.sync(() => {
              if (built.centralAuth.getState().status === "signed_in") remoteServers.connectActiveServer();
            }),
          ),
          Effect.catch(() => Effect.void),
        ),
      ).catch((error) => logger.warn("Unable to start the selected server's connection:", toLogValue(error)));
      // Before the renderer loads: the trust boundary and every protocol it fetches through have to
      // be in place before the first request can arrive.
      registerIpcHandlers(built);
      void requestDesktopNotificationPermission(built.notificationPreference, language.translate).catch((error) =>
        logger.warn("Unable to ask for notification permission:", toLogValue(error)),
      );
      configureApplicationMenu(service, interfaceSize, language.translate, quitFor);
      // The way back to a window hidden in the background.
      backgroundTray = createBackgroundTray({
        icon: nativeImage.createFromPath(appIconPath),
        menuBarIcon: loadMenuBarIcon(),
        translate: language.translate,
        open: reopenMainWindow,
        quit: () => quitFor("tray"),
      });
      const tray = backgroundTray;
      tray.sync(appBehavior.keepRunningInBackground);
      const unsubscribeBackgroundTray = appBehavior.subscribe(() => tray.sync(appBehavior.keepRunningInBackground));
      teardown.push(0, "background tray", () => {
        unsubscribeBackgroundTray();
        tray.destroy();
      });
      // One place turns a language change into every visible consequence: the menu is built again
      // because a native label cannot be changed in place, and every window is told, including the
      // Dynamic Island, which has no Settings of its own to read the new value from.
      language.subscribe((preference) => {
        configureApplicationMenu(service, interfaceSize, language.translate, quitFor);
        tray.relabel();
        for (const window of BrowserWindow.getAllWindows()) {
          sendToRenderer(window, IPC_ENDPOINTS.app.appLanguagePreference, preference);
        }
      });
      setWindowAppearance(appearance.preference);
      appearance.subscribe((preference) => {
        setWindowAppearance(preference);
        for (const window of BrowserWindow.getAllWindows()) {
          sendToRenderer(window, IPC_ENDPOINTS.app.appAppearancePreference, preference);
        }
      });
      interfaceSize.subscribe((preference) => {
        windows.getMainWindow()?.webContents.setZoomFactor(interfaceSize.zoomFactor);
        for (const chatWindow of windows.getChatWindows())
          chatWindow.webContents.setZoomFactor(interfaceSize.zoomFactor);
        for (const window of BrowserWindow.getAllWindows()) {
          sendToRenderer(window, IPC_ENDPOINTS.app.appInterfaceSizePreference, preference);
        }
      });
      await runCauseEffect(dynamicIsland.initialize()).catch((error) =>
        logger.error("Unable to initialize Dynamic Island:", toLogValue(error)),
      );
      const reconcileDynamicIsland = () =>
        void Effect.runPromise(dynamicIsland.reconcileWindow()).catch((error) =>
          logger.error("Unable to reconcile Dynamic Island displays:", toLogValue(error)),
        );
      // The island pages load beside the main window, not before it.
      reconcileDynamicIsland();
      await windows.loadRenderer(mainWindow);
      performance.mark("tommy:renderer-loaded");
      Effect.runFork(built.prewarmAgentDatabase);
      // `sendToRenderer` dropped the server changes made while the window loaded: the host list and
      // the connection of the selected server. The renderer can have read the list before them.
      forwardServers(remoteServers.list());
      // After the load: `sendToRenderer` drops events aimed at a window that is still loading.
      await Effect.runPromise(remoteServers.startEventConnections());
      screen.on("display-added", reconcileDynamicIsland);
      screen.on("display-removed", reconcileDynamicIsland);
      screen.on("display-metrics-changed", reconcileDynamicIsland);
      powerMonitor.on("resume", reconcileDynamicIsland);
      powerMonitor.on("resume", () => void Effect.runPromise(remoteServers.wake()));
      const routineWake = new RoutineWake({ routines: service, isOnline: () => net.isOnline() });
      powerMonitor.on("suspend", () => routineWake.suspend());
      powerMonitor.on("resume", () => routineWake.resume());
      teardown.push(0, "routine wake", () => routineWake.dispose());
      const keepAwake = new KeepAwake({
        enabled: () => appBehavior.keepAwake,
        onBatteryToo: () => appBehavior.keepAwakeOnBattery,
        onBattery: () => powerMonitor.isOnBatteryPower(),
        start: () => powerSaveBlocker.start("prevent-app-suspension"),
        stop: (id) => powerSaveBlocker.stop(id),
        log: (message) => logger.info(message),
      });
      const syncKeepAwake = () => keepAwake.sync();
      syncKeepAwake();
      const unsubscribeKeepAwake = appBehavior.subscribe(syncKeepAwake);
      powerMonitor.on("on-ac", syncKeepAwake);
      powerMonitor.on("on-battery", syncKeepAwake);
      teardown.push(0, "keep awake", () => {
        unsubscribeKeepAwake();
        powerMonitor.off("on-ac", syncKeepAwake);
        powerMonitor.off("on-battery", syncKeepAwake);
        keepAwake.dispose();
      });
      const teamIdentity = teamStore.getIdentity();
      if (built.serverMode) {
        const serverModeControl = built.serverMode;
        void runCauseEffect(
          built.centralAuthInitialization.pipe(Effect.flatMap(() => serverModeControl.publish())),
        ).catch((error) => logger.error("Unable to publish this server:", toLogValue(error)));
      } else if (
        shouldAutoStartHost({
          configured: Boolean(teamIdentity),
          enabledOnLaunch: teamIdentity?.enabledOnLaunch ?? false,
          remoteRole: null,
        })
      ) {
        void runCauseEffect(built.centralAuthInitialization.pipe(Effect.flatMap(() => host.start()))).catch((error) =>
          logger.error("Unable to republish this Tommy:", toLogValue(error)),
        );
      }
      // This computer only controls its server. Only the server runs agents, routines and provider CLIs.
      if (serverMode)
        void runCauseEffect(built.agentInitialization.start()).catch((error) => {
          logger.error("Unable to initialize the local agent backend:", toLogValue(error));
        });

      const directoryRefresh = createRemoteDirectoryRefresh(() => {
        const generation = centralAuthGeneration;
        return remoteAccountGate
          .withPermit(
            Effect.gen(function* () {
              if (generation !== centralAuthGeneration || built.centralAuth.getState().status !== "signed_in") return;
              yield* remoteServers.syncRemoteHosts();
            }),
          )
          .pipe(
            Effect.catch((error) =>
              Effect.sync(() => logger.error("Unable to refresh joined servers:", toLogValue(error.cause))),
            ),
          );
      });
      // A chat window is the app too (#2964): the user can move focus straight into it.
      const isAppWindow = (window: BrowserWindow | null) =>
        window !== null && (window === windowHolder.current || windows.getChatWindows().includes(window));
      app.on("browser-window-focus", (_event, window) => {
        if (isAppWindow(window)) {
          startDirectoryWatch();
          void Effect.runPromise(remoteServers.setAppFocused(true));
        }
      });
      app.on(
        "browser-window-blur",
        () => void Effect.runPromise(remoteServers.setAppFocused(BrowserWindow.getFocusedWindow() !== null)),
      );
      // A window that has no focus at start sends no blur event, and focus keeps a hosted server on.
      void Effect.runPromise(remoteServers.setAppFocused(BrowserWindow.getFocusedWindow() !== null));
      const refreshMemberships = () => void Effect.runPromise(directoryRefresh.refresh(true));
      remoteServers.on("directoryInvalidated", refreshMemberships);
      let stopDirectoryWatch = () => {};
      const startDirectoryWatch = () => {
        stopDirectoryWatch();
        stopDirectoryWatch = watchRemoteHostDirectory({
          isActive: () =>
            isAppWindow(BrowserWindow.getFocusedWindow()) && built.centralAuth.getState().status === "signed_in",
          refresh: () => directoryRefresh.refresh(),
        });
      };
      startDirectoryWatch();
      teardown.push(0, "joined-server directory refresh", () => {
        stopDirectoryWatch();
        remoteServers.off("directoryInvalidated", refreshMemberships);
      });

      app.on("activate", () => {
        const window = windowHolder.current;
        if (window && !window.isDestroyed()) {
          showMainWindow(window);
          return;
        }
        reopenMainWindow();
      });
    })
    .catch((error) => {
      // A quit during the start, such as `docker stop`, closes the window that is still loading.
      // The quit is already running: an error box would block it, and the shutdown deadline with it.
      // Not `isQuitting`: a Windows session end that another app cancels also sets it, and then no quit runs.
      if (shutdownStarted) {
        logger.warn("The quit stopped the start:", toLogValue(error));
        return;
      }
      // The Windows error box ends the text at a NUL character, so control characters are replaced.
      const message = (error instanceof Error ? error.message : String(error)).replace(/[^\P{Cc}\n\t]/gu, "�");
      logger.error("Tommy failed to start:", toLogValue(error));
      // A server has nobody at its virtual display to close the box, and the box blocks the quit. A
      // server on this computer has no window: the app that started it reports the failed start.
      if (!serverMode) {
        // The services, and with them the saved language, may not exist yet. Then the system language applies.
        const locale = services?.language.locale ?? resolveLocale("system", app.getLocale());
        const translate = services?.language.translate ?? translateFor(locale);
        dialog.showErrorBox(
          translate("startup.failedTitle"),
          translate("startup.failedBody", { message: localizeSourceText(message, locale) }),
        );
      }
      app.quit();
    });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  // Any other quit is recorded by `prepareForShutdown`.
  if (systemSessionEnding) recordExit("session_end");
  // A quit after a Windows session-end query does not run `prepareForShutdown`.
  hideExceptionErrorBox();
  isQuitting = true;
  quitStarted = true;
  if (systemSessionEnding) {
    if (services)
      void Effect.runPromise(services.providerRuntimes.stop()).catch((error) =>
        logger.warn("Provider runtimes did not stop.", toLogValue(error)),
      );
    return;
  }
  if (shutdownStarted) return;
  event.preventDefault();
  void prepareForShutdown().finally(() => app.quit());
});

/** Null outside macOS, or when the file is missing: the tray then shows the app icon. */
function loadMenuBarIcon(): NativeImage | null {
  if (process.platform !== "darwin") return null;
  const icon = nativeImage.createFromPath(
    resolveMenuBarIconPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      sourceRoot: resolve(__dirname, "../.."),
    }),
  );
  if (!icon.isEmpty()) return icon;
  logger.warn("The menu bar icon is missing.");
  return null;
}

function reopenMainWindow(): void {
  void windows
    .ensureMainWindow()
    .then(showMainWindow)
    .catch((error) => logger.error("Unable to open the main window:", toLogValue(error)));
}

/**
 * The teardown gives up on each step after its own limit, but steps run one after another, and
 * something outside it can still hold the quit. A process that outlives its window keeps the
 * single-instance lock, so every later launch exits without opening anything.
 */
const SHUTDOWN_DEADLINE_MS = 30_000;

function forceExitAfterShutdownDeadline(deadlineMs: number): void {
  setTimeout(() => {
    logger.error(`Tommy did not quit within ${deadlineMs} ms and will exit now.`);
    app.exit(0);
  }, deadlineMs);
}

/**
 * The five steps ahead of `teardown.runAll()` are pinned here rather than registered: the windows,
 * the notch windows and the haptic process have to disappear the moment the user asks to quit, not
 * behind a remote host that can take seconds to stop. The two service calls among them are
 * registered as well, for the case where the quit arrives before those services exist; both are
 * idempotent, so running twice costs nothing.
 */
async function prepareForShutdown(deadlineMs = SHUTDOWN_DEADLINE_MS): Promise<void> {
  if (shutdownStarted) return;
  // An update install runs this before its `app.quit()`, and the teardown closes the trace.
  recordExit("quit");
  shutdownStarted = true;
  isQuitting = true;
  hideExceptionErrorBox();
  forceExitAfterShutdownDeadline(deadlineMs);
  await runCauseEffect(windows.flushMainWindowBounds()).catch((error) =>
    logger.error("Unable to save the main window position:", toLogValue(error)),
  );
  // After the bounds are saved.
  hideWindowsForQuit();
  services?.dynamicIsland.destroy();
  macHapticFeedback.destroy();
  await teardown.runAll();
}
