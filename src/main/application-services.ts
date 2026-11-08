import { isManagedRuntimeProvider } from "@tommy/contracts/agent-providers";
import { Effect } from "effect";
import { toAgentRemovalFailed } from "../backend/agent/agent-removal";
import { AgentApiKeys } from "../backend/agent-api-keys";
import { AgentDatabaseSupervisor } from "../backend/agent-data/agent-database-supervisor";
import { AgentTables } from "../backend/agent-data/agent-tables";
import { AgentRoutineStore } from "../backend/agent-routine-store";
import { routineFlowRoutines } from "../backend/routine-flows/routine-flow-routines";
import { RoutineFlowStore } from "../backend/routine-flows/routine-flow-store";
import { createRoutineFlows, type RoutineFlowsHandle } from "../backend/routine-flows/routine-flows";
import { RoutineResultStore } from "../backend/routine-results/routine-result-store";
import { createRoutineResults, type RoutineResultsHandle } from "../backend/routine-results/routine-results";
import { WorkflowGitHubStore } from "../backend/workflows/workflow-github-store";
import { WorkflowRunStore } from "../backend/workflows/workflow-run-store";
import { WorkflowStore } from "../backend/workflows/workflow-store";
import { WorkflowTriggers, workflowScheduleDueAt } from "../backend/workflows/workflow-triggers";
import { createWorkflows, type WorkflowNotice, type WorkflowsHandle } from "../backend/workflows/workflows";
import { type AgentAdminSettingsService, createAgentAdminSettings } from "./agent-admin-settings";
import { spawnAgentDatabaseHost } from "./agent-database-host-process";
import { AgentDesktopRuntime, resolveAgentDesktop } from "./agent-desktop-runtime";
import { agentDisplayEnvironment, hasSeparateAgentDisplay } from "./agent-display";
import { type AgentFolders, createAgentFolders } from "./agent-folders";
import { type AgentHostSettingsService, createAgentHostSettings } from "./agent-host-settings";
import { type AgentInstructionsFiles, createAgentInstructionsFiles } from "./agent-instructions-files";
import { type BrowserProfileService, createBrowserProfileService } from "./browser-profile-service";
import { HostReleaseService, readInstallationMode } from "./host-release-service";
import { LocalSignInWindows } from "./local-sign-in-window";
import { LocalSkillLibrary } from "./local-skill-library";
import { localSkillTools } from "./local-skill-tools";
import { PushNotificationStore } from "./push-notification-store";
import type { NotificationRelayRequest } from "./push-notifications";
import { DESKTOP_USE_MS } from "./push-notifications";
import { RemoteWorkflowError } from "./remote-service-effects";
/**
 * The composition root. Every long-lived service the desktop app owns is built here, in one
 * function, in dependency order, and handed back as a single record.
 *
 * **One function on purpose.** Most of these services take their dependencies by value, and a value
 * only type-checks because `tsc` narrows a local across the statements of one function body. Split
 * this into stages and `mainWindow`, `browser`, `teamWebRtcBridge` and the rest would each have to
 * cross a boundary as `T | null`, which is how the entry point ended up with seventeen
 * `() => X | null` accessors and twenty-three unreachable "not ready" guards. A local built above
 * the line that reads it needs neither.
 *
 * **Construct only.** This function does not subscribe the renderer forwarders, register IPC
 * handlers, load the renderer or open event connections - the entry point does, after this returns.
 * The rule keeps the direction of the dependency honest: pull the wiring in here too and the
 * parameter object grows larger than the return value, at which point this is a service locator.
 *
 * **Every step is registered for teardown as it is built**, so a quit that arrives mid-startup
 * stops exactly what exists. `TEARDOWN_ORDER` below, not the order of the pushes, decides what runs
 * when - see `teardown-registry.ts` for why shutdown here is not the reverse of construction.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@tommy/contracts/agent-providers";
import type {
  AgentStatus,
  AppVariant,
  BrowserDisplayState,
  CentralAuthState,
  CentralAuthUser,
  ProviderRuntimeSnapshot,
} from "@tommy/contracts/ipc";
import {
  agentBrowserProfile,
  IPC_ENDPOINTS,
  isManagedToolRuntime,
  LOCAL_SERVER_ID,
  latestTurnAnswer,
} from "@tommy/contracts/ipc";
import { sourceText } from "@tommy/i18n/source";
import { createTommyLogger, toLogValue } from "@tommy/logging";
import { installRemoteSyncProfileSink } from "@tommy/team-client/sync-profile";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  Notification,
  powerMonitor,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  webContents,
} from "electron";
import { pasteCodeLoginSupported } from "../backend/agent/cli-code-login";
import { ProviderAccountStore } from "../backend/agent/provider-account-store";
import { AgentLifecycleFailed, AgentService } from "../backend/agent-service";
import { AgentStore } from "../backend/agent-store";
import { BrowserHost } from "../backend/browser-host";
import { BrowserProfileStore } from "../backend/browser-profiles/browser-profile-store";
import { runCauseEffect } from "../backend/effect-boundary";
import { MailboxStore } from "../backend/mailbox-store";
import { McpOAuth } from "../backend/mcp-oauth-provider";
import { passwordVaultRouter } from "../backend/password-vault-router";
import { SidebarLayoutStore } from "../backend/sidebar-layout-store";
import { StorageUsageScanner, StorageUsageService } from "../backend/storage-usage";
import { TommyDatabase } from "../backend/tommy-database";
import { AGENT_ACCESS_FILE, AgentAccessStore } from "./agent-access-store";
import {
  type AgentDefaultsPreferenceStore,
  createAgentDefaultsPreferenceStore,
} from "./agent-defaults-preference-store";
import { AgentInitializationGate } from "./agent-initialization";
import {
  AgentMemoryLimitPreferenceStore,
  type AgentMemoryLimitSetting,
  reloadingAgentMemoryLimit,
} from "./agent-memory-limit-preference-store";
import { AgentNotificationLevelStore, OWNER_NOTIFICATION_KEY } from "./agent-notification-level-store";
import { ApnsSender } from "./apns-sender";
import { AppBehaviorService } from "./app-behavior-service";
import { AppearanceService } from "./appearance-service";
import { ApprovalAutomation, readApprovalAutomation } from "./approval-automation-store";
import { AutomationServer } from "./automation-server";
import { BrowserDockOverlay } from "./browser-dock-overlay";
import { BrowserPictureInPicture } from "./browser-picture-in-picture";
import { BrowserViewClient } from "./browser-view-client";
import { BusyMessageModePreferenceStore } from "./busy-message-mode-preference-store";
import { ChatVisualPreviewer } from "./chat-visual-preview";
import { MCP_OAUTH_REDIRECT_URL } from "./deep-link-router";
import { desktopShowsAgentEvent } from "./desktop-notifications";
import { DirectClientBridge } from "./direct-client-bridge";
import { DirectDeviceStore } from "./direct-device-store";
import { DirectPairedServer } from "./direct-paired-server";
import { performDynamicIslandCriticalAction } from "./dynamic-island-actions";
import { DynamicIslandFailed, DynamicIslandWindowController, toDynamicIslandFailed } from "./dynamic-island-window";
import {
  createExternalLinkPreferenceStore,
  ExternalLinkOpener,
  type ExternalLinkPreferenceStore,
} from "./external-link-opener";
import { FcmSender } from "./fcm-sender";
import { HostEventsRuntime } from "./host-events-runtime";
import { agentWebhookRoutineWriter, HostEventsService, type HostWebhookRelay } from "./host-events-service";
import { HostService } from "./host-service";
import { HostVoice } from "./host-voice";
import { HostedServerStartRetry } from "./hosted-server-start-retry";
import { InstanceTransferService } from "./instance-transfer-service";
import { InterfaceSizeService } from "./interface-size-service";
import { prepareToolRuntimeForTest } from "./ipc/mcp-server-handlers";
import { LanguageService } from "./language-service";
import { LocalAccount } from "./local-account";
import { localRoutineFeedDocument } from "./local-routine-calendar";
import { createLoginItem } from "./login-item";
import type { MacHapticFeedback } from "./mac-haptic-feedback";
import { MACHINE_ALERTS_PREFERENCE_FILE, MachineAlertMonitor, MachineAlertPreferenceStore } from "./machine-alerts";
import { MachineMetricsSampler } from "./machine-metrics";
import {
  createDynamicIslandWindow,
  loadBrowserDockRenderer,
  loadDynamicIslandRenderer,
  type MainWindowController,
  showMainWindow,
} from "./main-window";
import {
  DATA_SKILL_SLUG,
  ManagedSkillService,
  retireManagedSkills,
  SKILL_CREATOR_SKILL_SLUG,
} from "./managed-skill-service";
import { McpHostSignIns } from "./mcp-host-sign-ins";
import { McpOAuthProxySettingsFile } from "./mcp-oauth-proxy-store";
import {
  MCP_OAUTH_REDIRECT_PATH,
  MCP_OAUTH_REDIRECT_PORT,
  startMcpOAuthRedirectServer,
} from "./mcp-oauth-redirect-server";
import { McpOAuthStore } from "./mcp-oauth-store";
import { MemoryReviewPreferenceStore } from "./memory-review-preference-store";
import { NotificationPreferenceStore } from "./notification-preference-store";
import { OnePasswordCliVault } from "./onepassword-cli-vault";
import { PromptCacheTtlPreferenceStore } from "./prompt-cache-ttl-preference-store";
import { ProviderAccountsHost } from "./provider-accounts-host";
import { createProviderCliAppVersionStore } from "./provider-cli-app-version-store";
import { ProviderCredentialStore } from "./provider-credential-store";
import { ProviderHostSignIns } from "./provider-host-sign-ins";
import { startAccountLog, startAgentLog, startProviderLog } from "./provider-log";
import { toProviderRuntimeFailure } from "./provider-runtime-effects";
import { ProviderRuntimeManager, providerRuntimeRoot } from "./provider-runtime-manager";
import { ProviderUseSettingsStore } from "./provider-use-settings-store";
import { decodeQueuedMessageReceipt } from "./remote-agent-decoding";
import { RemoteConnectTrace } from "./remote-connect-trace";
import { decodeVoid } from "./remote-host-decoding";
import {
  createRemoteNetworkRoutePreferenceStore,
  type RemoteNetworkRoutePreferenceStore,
} from "./remote-network-route-preference-store";
import { RemoteServerManager } from "./remote-server-manager";
import { RemoteSessionCache } from "./remote-session-cache";
import {
  createRemoteSessionReusePreferenceStore,
  type RemoteSessionReusePreferenceStore,
} from "./remote-session-reuse-preference-store";
import { remoteSyncProfileFile } from "./remote-sync-profile-file";
import { sendToRenderer } from "./renderer-ipc";
import { ResourceMonitor } from "./resource-monitor";
import { StatementTimings } from "./resource-summary";
import { RoutineFeedServer } from "./routine-feed-server";
import { ROUTINE_HOLD_FILE, takeRoutineHold } from "./routine-hold-file";
import { ScreenCapturer } from "./screen-capture";
import { SERVER_AUDIT_FILE, ServerAuditStore, serverAuditNames } from "./server-audit-store";
import { AGENT_PROCESS_VARIABLE, agentProcessEnvironment, ServerMemory } from "./server-memory";
import { ServerMode, type ServerModeEnvironment } from "./server-mode";
import { ServerTimezonePreferenceStore } from "./server-timezone-preference-store";
import {
  configureApplicationProtocol,
  configureAttachmentProtocol,
  configureServerLogoProtocols,
} from "./session-configuration";
import { readSetupState, writeSetupState } from "./setup-store";
import { SidebarPinStore } from "./sidebar-pin-store";
import { SignInRelayClient } from "./sign-in-relay-client";
import { agentPrintedLink, SignInRelayHost } from "./sign-in-relay-host";
import { SkillMarketplaceService } from "./skill-marketplace-service";
import { TeamStore } from "./team-store";
import { TeamWebRtcClientTransport } from "./team-webrtc-client-transport";
import type { TeardownRegistry } from "./teardown-registry";
import { THEME_PALETTE_DIRECTORY } from "./theme-palette-files";
import { TraceFile } from "./trace-file";
import { VaultService } from "./vault-service";
import { VaultStore } from "./vault-store";
import { VoiceApiKeyStore } from "./voice-api-key-store";

const logger = createTommyLogger("application-services");
const SETUP_FILE = "tommy-setup-v2.json";
const APPROVAL_AUTOMATION_FILE = "tommy-approval-automation-v3.json";
const V2_APPROVAL_AUTOMATION_FILE = "tommy-approval-automation-v2.json";
const ROUTINE_FEED_FILE = "tommy-routine-feed-v1.json";
const LEGACY_APPROVAL_AUTOMATION_FILE = "tommy-approval-automation-v1.json";
const LANGUAGE_PREFERENCE_FILE = "tommy-language-preference-v1.json";
const APPEARANCE_PREFERENCE_FILE = "tommy-appearance-preference-v1.json";
const NOTIFICATION_PREFERENCE_FILE = "tommy-notification-preference-v1.json";
const AGENT_MEMORY_LIMIT_PREFERENCE_FILE = "tommy-agent-memory-limit-v1.json";
const MEMORY_REVIEW_PREFERENCE_FILE = "tommy-memory-review-v1.json";
const AGENT_NOTIFICATION_LEVELS_FILE = "tommy-agent-notification-levels-v1.json";
const SIDEBAR_PINS_FILE = "tommy-sidebar-pins-v1.json";
const SERVER_TIMEZONE_PREFERENCE_FILE = "tommy-server-timezone-v1.json";
const PROMPT_CACHE_TTL_PREFERENCE_FILE = "tommy-prompt-cache-ttl-v1.json";
const REMOTE_SESSION_REUSE_PREFERENCE_FILE = "tommy-remote-session-reuse-preference-v1.json";
const EXTERNAL_LINK_PREFERENCE_FILE = "tommy-external-link-preference-v1.json";
const REMOTE_NETWORK_ROUTE_PREFERENCE_FILE = "tommy-remote-network-route-v1.json";
const APP_BEHAVIOR_PREFERENCE_FILE = "tommy-app-behavior-preference-v1.json";
const DYNAMIC_ISLAND_PREFERENCE_FILE = "tommy-dynamic-island-preference-v1.json";
const BROWSER_STATE_FILE = "tommy-browser-state-v1.json";
const SIDEBAR_LAYOUT_FILE = "tommy-sidebar-layout-v1.json";
const TEAM_FILE = "tommy-team-server-v1.json";
/** One host per account. The v1 file above stays as the last build without accounts left it. */
const TEAM_FILE_V2 = "tommy-team-server-v2.json";
const REMOTE_SERVERS_FILE = "tommy-remote-servers-v1.json";
const AGENT_DEFAULTS_PREFERENCE_FILE = "tommy-agent-defaults-v1.json";
const INTERFACE_SIZE_PREFERENCE_FILE = "tommy-interface-size-preference-v1.json";
const BUSY_MESSAGE_MODE_PREFERENCE_FILE = "tommy-busy-message-mode-v1.json";
const PROVIDER_CLI_APP_VERSION_FILE = "tommy-provider-cli-app-version-v1.json";
const PUSH_NOTIFICATION_FILE = "tommy-push-notifications-v1.json";
/** No outside server forwards webhooks to this host, so a webhook trigger has no public address. */
const NO_WEBHOOK_RELAY: HostWebhookRelay = {
  connected: () => false,
  setEnabled: () => {},
  setAccountActive: () => {},
  refresh: () => {},
  registerRoute: () => Effect.fail({ cause: new Error("This server has no webhook relay.") }),
  revokeRoute: () => Effect.void,
};
const DIRECT_DEVICES_FILE = "tommy-devices-v1.json";
const DIRECT_PAIRED_SERVER_FILE = "tommy-paired-server-v1.bin";
/** The port that the reverse proxy forwards to on loopback. */
const DEFAULT_DIRECT_PORT = 8790;
/** A server has one owner and no account service. This user owns its host and its agents. */
const SERVER_LOCAL_OWNER: CentralAuthUser = {
  id: "local-owner",
  email: "owner@tommy.invalid",
  name: "Owner",
  avatarUrl: null,
};

