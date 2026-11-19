/**
 * The composition root of the Tommy server. Every long-lived service is built here, in one function,
 * in dependency order, and handed back as a single record. People reach the server through Telegram
 * only: there is no window that shows the agents and no app that connects to the server.
 *
 * **One function on purpose.** Most of these services take their dependencies by value, and a value
 * only type-checks because `tsc` narrows a local across the statements of one function body.
 *
 * **Every step is registered for teardown as it is built**, so a quit that arrives mid-startup
 * stops exactly what exists. `TEARDOWN_ORDER` below, not the order of the pushes, decides what runs
 * when - see `teardown-registry.ts` for why shutdown here is not the reverse of construction.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isManagedRuntimeProvider } from "@tommy/contracts/agent-providers";
import type { AgentStatus } from "@tommy/contracts/ipc";
import { agentBrowserProfile, isManagedToolRuntime, latestTurnAnswer } from "@tommy/contracts/ipc";
import { sourceText } from "@tommy/i18n/source";
import { createTommyLogger, redactText, toLogValue } from "@tommy/logging";
import { Effect, Fiber } from "effect";
import { app, type BrowserWindow, safeStorage, shell } from "electron";
import { toAgentRemovalFailed } from "../backend/agent/agent-removal";
import { MemoryReviewCursors } from "../backend/agent/memory-review-store";
import { ProviderAccountStore } from "../backend/agent/provider-account-store";
import { SkillLearningFailed } from "../backend/agent/skill-learning";
import { AgentApiKeys } from "../backend/agent-api-keys";
import { AgentDatabaseSupervisor } from "../backend/agent-data/agent-database-supervisor";
import { AgentTables } from "../backend/agent-data/agent-tables";
import { AgentRoutineStore } from "../backend/agent-routine-store";
import { AgentLifecycleFailed, AgentService } from "../backend/agent-service";
import { AgentStore } from "../backend/agent-store";
import { BrowserHost } from "../backend/browser-host";
import { BrowserProfileProxyStore } from "../backend/browser-profiles/browser-profile-proxy-store";
import { BrowserProfileStore } from "../backend/browser-profiles/browser-profile-store";
import { runCauseEffect } from "../backend/effect-boundary";
import { MailboxStore } from "../backend/mailbox-store";
import { McpOAuth } from "../backend/mcp-oauth-provider";
import { passwordVaultRouter } from "../backend/password-vault-router";
import { routineFlowRoutines } from "../backend/routine-flows/routine-flow-routines";
import { RoutineFlowStore } from "../backend/routine-flows/routine-flow-store";
import { createRoutineFlows } from "../backend/routine-flows/routine-flows";
import { RoutineResultStore } from "../backend/routine-results/routine-result-store";
import { createRoutineResults } from "../backend/routine-results/routine-results";
import { SidebarLayoutStore } from "../backend/sidebar-layout-store";
import { TommyDatabase } from "../backend/tommy-database";
import { WorkflowGitHubStore } from "../backend/workflows/workflow-github-store";
import { WorkflowRunStore } from "../backend/workflows/workflow-run-store";
import { WorkflowStore } from "../backend/workflows/workflow-store";
import { WorkflowTriggers, workflowScheduleDueAt } from "../backend/workflows/workflow-triggers";
import { createWorkflows, type WorkflowsHandle } from "../backend/workflows/workflows";
import { spawnAgentDatabaseHost } from "./agent-database-host-process";
import { createAgentDefaultsPreferenceStore } from "./agent-defaults-preference-store";
import { AgentDesktopRuntime, resolveAgentDesktop } from "./agent-desktop-runtime";
import { agentDisplayEnvironment, hasSeparateAgentDisplay } from "./agent-display";
import { AgentInitializationGate } from "./agent-initialization";
import { AgentMemoryLimitPreferenceStore } from "./agent-memory-limit-preference-store";
import { ApprovalAutomation, readApprovalAutomation } from "./approval-automation-store";
import { AutomationServer } from "./automation-server";
import { BusyMessageModePreferenceStore } from "./busy-message-mode-preference-store";
import { ChatVisualPreviewer } from "./chat-visual-preview";
import { DirectWebhookIngress, DirectWebhookRoutes } from "./direct-webhook-ingress";
import { HostEventsRuntime } from "./host-events-runtime";
import { agentWebhookRoutineWriter, HostEventsService } from "./host-events-service";
import { LanguageService } from "./language-service";
import { LocalSkillLibrary } from "./local-skill-library";
import { localSkillTools } from "./local-skill-tools";
import {
  DATA_SKILL_SLUG,
  ManagedSkillService,
  retireManagedSkills,
  SKILL_CREATOR_SKILL_SLUG,
} from "./managed-skill-service";
import { McpOAuthProxySettingsFile } from "./mcp-oauth-proxy-store";
import { MCP_OAUTH_REDIRECT_PORT, startMcpOAuthRedirectServer } from "./mcp-oauth-redirect-server";
import { McpOAuthStore } from "./mcp-oauth-store";
import { prepareToolRuntimeForTest } from "./mcp-tool-runtime-preparation";
import { MemoryReviewPreferenceStore } from "./memory-review-preference-store";
import { OnePasswordCliVault } from "./onepassword-cli-vault";
import { PromptCacheTtlPreferenceStore } from "./prompt-cache-ttl-preference-store";
import { createProviderCliAppVersionStore } from "./provider-cli-app-version-store";
import { ProviderCredentialStore } from "./provider-credential-store";
import { startAccountLog, startAgentLog, startProviderLog } from "./provider-log";
import { toProviderRuntimeFailure } from "./provider-runtime-effects";
import { ProviderRuntimeManager, providerRuntimeRoot } from "./provider-runtime-manager";
import { ProviderUseSettingsStore } from "./provider-use-settings-store";
import { type PublicHttpRoute, PublicHttpServer } from "./public-http-server";
import { ResourceMonitor } from "./resource-monitor";
import { StatementTimings } from "./resource-summary";
import { ROUTINE_HOLD_FILE, takeRoutineHold } from "./routine-hold-file";
import { createSecretStorage, SECRET_STORAGE_KEY_FILE } from "./secret-storage-cipher";
import { AGENT_PROCESS_VARIABLE, agentProcessEnvironment, ServerMemory } from "./server-memory";
import { ServerMode, type ServerModeEnvironment } from "./server-mode";
import { ServerTimezonePreferenceStore } from "./server-timezone-preference-store";
import { readSetupState } from "./setup-store";
import { SkillLearningService } from "./skill-learning-service";
import { SkillMarketplaceService } from "./skill-marketplace-service";
import type { TeardownRegistry } from "./teardown-registry";
import { createTelegramRuntime } from "./telegram-runtime";
import { readTelegramSettings } from "./telegram-settings";
import { TraceFile } from "./trace-file";
import { VaultService } from "./vault-service";
import { VaultStore } from "./vault-store";
import { readWebhookPublicOrigin, readWorkflowConnectorSettings } from "./workflow-connector-config";
import { WorkflowConnectors } from "./workflow-connectors";

const logger = createTommyLogger("application-services");
const SETUP_FILE = "tommy-setup-v2.json";
const APPROVAL_AUTOMATION_FILE = "tommy-approval-automation-v3.json";
const V2_APPROVAL_AUTOMATION_FILE = "tommy-approval-automation-v2.json";
const LEGACY_APPROVAL_AUTOMATION_FILE = "tommy-approval-automation-v1.json";
const LANGUAGE_PREFERENCE_FILE = "tommy-language-preference-v1.json";
const AGENT_MEMORY_LIMIT_PREFERENCE_FILE = "tommy-agent-memory-limit-v1.json";
const MEMORY_REVIEW_PREFERENCE_FILE = "tommy-memory-review-v1.json";
const SERVER_TIMEZONE_PREFERENCE_FILE = "tommy-server-timezone-v1.json";
const PROMPT_CACHE_TTL_PREFERENCE_FILE = "tommy-prompt-cache-ttl-v1.json";
const BROWSER_STATE_FILE = "tommy-browser-state-v1.json";
const SIDEBAR_LAYOUT_FILE = "tommy-sidebar-layout-v1.json";
const AGENT_DEFAULTS_PREFERENCE_FILE = "tommy-agent-defaults-v1.json";
const BUSY_MESSAGE_MODE_PREFERENCE_FILE = "tommy-busy-message-mode-v1.json";
const PROVIDER_CLI_APP_VERSION_FILE = "tommy-provider-cli-app-version-v1.json";
const PROVIDER_CREDENTIAL_FILE = "tommy-provider-credentials-v1.json";
/** The MCP sign-ins. Separate from the keys above: a key is typed by the user, a token is not. */
const MCP_OAUTH_FILE = "tommy-mcp-oauth-v1.json";
const MCP_OAUTH_PROXY_FILE = "tommy-mcp-oauth-proxy-v1.json";
/** The logins, payment cards and contact info of the Vault, with the same cipher. */
const VAULT_FILE = "tommy-vault-v1.json";
/** The owner of a server. Webhook routes keep this id, so the routes saved before stay valid. */
const SERVER_OWNER_ID = "local-owner";
/** The port that the reverse proxy forwards to on loopback. */
const DEFAULT_PUBLIC_PORT = 8790;
/** The address of a sign-in page that a server cannot listen for. Some servers accept it anyway. */
const MCP_OAUTH_FALLBACK_REDIRECT_URL = "tommy://mcp-auth";