function readDirectPort(value: string | undefined): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_DIRECT_PORT;
}

/** The HTTPS origin that devices use. Anything else reads as none, and `tommy pair` says so. */
function readDirectPublicUrl(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}
const REMOTE_SESSIONS_FILE = "tommy-remote-sessions-v1.bin";
const PROVIDER_CREDENTIAL_FILE = "tommy-provider-credentials-v1.json";
/** The MCP sign-ins. Separate from the keys above: a key is typed by the user, a token is not. */
const MCP_OAUTH_FILE = "tommy-mcp-oauth-v1.json";
const MCP_OAUTH_PROXY_FILE = "tommy-mcp-oauth-proxy-v1.json";
/** The one GitHub sign-in of this computer, with the same cipher as the MCP sign-ins. */
/** The logins, payment cards and contact info of the Vault in Server settings, with the same cipher. */
const VAULT_FILE = "tommy-vault-v1.json";
/** The Firebase key of this server. It is in the home folder of the service, and no backup or export reads it. */
const FCM_SERVICE_ACCOUNT_FILE = "fcm-service-account.json";
/** The APNs key of this server, beside the Firebase key. No backup or export reads it. */
const APNS_KEY_FILE = "apns-key.json";
const CLIENT_SCRATCH_FOLDER = "client-scratch";

const TEARDOWN_ORDER = {
  // First, so a process that the teardown ends does not count as a crash.
  resourceMonitor: 9,
  updater: 10,
  idleRestart: 11,
  hostUpdateCoordinator: 12,
  requestedUpdate: 13,
  hostedServerStartRetry: 14,
  launchPublishRetry: 14.5,
  hostedServerActivity: 15,
  serverMemory: 16,
  serverMode: 17,
  dynamicIsland: 20,
  machineAlerts: 21,
  themePalettes: 22,
  // Before the browser, so no sign-in opens a tab while it stops.
  providerAccountsHost: 27,
  providerHostSignIns: 28,
  mcpHostSignIns: 29,
  browser: 30,
  browserPictureInPicture: 40,
  localSignIn: 41,
  browserDock: 42,
  browserView: 45,
  providerRuntimes: 50,
  /** Before the remote servers: each child detaches from its entry when it stops. */
  localServers: 57,
  remoteServers: 60,
  voice: 70,
  speech: 71,
  remoteDesktop: 80,
  // Before messaging, so no routine answer starts a post while the connections stop.
  routineResults: 84,
  // Before the host and the service: no new external message arrives while they stop.
  messaging: 85,
  hostEvents: 85.5,
  // After the connections that hold it.
  signalIngress: 86,
  host: 90,
  // Before the agent service, so no handoff is sent to an agent while the service stops.
  routineFlows: 103,
  // Before the agent service, so no workflow step is sent to an agent while the service stops.
  workflows: 103.5,
  // Before the agent service, so no calendar read finds it stopping.
  routineFeed: 104,
  mcpOAuthRedirect: 105,
  // Before the agent service. It holds no file an agent reads; only a CLI run that waits is stopped.
  // Before the agent service, so no agent is handed a token file that is being removed.
  githubConnector: 107,
  // Before the agent service, so no payment wait outlives the agents that asked for it.
  linkAccount: 107.5,
  // Before the agent service, so no script starts a run while the service stops.
  automation: 108,
  storageUsage: 109,
  service: 110,
  mcpOAuth: 111,
  // After all account consumers have stopped.
  // After the service, so the turns that end while the services stop are still written.
  trace: 120,
  // After the service, so the lines its providers write while they stop are kept.
  providerLog: 121,
  // After the service, so a deletion that fails while the service stops is kept.
  agentLog: 122,
  // After the account, so a session write that fails while it stops is kept.
  accountLog: 123,
  // Last: every step above can still write.
  database: 130,
} as const;

export interface ApplicationServiceContext {
  /**
   * The window that exists now, by value. Anything that must survive a macOS close-and-rebuild
   * reads `windows.getMainWindow()` instead - the two type-check identically, so only the call
   * site says which one is correct.
   */
  mainWindow: BrowserWindow;
  windows: MainWindowController;
  appIconPath: string;
  appVariant: AppVariant;
  /** Set only in a self-hosted server that `install-server.sh` installed. */
  serverMode: ServerModeEnvironment | null;
  macHapticFeedback: MacHapticFeedback;
  teardown: TeardownRegistry;
  forwardCentralAuth: (state: CentralAuthState) => void;
  forwardBrowserDisplayState: (serverId: string, state: BrowserDisplayState) => void;
  forwardProviderRuntimeStatus: (snapshot: ProviderRuntimeSnapshot) => void;
  forwardWorkflowNotice: (notice: WorkflowNotice) => void;
  /** True once a quit starts, also before this function returns. See `CuaDriverRuntimeOptions.quitting`. */
  quitting: () => boolean;
}

/** Everything the entry point wires up, registers IPC handlers against, and shuts down. */
export interface ApplicationServices {
  service: AgentService;
  routineFlows: RoutineFlowsHandle;
  workflows: WorkflowsHandle;
  routineResults: RoutineResultsHandle;
  providerRuntimes: ProviderRuntimeManager;
  providerCredentials: ProviderCredentialStore;
  /** The WebRTC peers of this host and of its joined servers. */
  pairedServer: DirectPairedServer;
  /** Reached by the entry point for one thing only: handing a returning grant to its sign-in. */
  mcpOAuth: McpOAuth;
  /** The sign-ins of joined servers that wait in this computer's browser, and the callbacks they take. */
  signInRelayClient: SignInRelayClient;
  vault: VaultService;
  mailbox: MailboxStore;
  storageUsage: StorageUsageService;
  browser: BrowserHost;
  browserPictureInPicture: BrowserPictureInPicture;
  localSignIn: LocalSignInWindows;
  browserDock: BrowserDockOverlay;
  browserView: BrowserViewClient;
  setupFile: string;
  approvalAutomation: ApprovalAutomation;
  agentAdminSettings: AgentAdminSettingsService;
  agentHostSettings: AgentHostSettingsService;
  /** The folders each agent can change besides its workspace, for the desktop settings and `agent-folders-v1`. */
  agentFolders: AgentFolders;
  /** The instruction file of each agent, for the desktop page and `agent-instructions-v1`. */
  agentInstructions: AgentInstructionsFiles;
  browserProfiles: BrowserProfileService;
  language: LanguageService;
  appearance: AppearanceService;
  interfaceSize: InterfaceSizeService;
  notificationPreference: NotificationPreferenceStore;
  busyMessageMode: BusyMessageModePreferenceStore;
  agentDefaults: AgentDefaultsPreferenceStore;
  agentMemoryLimit: AgentMemoryLimitSetting;
  memoryReview: MemoryReviewPreferenceStore;
  agentNotificationLevels: AgentNotificationLevelStore;
  sidebarPins: SidebarPinStore;
  agentAccess: AgentAccessStore;
  serverAudit: ServerAuditStore;
  serverTimezone: ServerTimezonePreferenceStore;
  promptCacheTtl: PromptCacheTtlPreferenceStore;
  remoteSessionReuse: RemoteSessionReusePreferenceStore;
  externalLinkPreference: ExternalLinkPreferenceStore;
  externalLinks: ExternalLinkOpener;
  /** Opens a web page in the program that the user chose in Settings. */
  openLink: (url: string) => Promise<void>;
  remoteNetworkRoute: RemoteNetworkRoutePreferenceStore;
  remoteSessionCache: RemoteSessionCache;
  appBehavior: AppBehaviorService;
  agentInitialization: AgentInitializationGate<AgentLifecycleFailed>;
  sidebarLayout: SidebarLayoutStore;
  host: HostService;
  remoteServers: RemoteServerManager;
  centralAuth: LocalAccount;
  skills: SkillMarketplaceService;
  routineFeed: RoutineFeedServer;
  events: HostEventsService;
  eventsRuntime: HostEventsRuntime;
  /** The terminal control of a self-hosted server. Null in every other build. */
  serverMode: ServerMode | null;
  instanceTransfer: InstanceTransferService;
  dynamicIsland: DynamicIslandWindowController;
  trace: TraceFile;
  resourceMonitor: ResourceMonitor;
  machineAlerts: MachineAlertMonitor;
  teamStore: TeamStore;
  /**
   * The account state this function read part-way through, and bound the local host to. The
   * entry point compares it against the current state to find an account that settled after
   * that read, while `forwardCentralAuth` still had no services to apply it to.
   */
  appliedAccount: CentralAuthState;
  /** Left un-awaited on purpose: the account settles in the background while the app opens. */
  centralAuthInitialization: Effect.Effect<CentralAuthState, RemoteWorkflowError>;
}

/** How the driver's own state reads as the capability the Team API projects. */
/** The Electron secret storage cipher that every encrypted file in userData uses. */
function safeStorageCipher(
  unavailableKey: "error.app.secretStorageUnavailable" | "error.app.macSecureStorageUnavailable",
) {
  return {
    canPersist: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value: string) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error(sourceText(unavailableKey));
      return safeStorage.encryptString(value);
    },
    decrypt: (value: Buffer) => safeStorage.decryptString(value),
  };
}