function readPublicPort(value: string | undefined): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_PUBLIC_PORT;
}

const TEARDOWN_ORDER = {
  // First, so a process that the teardown ends does not count as a crash.
  resourceMonitor: 9,
  serverMemory: 16,
  serverMode: 17,
  // Before the browser, so no request opens a tab while it stops.
  publicHttp: 25,
  browser: 30,
  providerRuntimes: 50,
  // Before messaging, so no routine answer starts a post while the connections stop.
  routineResults: 84,
  // Before the service: no new external message arrives while it stops.
  messaging: 85,
  hostEvents: 85.5,
  // Before the agent service, so no handoff is sent to an agent while the service stops.
  routineFlows: 103,
  // Before the agent service, so no workflow step is sent to an agent while the service stops.
  workflows: 103.5,
  mcpOAuthRedirect: 105,
  // Before the agent service, so no script starts a run while the service stops.
  automation: 108,
  service: 110,
  mcpOAuth: 111,
  // After the service, so the turns that end while the services stop are still written.
  trace: 120,
  // After the service, so the lines its providers write while they stop are kept.
  providerLog: 121,
  // After the service, so a deletion that fails while the service stops is kept.
  agentLog: 122,
  accountLog: 123,
  // Last: every step above can still write.
  database: 130,
} as const;

export interface ApplicationServiceContext {
  /** A window that never loads. The agent browser attaches its tabs to it. */
  browserWindow: BrowserWindow;
  /** Set when systemd started this process. Null in development. */
  serverMode: ServerModeEnvironment | null;
  teardown: TeardownRegistry;
}

/** Everything the entry point starts and shuts down. */
export interface ApplicationServices {
  /** Starts the shared database host after the server is up. */
  prewarmAgentDatabase: Effect.Effect<void>;
  service: AgentService;
  providerRuntimes: ProviderRuntimeManager;
  agentInitialization: AgentInitializationGate<AgentLifecycleFailed>;
  eventsRuntime: HostEventsRuntime;
  publicHttp: PublicHttpServer;
  trace: TraceFile;
}

export async function createApplicationServices({
  browserWindow,
  serverMode: serverModeEnvironment,
  teardown,
}: ApplicationServiceContext): Promise<ApplicationServices> {
  const userData = app.getPath("userData");
  const secretStorage = createSecretStorage({
    keyPath: join(userData, SECRET_STORAGE_KEY_FILE),
    storage: safeStorage,
    isReady: () => app.isReady(),
    allowKeyFileFallback: process.env.TOMMY_SECRET_STORAGE_FALLBACK === "key-file",
  });
  const secretCipher = secretStorage.cipher(() => sourceText("error.app.secretStorageUnavailable"));
  const telegramSettings = await Effect.runPromise(
    readTelegramSettings(process.env).pipe(
      Effect.catch((error) => {
        logger.warn("Telegram is disabled. Check its server setting.", { field: error.field });
        return Effect.succeed(null);
      }),
    ),
  );
  delete process.env.TOMMY_TELEGRAM_MANAGER_TOKEN_FILE;
  const publicWebhookOrigin = readWebhookPublicOrigin();
  const webhookRoutes = new DirectWebhookRoutes(publicWebhookOrigin);
  const connectorSettings = readWorkflowConnectorSettings();
  // The settings are in memory now. Remove the source, so a process that inherits the environment of
  // the host without the child filter cannot read the connector credentials.
  delete process.env.TOMMY_WORKFLOW_CONNECTORS_JSON;
  if (connectorSettings.invalid)
    logger.warn("Workflow connectors are disabled because their configuration is invalid.");
  // First, so the provider lines of the whole startup reach the file.
  teardown.push(TEARDOWN_ORDER.providerLog, "the provider log", startProviderLog(join(userData, "logs")));
  teardown.push(TEARDOWN_ORDER.agentLog, "the agent log", startAgentLog(join(userData, "logs")));
  teardown.push(TEARDOWN_ORDER.accountLog, "the account log", startAccountLog(join(userData, "logs")));
  // A server has no screen: a sign-in page opens in the agent browser, where the owner can see it.
  const openLink = (url: string) => shell.openExternal(url);
  // Before the agents load, so the first check of an agent that follows a default reads the saved one.
  const agentDefaults = createAgentDefaultsPreferenceStore(join(userData, AGENT_DEFAULTS_PREFERENCE_FILE));
  await runCauseEffect(agentDefaults.load());
  const store = new AgentStore(userData, homedir(), new TommyDatabase(userData), () => agentDefaults.get());
  await runCauseEffect(store.initialize());
  // Closing copies the write-ahead log into the database file and removes it. A step that passed its
  // limit, such as a slow agent stop, still writes, so the close waits a short time for it.
  teardown.push(TEARDOWN_ORDER.database, "the database", () => store.database.close(), { afterAbandonedSteps: true });
  const managedSkillPath = (name: string) =>
    app.isPackaged
      ? join(process.resourcesPath, "managed-skills", name, "SKILL.md")
      : resolve(__dirname, `../../resources/managed-skills/${name}/SKILL.md`);
  const skillCreator = new ManagedSkillService(
    managedSkillPath("tommy-skill-creator"),
    undefined,
    undefined,
    SKILL_CREATOR_SKILL_SLUG,
  );
  const dataSkill = new ManagedSkillService(managedSkillPath("tommy-data"), undefined, undefined, DATA_SKILL_SLUG);
  await Effect.runPromise(retireManagedSkills(store.list()));
  await Effect.runPromise(skillCreator.syncAll(store.list()));
  await Effect.runPromise(dataSkill.syncAll(store.list()));
  const sidebarLayout = new SidebarLayoutStore(join(userData, SIDEBAR_LAYOUT_FILE));
  await runCauseEffect(sidebarLayout.initialize());
  const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  await runCauseEffect(mailbox.initialize());
  // One unit holds Tommy and every agent process, so the server holds turns for memory.
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
  const browserProfileProxies = new BrowserProfileProxyStore(store.database, secretCipher);
  const browser = new BrowserHost(browserWindow, store.downloadsRoot, join(userData, BROWSER_STATE_FILE), {
    memoryLow: () => (hostMemory?.level() ?? "ok") !== "ok",
    browserProfile: (agentId) => {
      const agent = store.list().find((candidate) => candidate.id === agentId);
      return agent ? agentBrowserProfile(agent) : { kind: "shared" };
    },
    profileExists: (profileId) => browserProfileStore.get(profileId) !== undefined,
    profileProxy: (profileId) => browserProfileProxies.connection(profileId),
    quitShortcut: () => false,
  });
  teardown.push(TEARDOWN_ORDER.browser, "the browser", () => runCauseEffect(browser.destroy()));
  await runCauseEffect(browser.restore(store.list().map((agent) => ({ id: agent.id, threadId: agent.threadId }))));
  const setupFile = join(userData, SETUP_FILE);
  const setupState = await runCauseEffect(readSetupState(setupFile));
  // The language of the MCP sign-in pages that this server answers.
  const language = new LanguageService({
    path: join(userData, LANGUAGE_PREFERENCE_FILE),
    systemLocale: app.getLocale(),
  });
  await runCauseEffect(language.load());
  const busyMessageMode = new BusyMessageModePreferenceStore(join(userData, BUSY_MESSAGE_MODE_PREFERENCE_FILE));
  await runCauseEffect(busyMessageMode.load());
  const agentMemoryLimit = new AgentMemoryLimitPreferenceStore(join(userData, AGENT_MEMORY_LIMIT_PREFERENCE_FILE));
  await runCauseEffect(agentMemoryLimit.load());
  const memoryReview = new MemoryReviewPreferenceStore(join(userData, MEMORY_REVIEW_PREFERENCE_FILE));
  await runCauseEffect(memoryReview.load());
  const serverTimezone = new ServerTimezonePreferenceStore(join(userData, SERVER_TIMEZONE_PREFERENCE_FILE));
  await runCauseEffect(serverTimezone.load());
  const promptCacheTtl = new PromptCacheTtlPreferenceStore(join(userData, PROMPT_CACHE_TTL_PREFERENCE_FILE));
  await runCauseEffect(promptCacheTtl.load());
  const approvalAutomationFile = join(userData, APPROVAL_AUTOMATION_FILE);
  const approvalAutomation = new ApprovalAutomation({
    path: approvalAutomationFile,
    initial: await runCauseEffect(
      readApprovalAutomation(
        approvalAutomationFile,
        store.list().map((agent) => agent.id),
        [V2_APPROVAL_AUTOMATION_FILE, LEGACY_APPROVAL_AUTOMATION_FILE].map((file) => join(userData, file)),
      ),
    ),
    knownAgentIds: () => store.list().map((agent) => agent.id),
  });
  const providerUse = new ProviderUseSettingsStore(join(userData, "tommy-provider-use-v1.json"));
  await runCauseEffect(providerUse.load());
  const providerAccounts = new ProviderAccountStore(
    join(userData, "tommy-provider-accounts-v1.json"),
    join(userData, "provider-accounts"),
  );
  await runCauseEffect(providerAccounts.load());
  const providerCliAppVersion = createProviderCliAppVersionStore(join(userData, PROVIDER_CLI_APP_VERSION_FILE));
  await runCauseEffect(providerCliAppVersion.load());
  const providerRuntimesRoot = providerRuntimeRoot({
    appData: app.getPath("appData"),
    userDataOverride: app.commandLine.getSwitchValue("user-data-dir"),
  });
  const providerRuntimes = new ProviderRuntimeManager({
    isProviderOn: (provider) => !providerUse.off().includes(provider),
    root: providerRuntimesRoot,
    downloadRoot: join(userData, "provider-runtimes", ".downloads"),
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
  // Loaded before the service: a provider spawn reads its key synchronously.
  const providerCredentials = new ProviderCredentialStore(join(userData, PROVIDER_CREDENTIAL_FILE), secretCipher);
  const credentialLoadError = await Effect.runPromise(providerCredentials.load());
  if (credentialLoadError) {
    logger.warn(`Tommy could not read the provider key file (${credentialLoadError.name}). It was left unchanged.`);
  }
  const mcpOAuthStore = new McpOAuthStore(join(userData, MCP_OAUTH_FILE), secretCipher);
  const mcpOAuthLoadError = await Effect.runPromise(mcpOAuthStore.load());
  if (mcpOAuthLoadError) {
    logger.warn(`Tommy could not read the MCP sign-in file (${mcpOAuthLoadError.name}). It was left unchanged.`);
  }
  // The OAuth proxy port, so a Codex session resumed after a restart reaches the same address.
  const mcpOAuthProxySettings = new McpOAuthProxySettingsFile(join(userData, MCP_OAUTH_PROXY_FILE), secretCipher);
  const mcpOAuthProxyLoadError = await Effect.runPromise(mcpOAuthProxySettings.load());
  if (mcpOAuthProxyLoadError) {
    logger.warn(
      `Tommy could not read the MCP sign-in proxy file (${mcpOAuthProxyLoadError.name}). A new port is used.`,
    );
  }
  // The listener is bound before the authority that answers it exists, and a request can arrive in
  // between. It is held rather than closed over, so that request is refused.
  let mcpOAuthAuthority: McpOAuth | null = null;
  const mcpOAuthRedirect = await startMcpOAuthRedirectServer({
    language,
    preferredPort: MCP_OAUTH_REDIRECT_PORT,
    deliver: (state, code) => mcpOAuthAuthority?.receiveAuthorizationCode(state, code) ?? false,
    relayRefusal: () => {},
  }).catch((error: unknown) => {
    logger.warn("Tommy could not listen for MCP sign-ins on this machine:", toLogValue(error));
    return null;
  });
  if (mcpOAuthRedirect) {
    teardown.push(TEARDOWN_ORDER.mcpOAuthRedirect, "the MCP sign-in listener", () => mcpOAuthRedirect.close());
  }
  const mcpOAuth = new McpOAuth({
    storage: mcpOAuthStore,
    openExternal: openLink,
    redirectUrl: mcpOAuthRedirect?.redirectUrl ?? MCP_OAUTH_FALLBACK_REDIRECT_URL,
    logger: createTommyLogger("mcp-oauth"),
  });
  mcpOAuthAuthority = mcpOAuth;
  teardown.push(TEARDOWN_ORDER.mcpOAuth, "MCP token refresh", () => Effect.runPromise(mcpOAuth.close()));
  // Every agent fills the logins, cards and contact info of the Vault; the file holds no resource.
  const vault = new VaultService({
    store: new VaultStore(join(userData, VAULT_FILE), secretCipher),
    canPersist: secretCipher.canPersist,
  });
  await Effect.runPromise(vault.load());
  // Read by the resource monitor.
  const statementTimings = new StatementTimings();
  const tables = new AgentTables({
    sharedRoot: store.sharedRoot,
    supervisor: new AgentDatabaseSupervisor({
      spawnHost: spawnAgentDatabaseHost,
      onStatementSettled: (durationMs) => statementTimings.record(durationMs),
    }),
  });
  // Outside every workspace. Each saved key is masked in the logs before the first agent starts.
  const onePassword = new OnePasswordCliVault(process.env.OP_SERVICE_ACCOUNT_TOKEN);
  const agentApiKeys = new AgentApiKeys(join(userData, "agent-api-keys"), () => vault.items.apiKeys());
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
  const skills = new SkillMarketplaceService(
    () => service.listAgents(),
    // Every skill change ends here: install, update, uninstall, turning one on or off, and a skill
    // an agent creates.
    (agentId) =>
      service
        .refreshAgentRuntime(agentId)
        .pipe(Effect.ensuring(Effect.sync(() => service.notifySkillsChanged(agentId)))),
    new LocalSkillLibrary(join(userData, "local-skills"), () => service.listAgents()),
  );
  const skillLearning = new SkillLearningService({
    preferencePath: join(userData, "skill-learning.json"),
    skills,
    redact: redactText,
  });
  await runCauseEffect(skillLearning.load());
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
    // The server has an agent display of its own, so agents take their screenshots with the
    // Computer Use driver.
    screenCapture: null,
    hostMemory,
    requestTimeoutMs: 30_000,
    offProviders: providerUse.off(),
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
    developmentDefaults: false,
    credentials: {
      apiKey: (provider) => providerCredentials.get(provider),
      // Read at each Claude spawn, so a change applies to the next process.
      promptCacheTtl: () => promptCacheTtl.get().ttl,
      // The enabled MCP servers, read at each spawn.
      mcpServers: () => service.enabledMcpServers(),
      // The `bin` of every managed tool runtime, appended after the user's own `PATH`.
      mcpToolRuntimes: () => providerRuntimes.mcpToolRuntimes(),
      // The sign-ins of the http servers. The service hands a provider a route of its OAuth proxy,
      // never the token.
      mcpOAuth,
      mcpOAuthProxySettings,
      appVersion: app.getVersion(),
      providerStateDirectory: join(userData, "provider-state"),
      serverEnvironment,
      // `DISPLAY` names the agent display, so a program an agent starts opens where the driver sees it.
      agentEnvironment: () => agentDisplayEnvironment(process.platform),
    },
    // Null until the driver answers, which keeps a machine with no driver from handing every
    // provider a command it cannot start.
    computerUseMcpServer: () => agentDesktop.mcpServerConfig(),
    passwordVault: passwordVaultRouter([
      { prefix: "", vault: onePassword },
      { prefix: "tommy:", vault: vault.logins },
    ]),
    vaultItems: vault.items,
    sharedCards: onePassword,
    agentApiKeys,
    localSkillTools: () => localSkillTools(skills),
    routineFlowTools: () => routineFlowRuntime,
    workflowTools: () => workflowRuntime,
    reviewSkills: (agentId) =>
      skills.listInstalled(agentId).pipe(
        Effect.map((installed) => installed.map(({ skillId, name, description }) => ({ skillId, name, description }))),
        Effect.mapError((cause) => new SkillLearningFailed({ cause })),
      ),
    skillLearning: () => skillLearning.get().mode,
    skillLearner: skillLearning.learner(),
    memoryReviewCursors: new MemoryReviewCursors(join(userData, "memory-review-cursors.json")),
    // `events` is built later.
    webhookRoutines: () => agentWebhookRoutineWriter(events),
    approvalAutomation,
    busyMessageMode: () => busyMessageMode.get().mode,
    agentMemoryLimit: () => agentMemoryLimit.get().limit,
    memoryReviewInterval: () => memoryReview.get().interval,
    timezone: () => serverTimezone.effective(),
    // `workflowTriggers` is built later, after the workflows.
    extraRoutineSources: () => (workflowTriggers ? [workflowTriggers] : []),
    // The delete also clears the agent from workflow nodes. `workflowStore` is built later.
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
  const stopSkillLearningListener = skillLearning.onChange(() => {
    Effect.runFork(service.skillLearningChanged());
  });
  teardown.push(TEARDOWN_ORDER.service - 1, "skill learning settings", stopSkillLearningListener);
  service.setComputerUseCapability(agentDesktop.capability());
  teardown.push(TEARDOWN_ORDER.service, "the agent service", () => runCauseEffect(service.stop()));
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
      changed: (agentIds) => {
        for (const agentId of agentIds) service.notifyRoutineFlowsChanged(agentId);
      },
    }),
  );
  teardown.push(TEARDOWN_ORDER.routineFlows, "the routine flows", () => Effect.runPromise(routineFlowRuntime.close()));
  // Graphs of steps; see `workflows.ts`.
  const workflowStore = new WorkflowStore({
    database: store.database,
    nextDueAt: workflowScheduleDueAt(() => serverTimezone.effective()),
  });
  let connectorWorkflows: WorkflowsHandle | null = null;
  const workflowConnectors = new WorkflowConnectors({
    config: connectorSettings.config,
    publicWebhookOrigin,
    workflows: () => connectorWorkflows,
  });
  await runCauseEffect(workflowConnectors.start());
  teardown.push(TEARDOWN_ORDER.messaging, "workflow connectors", () => runCauseEffect(workflowConnectors.stop()));
  const workflowRuntime = await Effect.runPromise(
    createWorkflows({
      store: workflowStore,
      runs: new WorkflowRunStore({ database: store.database }),
      github: new WorkflowGitHubStore({ database: store.database }),
      githubApp: () => workflowConnectors.githubApp(),
      githubApi: workflowConnectors.githubApi(),
      connectionOn: (connectionId) => workflowConnectors.connectionOn(connectionId),
      post: (connectionId, placeId, markdown) => workflowConnectors.post(connectionId, placeId, markdown),
      slackSend: (connectionId, send) => workflowConnectors.slackSend(connectionId, send),
      telegramSend: (connectionId, send) => workflowConnectors.telegramSend(connectionId, send),
      channelPost: (input) => service.channels.postNote(input),
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
      // No screen shows a workflow notice. The run and its steps stay in the workflow history.
      notify: (notice) => logger.info("A workflow has a notice.", { kind: notice.kind }),
      changed: (workflowId, agentId) => service.notifyWorkflowsChanged(workflowId, agentId),
      rearm: () => service.armRoutines(),
      timezone: () => serverTimezone.effective(),
      runEnded: (end) => service.notifyWorkflowRunEnded(end),
    }),
  );
  connectorWorkflows = workflowRuntime;
  workflowTriggers = new WorkflowTriggers({
    store: workflowStore,
    timezone: () => serverTimezone.effective(),
    start: (start) => workflowRuntime.startScheduled(start),
    changed: (workflowId) => service.notifyWorkflowsChanged(workflowId),
  });
  service.armRoutines();
  vault.onChanged(() => service.notifyVaultChanged());
  // A changed or deleted Vault API key reaches the file that an agent reads at once.
  vault.onChanged(() => void Effect.runPromise(agentApiKeys.syncVault().pipe(Effect.ignore)));
  teardown.push(TEARDOWN_ORDER.workflows, "the workflows", () => Effect.runPromise(workflowRuntime.close()));
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
  // A server that already has an MCP server to start fetches its tool runtimes now.
  if (!setupState.completed || service.enabledMcpServers().length > 0)
    Effect.runFork(providerRuntimes.ensureToolRuntimes());
  // After `new AgentService`, which owns the channels.
  await runCauseEffect(sidebarLayout.reconcileAgents(service.sidebarChatIds()));
  // The runtime manager knows the copies it downloaded itself; a CLI the user installed is only
  // reported in the agent status, so it is passed on from here.
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
  const appUpgraded = providerCliAppVersion.get().appVersion !== app.getVersion();
  providerRuntimes.startUpdateChecks({ updateInstalled: appUpgraded });
  if (appUpgraded)
    void runCauseEffect(providerCliAppVersion.set({ appVersion: app.getVersion() })).catch((error) =>
      logger.warn("The provider CLI app version did not save.", toLogValue(error)),
    );
  // A tool runtime that becomes ready changes what the MCP servers resolve to, for every provider.
  providerRuntimes.on("ready", (runtime) => {
    if (isManagedToolRuntime(runtime)) Effect.runFork(service.refreshAllAgentRuntimes());
  });
  // A grant changed by an agent reaches every view of the agents.
  approvalAutomation.subscribe(() => service.notifyAgentsChanged());
  // The webhooks of routines and workflows. They arrive on the public listener below.
  const events = new HostEventsService({
    routines: service.routineRecords,
    workflows: {
      receive: (delivery) => workflowRuntime.receiveWebhook(delivery),
      changed: (workflowId) => service.notifyWorkflowsChanged(workflowId),
    },
    cipher: secretCipher,
    relay: webhookRoutes,
    accountPrincipal: () => SERVER_OWNER_ID,
  });
  const eventsRuntime = new HostEventsRuntime(events);
  const webhookIngress = new DirectWebhookIngress({
    events: () => events,
    connectors: workflowConnectors,
    enabled: () => publicWebhookOrigin !== null,
  });
  teardown.push(TEARDOWN_ORDER.hostEvents, "the event service", async () => {
    await Effect.runPromise(eventsRuntime.stop());
  });
  const trace = new TraceFile({ directory: join(userData, "logs") });
  teardown.push(TEARDOWN_ORDER.trace, "the trace file", () => Effect.runPromise(trace.close()));
  const resourceMonitor = new ResourceMonitor({
    userDataPath: userData,
    server: true,
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
  const agentInitialization = new AgentInitializationGate((rosterLoaded) =>
    Effect.gen(function* () {
      yield* service.initialize({
        heldRoutines: takeRoutineHold(join(userData, ROUTINE_HOLD_FILE), (message) => logger.warn(message)),
        rosterLoaded,
      });
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
  let telegram: ReturnType<typeof createTelegramRuntime> | null = null;
  if (telegramSettings) {
    const runtime = createTelegramRuntime({
      settings: telegramSettings,
      dataRoot: userData,
      service,
      sidebar: sidebarLayout,
      mailbox,
      database: store.database,
      browser,
      ready: () => agentInitialization.succeeded,
    });
    telegram = runtime;
    const startup = Effect.runFork(
      runtime.start.pipe(
        Effect.catchCause(() =>
          Effect.sync(() =>
            logger.warn(
              "Telegram did not start. Check the manager token, Bot Management Mode, HTTPS address and local state.",
            ),
          ),
        ),
      ),
    );
    teardown.push(TEARDOWN_ORDER.messaging - 1, "Telegram", async () => {
      telegram = null;
      await Effect.runPromise(Fiber.interrupt(startup));
      await Effect.runPromise(runtime.stop);
    });
  }
  // The one public entry: Telegram first, then the workflow and routine webhooks.
  const publicHttp = new PublicHttpServer(
    { host: "127.0.0.1", port: readPublicPort(process.env.TOMMY_DIRECT_PORT) },
    (): PublicHttpRoute[] => [
      (request, response) => telegram?.handle(request, response) ?? Effect.succeed(false),
      (request, response) => webhookIngress.handle(request, response),
    ],
  );
  await runCauseEffect(publicHttp.start()).catch((error) =>
    logger.error("The public listener did not start:", toLogValue(error)),
  );
  webhookRoutes.setListening(publicHttp.listening);
  teardown.push(TEARDOWN_ORDER.publicHttp, "the public listener", async () => {
    webhookRoutes.setListening(false);
    await Effect.runPromise(publicHttp.stop());
  });
  if (serverModeEnvironment) {
    const serverMode = new ServerMode({
      environment: serverModeEnvironment,
      version: app.getVersion(),
      status: () => ({
        public_listener: publicHttp.listening ? "listening" : "stopped",
        telegram: telegramSettings ? "on" : "off",
      }),
      memory: hostMemory,
      onError: (message, error) => logger.warn(message, toLogValue(error)),
      agents: () =>
        telegram?.agents() ??
        service
          .listAgents()
          .filter((agent) => agent.hiddenAt === undefined)
          .map((agent) => ({ id: agent.id, name: agent.name, provider: agent.provider, chat: false })),
      handoff: (input) =>
        telegram
          ? Effect.runPromise(telegram.handoff(input))
          : Promise.reject(new Error("Telegram is not set up on this server.")),
    });
    // Without the socket the server still runs, and the log says why.
    await runCauseEffect(serverMode.listen()).catch((error) =>
      logger.error("The server control socket did not start:", toLogValue(error)),
    );
    teardown.push(TEARDOWN_ORDER.serverMode, "the server control socket", () => Effect.runPromise(serverMode.close()));
  }

  return {
    service,
    prewarmAgentDatabase: tables.prewarm(),
    providerRuntimes,
    agentInitialization,
    eventsRuntime,
    publicHttp,
    trace,
  };
}