/** What the account service did. Tommy has none, and one owner. */
export async function createApplicationServices({
  mainWindow,
  windows,
  appIconPath,
  appVariant,
  serverMode: serverModeEnvironment,
  macHapticFeedback,
  teardown,
  forwardCentralAuth,
  forwardBrowserDisplayState,
  forwardProviderRuntimeStatus,
  forwardWorkflowNotice,
}: ApplicationServiceContext): Promise<ApplicationServices> {
  // First, so the provider lines of the whole startup reach the file.
  teardown.push(
    TEARDOWN_ORDER.providerLog,
    "the provider log",
    startProviderLog(join(app.getPath("userData"), "logs")),
  );
  teardown.push(TEARDOWN_ORDER.agentLog, "the agent log", startAgentLog(join(app.getPath("userData"), "logs")));
  teardown.push(TEARDOWN_ORDER.accountLog, "the account log", startAccountLog(join(app.getPath("userData"), "logs")));
  const externalLinkPreference = createExternalLinkPreferenceStore(
    join(app.getPath("userData"), EXTERNAL_LINK_PREFERENCE_FILE),
  );
  // The store loads below with the other preferences. Until then, a page opens in the default browser.
  const externalLinks = new ExternalLinkOpener({
    preference: externalLinkPreference,
    platform: process.platform,
    openDefault: (url) => shell.openExternal(url),
    // The user clicked the link in the focused window, which can be a chat window.
    onFallback: (fallback) =>
      sendToRenderer(
        BrowserWindow.getFocusedWindow() ?? windows.getMainWindow(),
        IPC_ENDPOINTS.app.externalLinkFallback,
        fallback,
      ),
  });
  const openLink = (url: string) => runCauseEffect(externalLinks.open(url));
  // The one forward reference left in this function: the controller is built at the top of
  // startup because its window must be able to appear immediately, but the two services its
  // critical actions drive are built hundreds of lines below. A single named local rather than
  // two lazy getters, so the gap is visible and bounded.
  let criticalActionTargets: { agents: AgentService; host: HostService; remoteServers: RemoteServerManager } | null =
    null;
  const dynamicIsland = new DynamicIslandWindowController({
    platform: process.platform,
    preferencePath: join(app.getPath("userData"), DYNAMIC_ISLAND_PREFERENCE_FILE),
    createWindow: createDynamicIslandWindow,
    loadWindow: (window, display) => loadDynamicIslandRenderer(window, display, appVariant),
    getDisplays: () => screen.getAllDisplays(),
    getMainWindow: windows.getMainWindow,
    ensureMainWindow: windows.ensureMainWindow,
    presentMainWindow: showMainWindow,
    performHaptic: () => macHapticFeedback.performAlignment(),
    performCriticalAction: (action) =>
      Effect.suspend(() => {
        if (!criticalActionTargets) {
          return Effect.fail(new DynamicIslandFailed({ cause: new Error(sourceText("error.app.notReady")) }));
        }
        const { agents, host, remoteServers } = criticalActionTargets;
        return performDynamicIslandCriticalAction(
          action,
          agents,
          remoteServers,
          { decodeVoid, decodeQueuedMessageReceipt },
          () => host.conversationSender(),
        ).pipe(toDynamicIslandFailed);
      }),
  });
  teardown.push(TEARDOWN_ORDER.dynamicIsland, "the Dynamic Island", () => dynamicIsland.destroy());
  const pairedServer = new DirectPairedServer({
    path: join(app.getPath("userData"), DIRECT_PAIRED_SERVER_FILE),
    allowLoopbackHttp: !app.isPackaged,
    ...safeStorageCipher("error.app.macSecureStorageUnavailable"),
  });
  // Before the account starts: it reads the pairing to tell the window which screen to show.
  if (!serverModeEnvironment) await runCauseEffect(pairedServer.load());
  const centralAuth = new LocalAccount({
    owner: SERVER_LOCAL_OWNER,
    active: serverModeEnvironment ? () => true : () => pairedServer.paired,
  });
  centralAuth.on("changed", forwardCentralAuth);
  const centralAuthInitialization = Effect.runSync(Effect.cached(centralAuth.initialize()));
  void Effect.runPromise(centralAuthInitialization);
  // Before the agents load, so the first check of an agent that follows a default reads the saved one.
  const agentDefaults = createAgentDefaultsPreferenceStore(
    join(app.getPath("userData"), AGENT_DEFAULTS_PREFERENCE_FILE),
  );
  await runCauseEffect(agentDefaults.load());
  // A client has no agents and no chats: they all stay on the server. Its local store is scratch
  // space for the shared main process code. It is new at each start and it never touches ~/Tommy.
  const storeRoot = serverModeEnvironment
    ? app.getPath("userData")
    : join(app.getPath("userData"), CLIENT_SCRATCH_FOLDER);
  if (!serverModeEnvironment) await rm(storeRoot, { recursive: true, force: true });
  const store = new AgentStore(
    storeRoot,
    homedir(),
    new TommyDatabase(storeRoot),
    () => agentDefaults.get(),
    ...(serverModeEnvironment ? [] : [join(storeRoot, "Tommy")]),
  );
  // Phase marks for `dev:bench`, so a slow start shows which group of awaits it waited on. They
  // change nothing.
  performance.mark("tommy:services.pre-store");
  await runCauseEffect(store.initialize());
  performance.mark("tommy:services.store");
  // Closing copies the write-ahead log into the database file and removes it. A step that passed its
  // limit, such as a slow agent stop, still writes, so the close waits a short time for it.
  teardown.push(TEARDOWN_ORDER.database, "the database", () => store.database.close(), { afterAbandonedSteps: true });
  const skillCreator = new ManagedSkillService(
    app.isPackaged
      ? join(process.resourcesPath, "managed-skills", "tommy-skill-creator", "SKILL.md")
      : resolve(__dirname, "../../resources/managed-skills/tommy-skill-creator/SKILL.md"),
    undefined,
    undefined,
    SKILL_CREATOR_SKILL_SLUG,
  );
  const dataSkill = new ManagedSkillService(
    app.isPackaged
      ? join(process.resourcesPath, "managed-skills", "tommy-data", "SKILL.md")
      : resolve(__dirname, "../../resources/managed-skills/tommy-data/SKILL.md"),
    undefined,
    undefined,
    DATA_SKILL_SLUG,
  );
  await Effect.runPromise(retireManagedSkills(store.list()));
  await Effect.runPromise(skillCreator.syncAll(store.list()));
  await Effect.runPromise(dataSkill.syncAll(store.list()));
  performance.mark("tommy:services.skills");
  const sidebarLayout = new SidebarLayoutStore(join(app.getPath("userData"), SIDEBAR_LAYOUT_FILE));
  await runCauseEffect(sidebarLayout.initialize());
  const mailbox = new MailboxStore(app.getPath("userData"), store.sharedRoot, store.database);
  await runCauseEffect(mailbox.initialize());
  configureApplicationProtocol();
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  // Only a hosted, self-hosted or container server: one unit or container holds Tommy and every
  // agent process. The desktop app does not hold turns for memory.
  const hostMemory = serverModeEnvironment
    ? new ServerMemory({
        hostedPlan: false,
        onError: (message, error) => logger.warn(message, toLogValue(error)),
        onAgentProcessStopped: (stopped) =>
          logger.warn("Stopped a leftover agent process to free memory.", { ...stopped }),
      })
    : null;
  // Every provider process on a server gets the marker of leftover agent processes and the CPU limit
  // module for Node. The module must exist: Node does not start when a `--require` file is missing.
  // On the desktop it gets the marker only, so Settings › Agents can list what agents left running.
  const cpuLimitModule = app.isPackaged
    ? join(process.resourcesPath, "agent-runtime", "cpu-limit.cjs")
    : resolve(__dirname, "../../resources/agent-runtime/cpu-limit.cjs");
  const serverEnvironment = hostMemory
    ? agentProcessEnvironment(existsSync(cpuLimitModule) ? cpuLimitModule : null)
    : { [AGENT_PROCESS_VARIABLE]: "1" };
  if (hostMemory) {
    hostMemory.start();
    teardown.push(TEARDOWN_ORDER.serverMemory, "the server memory reading", () => Effect.runPromise(hostMemory.stop()));
  }
  const browserProfileStore = new BrowserProfileStore(store.database);
  const browser = new BrowserHost(mainWindow, store.downloadsRoot, join(app.getPath("userData"), BROWSER_STATE_FILE), {
    memoryLow: () => (hostMemory?.level() ?? "ok") !== "ok",
    browserProfile: (agentId) => {
      const agent = store.list().find((candidate) => candidate.id === agentId);
      return agent ? agentBrowserProfile(agent) : { kind: "shared" };
    },
    profileExists: (profileId) => browserProfileStore.get(profileId) !== undefined,
    quitShortcut: (input) => windows.handleQuitShortcut(mainWindow, input),
  });
  teardown.push(TEARDOWN_ORDER.browser, "the browser", () => runCauseEffect(browser.destroy()));
  await runCauseEffect(browser.restore(store.list().map((agent) => ({ id: agent.id, threadId: agent.threadId }))));
  performance.mark("tommy:services.browser");
  const browserPictureInPicture = new BrowserPictureInPicture({
    // A value, deliberately: the window this is docked to is the one that exists now. The event
    // callback below is the opposite case and re-reads, because it fires long after a macOS window
    // close and rebuild would have made this reference stale.
    mainWindow,
    browser,
    preloadPath: join(__dirname, "../preload/index.cjs"),
    iconPath: appIconPath,
    ...(developmentUrl === undefined ? {} : { developmentUrl }),
    onEvent: (event) => {
      const window = windows.getMainWindow();
      if (!window || window.isDestroyed()) return;
      sendToRenderer(window, IPC_ENDPOINTS.browser.pictureInPictureEvent, event);
    },
  });
  teardown.push(TEARDOWN_ORDER.browserPictureInPicture, "picture in picture", () => browserPictureInPicture.destroy());
  const localSignIn = new LocalSignInWindows();
  teardown.push(TEARDOWN_ORDER.localSignIn, "the local sign-in window", () => Effect.runPromise(localSignIn.discard()));
  // A value, as for Picture in Picture: the overlay is a view in the window that the browser shows its pages in.
  const browserDock = new BrowserDockOverlay({
    mainWindow,
    preloadPath: join(__dirname, "../preload/index.cjs"),
    load: loadBrowserDockRenderer,
    forwardShortcut: (input) => windows.handleQuitShortcut(mainWindow, input) || browser.forwardDockShortcut(input),
  });
  browser.setMainPageListener((page) => browserDock.setPage(page));
  teardown.push(TEARDOWN_ORDER.browserDock, "the browser dock", () => {
    browser.setMainPageListener(null);
    browserDock.destroy();
  });
  browser.onChanged((tabs, activeTabId) => forwardBrowserDisplayState(LOCAL_SERVER_ID, { tabs, activeTabId }));
  const setupFile = join(app.getPath("userData"), SETUP_FILE);
  const routineHoldFile = join(app.getPath("userData"), ROUTINE_HOLD_FILE);
  const setupState = await runCauseEffect(readSetupState(setupFile));
  // Loaded before the first window and before the application menu is built, so every native
  // surface draws in the saved language on the first frame rather than switching after startup.
  const language = new LanguageService({
    path: join(app.getPath("userData"), LANGUAGE_PREFERENCE_FILE),
    systemLocale: app.getLocale(),
  });
  await runCauseEffect(language.load());
  // Before the renderer loads, so the window background takes the saved colors.
  const appearance = new AppearanceService({
    path: join(app.getPath("userData"), APPEARANCE_PREFERENCE_FILE),
    paletteDirectory: join(app.getPath("userData"), THEME_PALETTE_DIRECTORY),
    supportsTransparentWindow: process.platform === "darwin",
  });
  await runCauseEffect(appearance.load());
  teardown.push(
    TEARDOWN_ORDER.themePalettes,
    "the theme palette watch",
    await Effect.runPromise(appearance.followPalettes()),
  );
  // Before the renderer loads, so its first navigation applies the saved size.
  const interfaceSize = new InterfaceSizeService({
    path: join(app.getPath("userData"), INTERFACE_SIZE_PREFERENCE_FILE),
  });
  await runCauseEffect(interfaceSize.load());
  const notificationPreference = new NotificationPreferenceStore(
    join(app.getPath("userData"), NOTIFICATION_PREFERENCE_FILE),
  );
  await runCauseEffect(notificationPreference.load());
  const busyMessageMode = new BusyMessageModePreferenceStore(
    join(app.getPath("userData"), BUSY_MESSAGE_MODE_PREFERENCE_FILE),
  );
  await runCauseEffect(busyMessageMode.load());
  const agentMemoryLimit = new AgentMemoryLimitPreferenceStore(
    join(app.getPath("userData"), AGENT_MEMORY_LIMIT_PREFERENCE_FILE),
  );
  await runCauseEffect(agentMemoryLimit.load());
  const memoryReview = new MemoryReviewPreferenceStore(join(app.getPath("userData"), MEMORY_REVIEW_PREFERENCE_FILE));
  const agentNotificationLevels = new AgentNotificationLevelStore(
    join(app.getPath("userData"), AGENT_NOTIFICATION_LEVELS_FILE),
  );
  await runCauseEffect(agentNotificationLevels.load());
  const sidebarPins = new SidebarPinStore(join(app.getPath("userData"), SIDEBAR_PINS_FILE));
  await runCauseEffect(sidebarPins.load());
  await runCauseEffect(memoryReview.load());
  const serverAudit = new ServerAuditStore(join(app.getPath("userData"), SERVER_AUDIT_FILE));
  await runCauseEffect(serverAudit.load());
  const agentAccess = new AgentAccessStore(join(app.getPath("userData"), AGENT_ACCESS_FILE), {
    // Called only on a save, after `service` and `teamStore` exist.
    audit: (serverId, before, after, actor) =>
      serverAudit.recordAgentAccess(serverId, actor, before, after, () =>
        serverAuditNames(teamStore.configured ? teamStore.listMembers() : [], service.listAgents()),
      ),
  });
  if (!(await runCauseEffect(agentAccess.load())))
    logger.warn("The roles file did not load. Members get no access to agents until an admin saves the roles.");
  const serverTimezone = new ServerTimezonePreferenceStore(
    join(app.getPath("userData"), SERVER_TIMEZONE_PREFERENCE_FILE),
  );
  await runCauseEffect(serverTimezone.load());
  const promptCacheTtl = new PromptCacheTtlPreferenceStore(
    join(app.getPath("userData"), PROMPT_CACHE_TTL_PREFERENCE_FILE),
  );
  await runCauseEffect(promptCacheTtl.load());
  const remoteSessionReuse = createRemoteSessionReusePreferenceStore(
    join(app.getPath("userData"), REMOTE_SESSION_REUSE_PREFERENCE_FILE),
  );
  await runCauseEffect(remoteSessionReuse.load());
  await runCauseEffect(externalLinkPreference.load());
  const remoteNetworkRoute = createRemoteNetworkRoutePreferenceStore(
    join(app.getPath("userData"), REMOTE_NETWORK_ROUTE_PREFERENCE_FILE),
  );
  await runCauseEffect(remoteNetworkRoute.load());
  const appBehavior = new AppBehaviorService({
    path: join(app.getPath("userData"), APP_BEHAVIOR_PREFERENCE_FILE),
    loginItem: createLoginItem({
      appVariant,
      server: Boolean(serverModeEnvironment),
    }),
    offersBackground: !serverModeEnvironment,
    menuBar: process.platform === "darwin",
    offersKeepAwake: process.platform !== "linux" && !serverModeEnvironment,
  });
  await runCauseEffect(appBehavior.load());
  void Effect.runPromise(appBehavior.refreshLoginItem()).catch((error) =>
    logger.warn("The login item did not refresh.", toLogValue(error)),
  );
  const remoteSessionCache = new RemoteSessionCache({
    path: join(app.getPath("userData"), REMOTE_SESSIONS_FILE),
    enabled: remoteSessionReuse.get().keepBetweenRuns,
    ...safeStorageCipher("error.app.macSecureStorageUnavailable"),
  });
  // A kept session is useless without an account, and it names the last one. The listener also
  // covers a sign-out that settles before the remote services exist.
  const forgetSignedOutSessions = (state: CentralAuthState) => {
    if (state.status === "signed_out") void Effect.runPromise(remoteSessionCache.clear());
  };
  forgetSignedOutSessions(centralAuth.getState());
  centralAuth.on("changed", forgetSignedOutSessions);
  const approvalAutomationFile = join(app.getPath("userData"), APPROVAL_AUTOMATION_FILE);
  const approvalAutomation = new ApprovalAutomation({
    path: approvalAutomationFile,
    initial: await runCauseEffect(
      readApprovalAutomation(
        approvalAutomationFile,
        store.list().map((agent) => agent.id),
        [V2_APPROVAL_AUTOMATION_FILE, LEGACY_APPROVAL_AUTOMATION_FILE].map((file) =>
          join(app.getPath("userData"), file),
        ),
      ),
    ),
    knownAgentIds: () => store.list().map((agent) => agent.id),
  });
  /*
   * The installed CLIs are the computer's, the partial downloads are this profile's.
   *
   * Development gives every renderer port and every `--isolated` worktree a `userData` of its own,
   * so a store kept there started empty each time: Tommy fell back to the user's own CLI, offered
   * the pinned version against it, and downloaded 144 MB again for a profile that would be replaced
   * by the next port. The packaged app's `userData` is `appData/Tommy` already, so the shared
   * store is the path it always used. The switch is read here rather than imported from the entry
   * point, which this file may not reach into; both readers read the same immutable value.
   */
  const providerUse = new ProviderUseSettingsStore(join(app.getPath("userData"), "tommy-provider-use-v1.json"));
  await runCauseEffect(providerUse.load());
  const providerAccounts = new ProviderAccountStore(
    join(app.getPath("userData"), "tommy-provider-accounts-v1.json"),
    join(app.getPath("userData"), "provider-accounts"),
  );
  await runCauseEffect(providerAccounts.load());
  const providerCliAppVersion = createProviderCliAppVersionStore(
    join(app.getPath("userData"), PROVIDER_CLI_APP_VERSION_FILE),
  );
  await runCauseEffect(providerCliAppVersion.load());
  const providerRuntimesRoot = providerRuntimeRoot({
    appData: app.getPath("appData"),
    userDataOverride: app.commandLine.getSwitchValue("user-data-dir"),
  });
  const providerRuntimes = new ProviderRuntimeManager({
    // Only the server runs provider CLIs. This computer only controls it.
    isProviderOn: (provider) => serverModeEnvironment !== null && !providerUse.off().includes(provider),
    root: providerRuntimesRoot,
    downloadRoot: join(app.getPath("userData"), "provider-runtimes", ".downloads"),
    updateRuntime: (runtime, install, signal, onWait) => {
      if (isManagedToolRuntime(runtime)) return install().pipe(Effect.asVoid);
      return service
        .updateProviderCli(
          runtime,
          () =>
            install().pipe(
              Effect.mapError(
                (error) => new AgentLifecycleFailed({ operation: "updateProviderCli.install", cause: error.cause }),
              ),
            ),
          signal,
          onWait,
        )
        .pipe(Effect.asVoid, toProviderRuntimeFailure);
    },
  });
  teardown.push(TEARDOWN_ORDER.providerRuntimes, "the provider runtimes", () =>
    runCauseEffect(providerRuntimes.stop()),
  );
  // Before `new AgentService`, which reads every `executablePath` eagerly.
  await runCauseEffect(providerRuntimes.initialize());
  const secretCipher = safeStorageCipher("error.app.secretStorageUnavailable");
  /*
   * Loaded before the service, not on first use: a provider spawn reads its key synchronously, so
   * the decrypted map has to already exist by the time any client is built. A machine with no
   * secret storage keeps working on the free tier -- only saving a key needs the cipher.
   */
  const providerCredentials = new ProviderCredentialStore(
    join(app.getPath("userData"), PROVIDER_CREDENTIAL_FILE),
    secretCipher,
  );
  // An unreadable key file is reported, not fatal: the app starts, OpenCode runs on the free models,
  // and Settings tells the user to save the key again. Only the error's class is logged, because a
  // parse message quotes the file.
  performance.mark("tommy:services.provider-detection");
  const credentialLoadError = await Effect.runPromise(providerCredentials.load());
  if (credentialLoadError) {
    logger.warn(`Tommy could not read the provider key file (${credentialLoadError.name}). It was left unchanged.`);
  }
  /*
   * The MCP sign-ins, in their own file with the same cipher. `mcp-remote` used to keep these where
   * Tommy could not redact them; here they are covered by the same rule as every other secret.
   *
   * Unreadable is not fatal, for the same reason as the keys above: every signed-in server asks for
   * a sign-in again, and nothing else on this machine stops working.
   */
  const mcpOAuthStore = new McpOAuthStore(join(app.getPath("userData"), MCP_OAUTH_FILE), secretCipher);
  const mcpOAuthLoadError = await Effect.runPromise(mcpOAuthStore.load());
  if (mcpOAuthLoadError) {
    logger.warn(`Tommy could not read the MCP sign-in file (${mcpOAuthLoadError.name}). It was left unchanged.`);
  }
  // The OAuth proxy port, so a Codex session resumed after a restart reaches the same address.
  const mcpOAuthProxySettings = new McpOAuthProxySettingsFile(
    join(app.getPath("userData"), MCP_OAUTH_PROXY_FILE),
    secretCipher,
  );
  const mcpOAuthProxyLoadError = await Effect.runPromise(mcpOAuthProxySettings.load());
  if (mcpOAuthProxyLoadError) {
    logger.warn(
      `Tommy could not read the MCP sign-in proxy file (${mcpOAuthProxyLoadError.name}). A new port is used.`,
    );
  }
  /*
   * Where a returning grant lands. The loopback listener is the address RFC 8252 gives a native
   * app and the only one some authorization servers accept - Canva refuses `tommy://mcp-auth`
   * on its own authorization page, where Tommy cannot see the failure or explain it.
   *
   * A port that cannot be bound is not fatal: the deep link is still registered with the
   * operating system, and the servers that accept it keep working. It is logged because it
   * decides which address every later sign-in registers, and a sign-in that a server then
   * refuses is otherwise a mystery in a support thread.
   */
  // The listener is bound before the authority that answers it exists, and a request can arrive
  // in between - a browser tab left open on a previous run reaches this port on its own. It is
  // held rather than closed over, so that request is refused instead of raising in the listener.
  let mcpOAuthAuthority: McpOAuth | null = null;
  // A joined server's sign-in can send its callback to this same port: the host's own listener
  // uses the same port number. A `state` that no local sign-in started goes to the relay.
  const signInRelayClient = new SignInRelayClient({
    openExternal: openLink,
    language,
    ownListener: () =>
      mcpOAuthRedirect
        ? { port: Number(new URL(mcpOAuthRedirect.redirectUrl).port), path: MCP_OAUTH_REDIRECT_PATH }
        : null,
  });
  performance.mark("tommy:services.mcp-sign-in-file");
  const mcpOAuthRedirect = await startMcpOAuthRedirectServer({
    language,
    preferredPort: MCP_OAUTH_REDIRECT_PORT,
    deliver: (state, code, query) => {
      const elsewhere = mcpOAuthAuthority?.openedElsewhere(state) ?? false;
      if (!mcpOAuthAuthority?.receiveAuthorizationCode(state, code))
        return signInRelayClient.deliver(state, query) ? "relayed" : false;
      if (elsewhere) return true;
      const current = windows.getMainWindow();
      if (current && !current.isDestroyed()) showMainWindow(current);
      return true;
    },
    relayRefusal: (state, query) => {
      signInRelayClient.deliver(state, query);
    },
  }).catch((error: unknown) => {
    logger.warn(
      "Tommy could not listen for MCP sign-ins on this machine, so the tommy:// link is used instead. Servers that refuse it cannot be signed in to:",
      toLogValue(error),
    );
    return null;
  });
  if (mcpOAuthRedirect) {
    teardown.push(TEARDOWN_ORDER.mcpOAuthRedirect, "the MCP sign-in listener", () => mcpOAuthRedirect.close());
  }
  const mcpOAuth = new McpOAuth({
    storage: mcpOAuthStore,
    openExternal: openLink,
    redirectUrl: mcpOAuthRedirect?.redirectUrl ?? MCP_OAUTH_REDIRECT_URL,
    logger: createTommyLogger("mcp-oauth"),
  });
  mcpOAuthAuthority = mcpOAuth;
  teardown.push(TEARDOWN_ORDER.mcpOAuth, "MCP token refresh", () => Effect.runPromise(mcpOAuth.close()));
  /*
   * The Vault in Server settings. Every agent fills its logins, cards and contact info; the file
   * holds no resource, so nothing is torn down.
   */
  const vault = new VaultService({
    store: new VaultStore(join(app.getPath("userData"), VAULT_FILE), secretCipher),
    canPersist: secretCipher.canPersist,
  });
  await Effect.runPromise(vault.load());

  performance.mark("tommy:services.connectors");
  // Read by the resource monitor, which starts after the analytics that needs the services.
  const statementTimings = new StatementTimings();
  const tables = new AgentTables({
    sharedRoot: store.sharedRoot,
    supervisor: new AgentDatabaseSupervisor({
      spawnHost: spawnAgentDatabaseHost,
      onStatementSettled: (durationMs) => statementTimings.record(durationMs),
    }),
  });
  performance.mark("tommy:services.computer-use");
  // Outside every workspace. Each saved key is masked in the logs before the first agent starts. The
  // Vault's keys are written only when an agent lists its keys; a file left from the last run that the
  // Vault no longer holds is removed here.
  const agentApiKeys = new AgentApiKeys(join(app.getPath("userData"), "agent-api-keys"), () => vault.items.apiKeys());
  await Effect.runPromise(agentApiKeys.registerSaved());
  await Effect.runPromise(agentApiKeys.syncVault().pipe(Effect.ignore));
  // The schedule triggers of workflows share the routine timer; built after the workflows below.
  let workflowTriggers: WorkflowTriggers | null = null;
  // Before `new AgentService`, so the first provider session already has the driver's tools.
  const agentDesktop = new AgentDesktopRuntime({
    binary: resolveAgentDesktop({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      sourceRoot: resolve(__dirname, "../.."),
    }),
    agentEnvironment: agentDisplayEnvironment(process.platform),
    headed: hasSeparateAgentDisplay(process.platform),
  });
  await Effect.runPromise(agentDesktop.check());
  const service: AgentService = new AgentService({
    store,
    mailbox,
    browser,
    visualPreview: new ChatVisualPreviewer(),
    prepareMcpTest: (config) =>
      prepareToolRuntimeForTest(config, {
        startToolRuntimes: () => {
          Effect.runFork(providerRuntimes.ensureToolRuntimes());
        },
        ensureToolRuntimesReady: () => providerRuntimes.ensureToolRuntimesReady(),
        toolRuntimes: () => providerRuntimes.mcpToolRuntimes(),
      }),
    // `desktopCapturer` captures the display Tommy is on. With an agent display of its own, that
    // is only the Tommy window, so agents take their screenshots with the Computer Use driver.
    screenCapture: hasSeparateAgentDisplay(process.platform)
      ? null
      : new ScreenCapturer({
          platform: process.platform,
          screenAccess: () => systemPreferences.getMediaAccessStatus("screen"),
          displays: () => screen.getAllDisplays(),
          primaryDisplayId: () => screen.getPrimaryDisplay().id,
          getSources: (options) => desktopCapturer.getSources(options),
        }),
    hostMemory,
    requestTimeoutMs: 30_000,
    offProviders: serverModeEnvironment ? providerUse.off() : AGENT_PROVIDERS,
    providerAccounts,
    saveProviderUse: (provider, on) =>
      providerUse.set(provider, on).pipe(
        Effect.tap(() => providerRuntimes.providerUseChanged()),
        Effect.mapError((error) => new AgentLifecycleFailed({ operation: "saveProviderUse", cause: error.cause })),
      ),
    preferredProvider: setupState.preferredProvider ?? "codex",
    bundledExecutables: providerRuntimes.bundledExecutables(),
    prepareAgentWorkspace: (agent) =>
      Effect.gen(function* () {
        yield* skillCreator.syncAgent(agent);
        yield* dataSkill.syncAgent(agent);
      }),
    sidebarLayout,
    preferredModel: setupState.preferredModel,
    // Only a dev build leads with the OpenCode development model; a packaged app keeps the
    // built-in default.
    developmentDefaults: appVariant === "dev",
    credentials: {
      apiKey: (provider) => providerCredentials.get(provider),
      // Read at each Claude spawn, so a change from Server settings applies to the next process.
      promptCacheTtl: () => promptCacheTtl.get().ttl,
      // The enabled MCP servers, read at each spawn. The service owns the store, so this reads back
      // into the object being constructed; nothing calls it before the constructor returns.
      mcpServers: () => service.enabledMcpServers(),
      // The floor under those servers: the `bin` of every managed tool runtime, appended after the
      // user's own `PATH`, so a machine with no Node can still start `npx some-server` and a machine
      // that has one keeps the build it installed.
      mcpToolRuntimes: () => providerRuntimes.mcpToolRuntimes(),
      // The sign-ins of the http servers. The service hands a provider a route of its OAuth proxy,
      // never the token; only a test the user pressed may open a browser.
      mcpOAuth,
      mcpOAuthProxySettings,
      appVersion: app.getVersion(),
      providerStateDirectory: join(app.getPath("userData"), "provider-state"),
      serverEnvironment,
      // On a server with an agent display, `DISPLAY` names it, so a program an agent starts opens where
      // the driver sees it.
      agentEnvironment: () => agentDisplayEnvironment(process.platform),
    },
    // Appended to the stored servers at each spawn, so the same tools reach Codex, Claude and the
    // ACP providers. Null until the driver answers, which is what keeps a machine with no driver
    // from handing every provider a command it cannot start.
    computerUseMcpServer: () => agentDesktop.mcpServerConfig(),
    passwordVault: passwordVaultRouter([
      { prefix: "", vault: new OnePasswordCliVault(process.env.OP_SERVICE_ACCOUNT_TOKEN) },
      { prefix: "tommy:", vault: vault.logins },
    ]),
    vaultItems: vault.items,
    agentApiKeys,
    localSkillTools: () => localSkillTools(skills),
    routineFlowTools: () => routineFlowRuntime,
    // `events` is built later, after the account service and the relay.
    webhookRoutines: () => agentWebhookRoutineWriter(events),
    approvalAutomation,
    busyMessageMode: () => busyMessageMode.get().mode,
    agentMemoryLimit: () => agentMemoryLimit.get().limit,
    memoryReviewInterval: () => memoryReview.get().interval,
    timezone: () => serverTimezone.effective(),
    // `workflowTriggers` is built later, after the workflows.
    extraRoutineSources: () => (workflowTriggers ? [workflowTriggers] : []),
    // `host` is built later, after the agent service; a channel tool reads it when it runs.
    channelPersonAgentLevel: (personId, agentId) => host.channelPersonAgentLevel(personId, agentId),
    channelRemotePerson: (personId) => host.channelPersonIsRemote(personId),
    // The delete also clears the agent from workflow nodes, so the editors of those workflows load
    // the new graph. `workflowStore` is built later, after the agent service.
    deleteWithRevokedApproval: (agentId, remove) =>
      Effect.suspend(() => {
        const workflowIds = workflowStore.workflowsOfAgent(agentId);
        return approvalAutomation.deleteAgent(agentId, remove).pipe(
          toAgentRemovalFailed,
          Effect.tap(() =>
            Effect.sync(() => {
              for (const workflowId of workflowIds) service.notifyWorkflowsChanged(workflowId);
            }),
          ),
        );
      }),
    tables,
  });
  service.setComputerUseCapability(agentDesktop.capability());
  teardown.push(TEARDOWN_ORDER.service, "the agent service", () => runCauseEffect(service.stop()));
  const agentMemoryLimitSetting = reloadingAgentMemoryLimit(agentMemoryLimit, service);
  /** The answer an agent gave in one turn, for routine flows, routine results and local scripts. */
  const turnAnswer = (agentId: string, turnId: string): string | null => {
    const threadId = store.list().find((agent) => agent.id === agentId)?.threadId;
    if (!threadId) return null;
    return latestTurnAnswer(store.database.readTurnAssistantMessages(agentId, threadId, turnId), turnId)?.text ?? null;
  };
  // Listens only while an agent allows local scripts; see `AutomationServer`.
  const automation = new AutomationServer({
    root: store.automationRoot,
    listAgents: () => service.listAgents(),
    agentDefaults: () => agentDefaults.get(),
    listModels: () => service.listModels(),
    listRoutines: (agentId) => service.listRoutines(agentId),
    runRoutine: (input) => service.runRoutineFromAutomation(input),
    sendMessage: (input) => service.sendMessage(input),
    getLocalAttention: (agentId) => service.getLocalAttention(agentId),
    respondToLocalAttention: (agentId, input) => service.respondToLocalAttention(agentId, input),
    delivery: (deliveryId) => mailbox.getDelivery(deliveryId)?.delivery ?? null,
    turnAnswer,
    updateAgent: (input) => service.updateAgent(input),
    clearAgentContext: (agentId) => service.clearAgentContext(agentId),
  });
  service.on("event", (event) => {
    if (event.type === "agents-changed") Effect.runFork(automation.requestSync());
  });
  teardown.push(TEARDOWN_ORDER.automation, "the automation server", () => Effect.runPromise(automation.stop()));
  // An agent routine's answer handed on from agent to agent; see `routine-flows.ts`.
  const routineFlowRuntime = await Effect.runPromise(
    createRoutineFlows({
      store: new RoutineFlowStore({ database: store.database }),
      routines: routineFlowRoutines(new AgentRoutineStore(store.database)),
      delivery: (deliveryId) => {
        const found = mailbox.getDelivery(deliveryId)?.delivery;
        return found ? { status: found.status, turnId: found.turnId, error: found.error } : null;
      },
      turnAnswer,
      agentName: (agentId) => store.list().find((agent) => agent.id === agentId)?.name ?? agentId,
      sendHandoff: (input) => service.enqueueRoutineHandoff(input),
      // An agent event, so this window, joined clients and the web app hear it the same way.
      changed: (agentIds) => {
        for (const agentId of agentIds) service.notifyRoutineFlowsChanged(agentId);
      },
    }),
  );
  teardown.push(TEARDOWN_ORDER.routineFlows, "the routine flows", () => Effect.runPromise(routineFlowRuntime.close()));
  // Graphs of steps drawn on a canvas; see `workflows.ts`.
  const workflowStore = new WorkflowStore({
    database: store.database,
    nextDueAt: workflowScheduleDueAt(() => serverTimezone.effective()),
  });
  const workflowRuntime = await Effect.runPromise(
    createWorkflows({
      store: workflowStore,
      runs: new WorkflowRunStore({ database: store.database }),
      github: new WorkflowGitHubStore({ database: store.database }),
      githubApp: () => null,
      connectionOn: () => false,
      post: () => Effect.succeed({ failure: "not-running" as const }),
      delivery: (deliveryId) => {
        const found = mailbox.getDelivery(deliveryId)?.delivery;
        return found ? { status: found.status, turnId: found.turnId, error: found.error } : null;
      },
      turnAnswer,
      // A workflow step is a routine handoff whose routine is the workflow.
      sendHandoff: (input) => service.enqueueRoutineHandoff(input),
      stopDelivery: (agentId, deliveryId) => {
        const found = mailbox.getDelivery(deliveryId)?.delivery;
        if (!found) return Effect.void;
        return found.status === "running" && found.turnId
          ? service.interrupt(agentId, found.turnId)
          : service.cancelQueuedMessage(agentId, deliveryId);
      },
      generateText: (request) =>
        service.generateWorkflowText(request).pipe(
          Effect.mapError((failure) => ({
            message: failure.cause instanceof Error ? failure.cause.message : sourceText("error.workflow.modelFailed"),
          })),
        ),
      notify: forwardWorkflowNotice,
      // An agent event, so this window, joined clients and the web app hear it the same way.
      changed: (workflowId) => service.notifyWorkflowsChanged(workflowId),
      rearm: () => service.armRoutines(),
      timezone: () => serverTimezone.effective(),
      runEnded: (end) => service.notifyWorkflowRunEnded(end),
    }),
  );
  workflowTriggers = new WorkflowTriggers({
    store: workflowStore,
    timezone: () => serverTimezone.effective(),
    start: (start) => workflowRuntime.startScheduled(start),
    changed: (workflowId) => service.notifyWorkflowsChanged(workflowId),
  });
  service.armRoutines();
  // An agent event too, so joined admins and the web app read the Vault again. It carries no item.
  vault.onChanged(() => service.notifyVaultChanged());
  // A changed or deleted Vault API key reaches the file that an agent reads at once.
  vault.onChanged(() => void Effect.runPromise(agentApiKeys.syncVault().pipe(Effect.ignore)));
  teardown.push(TEARDOWN_ORDER.workflows, "the workflows", () => {
    return Effect.runPromise(workflowRuntime.close());
  });
  // An agent routine's answer sent on to a messaging place; see `routine-results.ts`.
  const routineResultRuntime = await Effect.runPromise(
    createRoutineResults({
      store: new RoutineResultStore(store.database),
      delivery: (deliveryId) => {
        const found = mailbox.getDelivery(deliveryId)?.delivery;
        return found ? { turnId: found.turnId } : null;
      },
      turnAnswer,
      // Tommy has no messaging connection, so a saved destination reads as gone.
      connection: () => null,
      options: () => Effect.succeed([]),
      post: () => Effect.succeed({ failure: "gone" as const }),
      changed: (agentIds) => {
        for (const agentId of agentIds) service.notifyRoutineResultsChanged(agentId);
      },
    }),
  );
  service.on("event", (event) => {
    Effect.runFork(routineFlowRuntime.notice(event));
    Effect.runFork(routineResultRuntime.notice(event));
    Effect.runFork(workflowRuntime.notice(event));
  });
  teardown.push(TEARDOWN_ORDER.routineResults, "the routine results", () =>
    Effect.runPromise(routineResultRuntime.close()),
  );
  // Listens only after the user turns the feed on in Server Settings > Routines.
  const routineFeed = new RoutineFeedServer({
    path: join(app.getPath("userData"), ROUTINE_FEED_FILE),
    cipher: secretCipher,
    document: localRoutineFeedDocument(service, language.translate),
  });
  await Effect.runPromise(routineFeed.start());
  teardown.push(TEARDOWN_ORDER.routineFeed, "the routine feed", () => Effect.runPromise(routineFeed.stop()));
  // The host id is read when the Signal socket opens, and the team store is built further down, so
  // it starts as "no name yet".
  performance.mark("tommy:services.routines");
  /*
   * Where the decision put the download: onboarding, which is the screen this start is about to
   * show. A user who finished onboarding before Tommy downloaded a runtime at all is asked for
   * one here too, but only when this machine already has an MCP server to start.
   *
   * Nothing waits for it and nothing reports it. MCP is optional, so a failed download must not
   * reach onboarding; a server that cannot start is reported at hand-off like any other.
   */
  if (serverModeEnvironment && (!setupState.completed || service.enabledMcpServers().length > 0))
    Effect.runFork(providerRuntimes.ensureToolRuntimes());
  // After `new AgentService`, which owns the channels: the layout files channels beside agents, and
  // reconciling against the agents alone would read every channel as gone and drop where it sits.
  performance.mark("tommy:services.messaging");
  await runCauseEffect(sidebarLayout.reconcileAgents(service.sidebarChatIds()));

  /*
   * The runtime manager decides which provider has an update waiting, by comparing against the
   * latest upstream release. It knows the copies it downloaded itself; a CLI the user installed is
   * only ever reported in the agent status, so it is passed on from here. Its update offer installs
   * a managed copy and leaves the system installation untouched.
   */
  const trackSystemCliVersions = (status: AgentStatus): void => {
    let copyInUse = false;
    for (const provider of status.providers ?? []) {
      const version = provider.cliSource === "system" ? (provider.version ?? null) : null;
      if (isManagedRuntimeProvider(provider.id) && providerRuntimes.setSystemVersion(provider.id, version))
        copyInUse = true;
    }
    if (copyInUse) Effect.runFork(providerRuntimes.providerUseChanged());
  };
  trackSystemCliVersions(service.getStatus());
  service.on("event", (event) => {
    if (event.type === "status") trackSystemCliVersions(event.status);
  });
  providerRuntimes.on("status", forwardProviderRuntimeStatus);
  // After the status forward, so the offer a check finds reaches the renderer.
  const appUpgraded = providerCliAppVersion.get().appVersion !== app.getVersion();
  if (serverModeEnvironment) providerRuntimes.startUpdateChecks({ updateInstalled: appUpgraded });
  if (appUpgraded)
    void runCauseEffect(providerCliAppVersion.set({ appVersion: app.getVersion() })).catch((error) =>
      logger.warn("The provider CLI app version did not save.", toLogValue(error)),
    );
  // A tool runtime that becomes ready changes what the MCP servers resolve to, for every
  // provider: sessions that dropped their stdio servers before it finished downloading are
  // marked for refresh, and the deferred mechanism spends the mark before each agent's next
  // turn. Provider CLI updates change no MCP resolution, so only tool runtimes refresh.
  providerRuntimes.on("ready", (runtime) => {
    if (isManagedToolRuntime(runtime)) Effect.runFork(service.refreshAllAgentRuntimes());
  });
  const userData = app.getPath("userData");
  const storageSources = {
    roots: {
      database: store.database.path,
      downloads: store.downloadsRoot,
      caches: ["remote-attachments", "remote-shared-files", "remote-workspace-files"].map((name) =>
        join(userData, name),
      ),
      logs: [
        join(userData, "logs", "remote"),
        join(userData, "logs", "update"),
        join(userData, "logs", "providers"),
        join(userData, "logs", "agents"),
        join(userData, "logs", "main"),
      ],
      runtimes: providerRuntimesRoot,
      data: userData,
    },
    database: () => store.database.connection,
    mailbox,
    agents: () => service.listAgents(),
  };
  const storageUsage = new StorageUsageService(new StorageUsageScanner(storageSources), storageSources);
  teardown.push(TEARDOWN_ORDER.storageUsage, "storage scans", () => Effect.runPromise(storageUsage.dispose()));
  // A deleted or renamed agent changes every scope, so no surface keeps its old answer.
  service.on("event", (event) => {
    if (event.type === "agents-changed") storageUsage.invalidate();
  });
  // A grant changed on this computer must reach the phones and web clients that show it.
  approvalAutomation.subscribe(() => service.notifyAgentsChanged());
  const skills = new SkillMarketplaceService(
    () => service.listAgents(),
    // Every skill change ends here: install, update, uninstall, turning one on or off, and a skill
    // an agent creates. The event reaches this computer's windows and the joined clients.
    (agentId) =>
      service
        .refreshAgentRuntime(agentId)
        .pipe(Effect.ensuring(Effect.sync(() => service.notifySkillsChanged(agentId)))),
    new LocalSkillLibrary(join(app.getPath("userData"), "local-skills"), () => service.listAgents()),
  );

  const teamStore = new TeamStore(
    join(app.getPath("userData"), TEAM_FILE_V2),
    join(app.getPath("userData"), TEAM_FILE),
  );
  await runCauseEffect(teamStore.initialize());
  performance.mark("tommy:services.team");
  const machineAlertStore = new MachineAlertPreferenceStore(
    join(app.getPath("userData"), MACHINE_ALERTS_PREFERENCE_FILE),
  );
  await runCauseEffect(machineAlertStore.load());
  // The same disk as the sidebar storage card: the one that holds the data folder.
  const machineMetrics = new MachineMetricsSampler(storageSources.roots.data);
  // Its own sampler, so a Storage panel that reads in between does not shorten its one-minute CPU window.
  const machineAlertMetrics = new MachineMetricsSampler(storageSources.roots.data);
  const machineAlerts = new MachineAlertMonitor({
    read: () => machineAlertMetrics.read(),
    display: () => machineMetrics.read(),
    store: machineAlertStore,
    members: () => teamStore.listMembers(),
    onError: (message, error) => logger.warn(message, toLogValue(error)),
  });
  teardown.push(TEARDOWN_ORDER.machineAlerts, "the machine alert check", () => machineAlerts.close());
  const events = new HostEventsService({
    routines: service.routineRecords,
    workflows: {
      receive: (delivery) => workflowRuntime.receiveWebhook(delivery),
      changed: (workflowId) => service.notifyWorkflowsChanged(workflowId),
    },
    cipher: secretCipher,
    relay: NO_WEBHOOK_RELAY,
    accountPrincipal: () => {
      const state = centralAuth.getState();
      return state.status === "signed_in" ? state.user.id : null;
    },
  });
  const eventsRuntime = new HostEventsRuntime(events);
  teardown.push(TEARDOWN_ORDER.hostEvents, "the event service", async () => {
    await Effect.runPromise(eventsRuntime.stop());
  });
  performance.mark("tommy:services.hosted");
  const agentAdminSettings = createAgentAdminSettings({ agents: service, approvalAutomation });
  const agentHostSettings = createAgentHostSettings({ agents: service, busyMessageMode, agentDefaults });
  const agentFolders = createAgentFolders({ service, userDataPath: app.getPath("userData") });
  const agentInstructions = createAgentInstructionsFiles(service);
  const browserProfiles = createBrowserProfileService({
    store: browserProfileStore,
    agents: service,
    browser,
    onChanged: () => service.notifyBrowserProfilesChanged(),
  });
  const installationMode =
    app.isPackaged && process.platform === "linux" ? await runCauseEffect(readInstallationMode()) : null;
  const hostRelease = new HostReleaseService({
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    environment: process.env,
    installationMode,
    updateStatus: () => ({ phase: "unsupported", managedByHost: false }),
  });
  // The same owners the Settings screens write through, so an import has their checks and restarts.
  const instanceTransfer = new InstanceTransferService({
    agents: service,
    skills: { library: () => skills.requireLocalLibrary(), installLocal: (input) => skills.installLocal(input) },
    sharedRoot: store.sharedRoot,
    appVersion: app.getVersion(),
    uploadDirectory: join(app.getPath("userData"), "instance-transfer-uploads"),
    timezone: () => serverTimezone.effective(),
    settings: {
      mcpServers: () => service.listMcpServers(),
      saveMcpServer: (config) => service.saveMcpServer({ config }),
      providersOff: () => providerUse.off(),
      sidebar: () => sidebarLayout.getSnapshot(),
      mutateSidebar: (action) => sidebarLayout.mutate(action, service.sidebarChatIds()),
      routineFlowLinks: (agentId) => routineFlowRuntime.canvas(agentId).pipe(Effect.map((canvas) => canvas.links)),
      connectRoutineFlow: (input) => routineFlowRuntime.connect(input),
      signedInProviders: () =>
        (service.getStatus().providers ?? [])
          .filter((provider) => provider.state === "available" && !provider.off)
          .map((provider) => provider.id),
    },
  });
  const mcpHostSignIns = new McpHostSignIns({ service, browser });
  const providerSignIns = new ProviderHostSignIns({ service, browser });
  const providerAccountsHost = new ProviderAccountsHost({ service, browser });
  // The flows end with the sign-ins they relay, which `mcpHostSignIns`, `providerSignIns` and
  // `providerAccountsHost` close.
  const signInRelayHost = new SignInRelayHost({
    mcp: mcpHostSignIns,
    providers: providerSignIns,
    accounts: providerAccountsHost,
    receiveMcpGrant: (state, code) => mcpOAuth.receiveAuthorizationCode(state, code),
    // The search ignores case, so the exact address is checked again on each agent message it finds.
    printedLink: (agentId, url) =>
      agentPrintedLink(
        service.searchConversationMessages(url, agentId, undefined, 20).results.map(({ message }) => message),
        url,
        Date.now(),
      ),
  });
  teardown.push(TEARDOWN_ORDER.mcpHostSignIns, "MCP sign-ins of joined servers", () =>
    Effect.runPromise(mcpHostSignIns.close()),
  );
  teardown.push(TEARDOWN_ORDER.providerAccountsHost, "Provider account sign-ins of joined servers", () =>
    Effect.runPromise(providerAccountsHost.close()),
  );
  teardown.push(TEARDOWN_ORDER.providerHostSignIns, "Provider sign-ins of joined servers", () =>
    Effect.runPromise(providerSignIns.close()),
  );
  // The live view of a sign-in page in this host's browser: only on Linux, where the Gemini CLI has
  // always printed its page. The relay takes the page on every platform.
  const providerHostSignIns = process.platform === "linux" ? providerSignIns : undefined;
  const pushNotificationStore = new PushNotificationStore(join(app.getPath("userData"), PUSH_NOTIFICATION_FILE));
  await runCauseEffect(pushNotificationStore.load());
  // The OpenAI key of dictation stays on the server. A client never reads it.
  const hostVoiceKeys = new VoiceApiKeyStore({
    path: join(app.getPath("userData"), "tommy-openai-key.json"),
    cipher: secretCipher,
  });
  await runCauseEffect(hostVoiceKeys.load());
  const hostVoice = new HostVoice({ keys: hostVoiceKeys });
  teardown.push(TEARDOWN_ORDER.voice, "dictation streams", () => hostVoice.stop());
  const directDevices = serverModeEnvironment
    ? new DirectDeviceStore({ path: join(app.getPath("userData"), DIRECT_DEVICES_FILE) })
    : null;
  if (directDevices) await runCauseEffect(directDevices.load());
  const fcm = serverModeEnvironment ? await FcmSender.load(join(homedir(), FCM_SERVICE_ACCOUNT_FILE)) : null;
  const apns = serverModeEnvironment ? await ApnsSender.load(join(homedir(), APNS_KEY_FILE)) : null;
  const host = new HostService({
    voice: hostVoice,
    ...(directDevices
      ? {
          directConnection: {
            devices: directDevices,
            listen: { host: "127.0.0.1", port: readDirectPort(process.env.TOMMY_DIRECT_PORT) },
            publicUrl: readDirectPublicUrl(process.env.TOMMY_PUBLIC_URL),
          },
        }
      : {}),
    appVersion: app.getVersion(),
    store: teamStore,
    agents: service,
    // Defined below with the startup it waits for; a request runs only after this returns.
    agentsReady: () => agentInitialization.awaitRoster(),
    events,
    skills,
    sidebarLayout,
    mailbox,
    browser,
    channels: service.channels,
    // Present, so the host advertises `mcp-servers-v1`. The routes are admin-only.
    mcpServers: service,
    // Present, so the host advertises `mcp-sign-in-v1`. The routes are admin-only.
    mcpSignIns: mcpHostSignIns,
    // Present, so the host advertises `sign-in-relay-v1`. The routes are admin-only.
    signInRelay: signInRelayHost,
    // Present, so the host advertises `vault-v1`. The routes are admin-only.
    vault,
    // Present on Linux, so the host advertises `provider-host-sign-in-v1`. The routes are admin-only.
    providerHostSignIns,
    // Present, so the host advertises `provider-accounts-v1`. The routes are admin-only.
    providerAccounts: providerAccountsHost,
    // Present, so the host advertises `provider-usage-reset-v1`. The routes are admin-only.
    providerUsageResets: service,
    // Present, so the host advertises `provider-sign-out-v1`. The route is admin-only.
    providerSignOut: service,
    // Present, so the host advertises `storage-v1`. Members read; only admins delete or clear.
    storage: storageUsage,
    // Present, so the host advertises `machine-resources-v1`. The routes are admin-only.
    machine: machineAlerts,
    // Present, so the host advertises `instance-transfer-v1`. Only owners and admins.
    instanceTransfer,
    // Present, so the host advertises `routine-flows-v1`. Any member who can see the agents.
    routineFlows: routineFlowRuntime,
    // Present, so the host advertises `workflows-v1`. Any member who can see and talk to the agents.
    workflows: {
      ...workflowRuntime,
      rotateWorkflowSecret: (input) => events.rotateWorkflowSecret(input),
    },
    // Present, so the host advertises `agent-hidden-v1`. Any member can hide or restore an agent that they can see.
    hiddenAgents: service,
    // Present, so the host advertises `agent-notification-levels-v1`. Each member sets their own levels.
    agentNotificationLevels,
    // Present, so the host advertises `sidebar-pins-v1`. Each member saves their own pins.
    sidebarPins,
    // Present, so the host advertises `agent-access-v1`. Only owners and admins change the roles.
    agentAccess,
    // Present, so the host advertises `server-audit-v1`. Only owners and admins read the log.
    serverAudit,
    // Present, so the host advertises `agent-tasks-v1`. Any member who can send a message to the agent.
    agentTasks: service,
    // Present, so the host advertises `browser-profiles-v1`. Only owners and admins change profiles;
    // any member reads the profile labels of the tabs they can see.
    browserProfiles,
    focusUse: false,
    // Each member present advertises its admin capability. Every admin route requires an owner or admin.
    admin: {
      agents: agentAdminSettings,
      agentHost: agentHostSettings,
      folders: agentFolders,
      instructions: agentInstructions,
      sessionSettings: service,
      skills,
      sharedTables: service,
      providers: {
        service,
        credentials: providerCredentials,
        runtimes: providerRuntimes,
        pasteSignIn: pasteCodeLoginSupported(),
      },
      release: hostRelease,
      timezone: serverTimezone,
      memoryLimit: agentMemoryLimitSetting,
      memoryReview,
      promptCacheTtl,
      // The local Settings save does the same two steps (`saveSetup`).
      defaultProvider: {
        // The provider that a new agent starts on now, also before a setup choice: `preferredProvider` above.
        get: () =>
          readSetupState(setupFile).pipe(
            Effect.map((state) => ({
              provider: service.preferredProvider(),
              model: state.preferredProvider === service.preferredProvider() ? state.preferredModel : null,
            })),
          ),
        set: (input) =>
          readSetupState(setupFile).pipe(
            Effect.flatMap(() => writeSetupState(setupFile, input)),
            Effect.tap(() => service.setPreferredProvider(input.preferredProvider, input.preferredModel)),
            // The window read the setup once at start, so it gets the new choice.
            Effect.tap((state) =>
              Effect.sync(() => {
                for (const window of BrowserWindow.getAllWindows())
                  sendToRenderer(window, IPC_ENDPOINTS.app.setupState, state);
              }),
            ),
            Effect.map((state) => ({ provider: state.preferredProvider, model: state.preferredModel })),
          ),
      },
      routineResults: routineResultRuntime,
    },
    // The host's Team API routes share the IPC handlers' runtime preparation: a first server
    // saved, enabled, or tested remotely must start and await the managed download like a local one.
    mcpToolRuntimePreparation: {
      startToolRuntimes: () => {
        Effect.runFork(providerRuntimes.ensureToolRuntimes());
      },
      ensureToolRuntimesReady: () => providerRuntimes.ensureToolRuntimesReady(),
      toolRuntimes: () => providerRuntimes.mcpToolRuntimes(),
    },
    // From this server to Firebase for Android, and to Apple for iPhone.
    pushNotificationPlatforms: new Set([...(fcm ? (["android"] as const) : []), ...(apns ? (["ios"] as const) : [])]),
    sendPushNotification: (_hostId: string, request: NotificationRelayRequest) => {
      const failed = (cause: unknown) => new RemoteWorkflowError({ cause });
      if (request.platform === "ios")
        return apns
          ? apns.send(request.push).pipe(Effect.mapError(failed))
          : Effect.fail(failed(new Error("This server has no APNs key.")));
      return fcm
        ? fcm.send(request.push).pipe(Effect.mapError(failed))
        : Effect.fail(failed(new Error("This server has no Firebase key.")));
    },
    pushNotificationStore,
    // The owner is at this computer only with recent input, also when the window was left in focus.
    // Then the focused window shows the event, or the desktop notifies. When mute or the level of
    // this server keeps the desktop quiet about the event, the phone tells the owner.
    hostComputerInUse: (event) => {
      const window = windows.getMainWindow();
      if (!window || window.isDestroyed()) return false;
      if (powerMonitor.getSystemIdleState(DESKTOP_USE_MS / 1_000) !== "active") return false;
      if (window.isFocused()) return true;
      // Without a notification service, as on Linux without a daemon, the desktop shows nothing.
      if (!Notification.isSupported()) return false;
      // Read when an event arrives, after the manager below exists.
      const local = remoteServers.list().find((server) => server.id === LOCAL_SERVER_ID);
      return desktopShowsAgentEvent(
        event,
        local,
        notificationPreference.get().desktopNotifications,
        agentNotificationLevels.levels(OWNER_NOTIFICATION_KEY),
      );
    },
    logDirectory: join(app.getPath("userData"), "logs", "remote"),
    // Still a function, and still throws when nobody is signed in: the account is a lifetime
    // state of the running app, not a startup-ordering artifact.
    getSignedInUser: () => centralAuth.getSignedInUser(),
  });
  teardown.push(TEARDOWN_ORDER.host, "the local host", () => runCauseEffect(host.shutdown()));
  const signedInState = centralAuth.getState();
  if (signedInState.status === "signed_in") {
    await runCauseEffect(host.applySignedInAccount(signedInState.user));
  } else if (signedInState.status === "signed_out") {
    // Sign-out can settle before this service exists, leaving `forwardCentralAuth`
    // nothing to deactivate. Unbinding here is what stops a persisted
    // `activeAccountId` from keeping the last account's host configured - and
    // unconfigurable - while nobody is signed in. A still-loading or failed account
    // service keeps its host, and the event listener settles it.
    await runCauseEffect(host.applySignedInAccount(null));
  }
  performance.mark("tommy:services.remote-desktop");
  const trace = new TraceFile({ directory: join(app.getPath("userData"), "logs") });
  teardown.push(TEARDOWN_ORDER.trace, "the trace file", () => Effect.runPromise(trace.close()));
  const resourceMonitor = new ResourceMonitor({
    userDataPath: app.getPath("userData"),
    server: serverModeEnvironment !== null,
    trace,
    statementTimings,
    tabProcessIds: () => browser.tabProcessIds(),
    turnRunning: () => service.earliestRunningTurnStartedAt() !== null,
  });
  teardown.push(TEARDOWN_ORDER.resourceMonitor, "the resource monitor", () =>
    Effect.runPromise(resourceMonitor.close()),
  );
  service.on("event", (event) => resourceMonitor.observeAgentEvent(event));
  resourceMonitor.start(() => undefined);
  const connectTrace = new RemoteConnectTrace((span) => trace.record(span));
  // Development only: a network round trip added to the WebRTC client, for `bun run perf:remote`.
  const developmentRoundTripMs = app.isPackaged ? 0 : Math.max(0, Number(process.env.TOMMY_DEV_RTT_MS) || 0);
  installRemoteSyncProfileSink(
    remoteSyncProfileFile({
      isPackaged: app.isPackaged,
      setting: process.env.TOMMY_DEV_SYNC_PROFILE,
      userData: app.getPath("userData"),
      roundTripMs: developmentRoundTripMs,
    }),
  );
  // A removed device cannot connect again, so the app goes back to pairing and says why.
  const directBridge = new DirectClientBridge({
    deviceRevoked: () =>
      Effect.runFork(
        pairedServer.forget().pipe(Effect.andThen(Effect.sync(() => centralAuth.refresh())), Effect.ignore),
      ),
  });
  const remoteServers = new RemoteServerManager(
    join(app.getPath("userData"), REMOTE_SERVERS_FILE),
    safeStorageCipher("error.app.macSecureStorageUnavailable"),
    {
      getEmail: () => centralAuth.getSignedInUser().email,
    },
    {
      appVersion: app.getVersion(),
      connectTrace,
      // The owner's levels on this computer's server, which the host also reads for the owner's phones.
      localNotificationLevels: {
        snapshot: () => agentNotificationLevels.snapshot(OWNER_NOTIFICATION_KEY),
        setServer: (level) => agentNotificationLevels.setServer(OWNER_NOTIFICATION_KEY, level),
        setAgent: (input) => agentNotificationLevels.set(OWNER_NOTIFICATION_KEY, input),
        subscribe: (listener) =>
          agentNotificationLevels.subscribe((key) => {
            if (key === OWNER_NOTIFICATION_KEY) listener();
          }),
      },
      accountReady: centralAuthInitialization,
      getLocalHostId: () => teamStore.getIdentity()?.serverId ?? null,
      webrtcTransport: new TeamWebRtcClientTransport({
        bridge: directBridge,
        ...pairedServer.transportSource,
        getPrincipalId: () => centralAuth.getSignedInUser().id,
        transferDirectory: join(app.getPath("userData"), "remote-transfers"),
        connectTrace,
        developmentRoundTripMs,
      }),
    },
  );
  teardown.push(TEARDOWN_ORDER.remoteServers, "the remote servers", () => runCauseEffect(remoteServers.stop()));
  performance.mark("tommy:services.plugin-catalog");
  await runCauseEffect(remoteServers.initialize());
  performance.mark("tommy:services.remote-servers");
  criticalActionTargets = { agents: service, host, remoteServers };
  configureAttachmentProtocol({ mailbox, agents: service, remoteServers });
  configureServerLogoProtocols({ teamStore, remoteServers });
  // After the servers: the view it opens belongs to one of them, and it has to stop before they do.
  const browserView = new BrowserViewClient({
    servers: remoteServers,
    onEvent: (event, owner) => {
      const contents = webContents.fromId(owner);
      sendToRenderer(contents && BrowserWindow.fromWebContents(contents), IPC_ENDPOINTS.browser.liveViewEvent, event);
    },
  });
  teardown.push(TEARDOWN_ORDER.browserView, "the live browser view", () => runCauseEffect(browserView.stop()));
  const agentInitialization = new AgentInitializationGate((rosterLoaded) =>
    Effect.gen(function* () {
      yield* service.initialize({ heldRoutines: takeRoutineHold(routineHoldFile, (message) => logger.warn(message)) });
      // A client's agent list waits only until here. The steps below do not change the roster.
      yield* rosterLoaded;
      yield* eventsRuntime.start();
      yield* automation.sync();
      // Picks up the flows a restart stopped between one agent's answer and the next agent's message.
      yield* routineFlowRuntime.sweep();
      // Ends the workflow steps a restart cut off, and moves the runs on.
      yield* workflowRuntime.sweep();
      // Marks the posts a restart cut off, and sends the answers that ended while Tommy was closed.
      yield* routineResultRuntime.recover();
    }),
  );
  const serverMode = serverModeEnvironment
    ? new ServerMode({
        environment: serverModeEnvironment,
        version: app.getVersion(),
        host,
        memory: hostMemory,
        onError: (message, error) => logger.warn(message, toLogValue(error)),
      })
    : null;
  if (serverMode) {
    // Without the socket the server still runs, and the log says why nobody can sign it in.
    await runCauseEffect(serverMode.listen()).catch((error) =>
      logger.error("The server control socket did not start:", toLogValue(error)),
    );
    // Nobody presses Retry on a server either. A server that is signed out has nothing to publish.
    const serverStartRetry = new HostedServerStartRetry({
      hostPhase: () => host.getStatus().phase,
      startHost: () =>
        Effect.gen(function* () {
          yield* serverMode.publish();
        }),
      onError: (message, error) => logger.warn(message, toLogValue(error)),
    });
    serverStartRetry.start();
    teardown.push(TEARDOWN_ORDER.serverMode, "the server control socket", async () => {
      await Effect.runPromise(serverStartRetry.stop());
      await Effect.runPromise(serverMode.close());
    });
  }
  performance.mark("tommy:services.updates");
  performance.mark("tommy:services.host-update");

  return {
    service,
    routineFlows: routineFlowRuntime,
    workflows: workflowRuntime,
    routineResults: routineResultRuntime,
    providerRuntimes,
    providerCredentials,
    pairedServer,
    mcpOAuth,
    signInRelayClient,
    vault,
    mailbox,
    storageUsage,
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
    agentMemoryLimit: agentMemoryLimitSetting,
    memoryReview,
    agentNotificationLevels,
    sidebarPins,
    agentAccess,
    serverAudit,
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
    host,
    remoteServers,
    centralAuth,
    skills,
    routineFeed,
    events,
    eventsRuntime,
    serverMode,
    instanceTransfer,
    dynamicIsland,
    trace,
    resourceMonitor,
    machineAlerts,
    teamStore,
    appliedAccount: signedInState,
    centralAuthInitialization,
  };
}
