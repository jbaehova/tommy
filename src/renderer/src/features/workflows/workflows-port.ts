import type {
  AgentAccessLevels,
  ServerSummary,
  TommyDesktopApi,
  WorkflowIntegrationCatalog,
} from "@tommy/contracts/ipc";
import { WORKFLOWS_EXTENSIONS_CAPABILITY } from "@tommy/contracts/team-protocol/workflows-extensions-v1";
import { WORKFLOWS_GITHUB_CAPABILITY } from "@tommy/contracts/team-protocol/workflows-github-v1";
import type {
  WorkflowChannel,
  WorkflowDiscordServer,
  WorkflowPlace,
  WorkflowSlackWorkspace,
  WorkflowTelegramChat,
} from "@tommy/ui/features/workflows/workflow-model";
import { serverRoleCanAdminister } from "../servers/server-capabilities";

type WorkflowsApi = TommyDesktopApi["workflows"];
/** The methods that take only the server. */
type NoInputMethod = "list" | "githubCatalog" | "integrationCatalog";
/** Each method with its input only; `list` and `githubCatalog` take none. */
type BoundWorkflowsApi = {
  [Name in Exclude<keyof WorkflowsApi, NoInputMethod>]: (
    input: Parameters<WorkflowsApi[Name]>[0],
  ) => ReturnType<WorkflowsApi[Name]>;
} & { [Name in NoInputMethod]: () => ReturnType<WorkflowsApi[Name]> };

/**
 * What the Workflows page reaches on one server: the workflows, the changes that make one stale, and
 * the messaging places an output can post to. The desktop app reaches this computer or a joined
 * server through main.
 */
export interface WorkflowHost {
  /** Called without a server: the host already names one. */
  workflows: BoundWorkflowsApi;
  /**
   * Calls `changed` with the workflow that changed, or null when all can be stale: the server came
   * back, or the agent levels changed. `agentId`: the agent whose tool call made or saved the
   * workflow. Only this computer names it; a joined server does not.
   */
  onChanged(changed: (workflowId: string | null, agentId?: string) => void): () => void;
  /** A channel can be added, archived or restored while the canvas is open. */
  onChannelsChanged?(changed: () => void): () => void;
  /** Non-secret destinations offered by this host's configured connectors. */
  places(): Promise<WorkflowPlace[]>;
  /** The open Tommy channels that an output can post to. */
  channels(): Promise<WorkflowChannel[]>;
  /** The Discord servers offered by this host's configured connectors. */
  discordServers(): Promise<WorkflowDiscordServer[]>;
  /** The Telegram chats offered by this host's configured connectors. */
  telegramChats(): Promise<WorkflowTelegramChat[]>;
  /** The Slack workspaces offered by this host's configured connectors. */
  slackWorkspaces(): Promise<WorkflowSlackWorkspace[]>;
  /** The level of this account on each agent that it sees, or null when it manages all of them. */
  agentLevels(): Promise<AgentAccessLevels | null>;
  /**
   * Whether the host runs GitHub triggers and outputs: this computer always, and a joined server only
   * when it advertises `workflows-github-v1`.
   */
  githubSupported(): boolean;
  /** Whether this host serves the optional workflow connector and channel extensions. */
  extensionsSupported?(): boolean;
  /** Whether an administrator can store an external sender signing key. */
  senderKeysSupported?(): boolean;
  senderKeyScope?(): string;
  /** The joined server, as its server row names it, or undefined for this computer. */
  hostName(): string | undefined;
  /** Opens an http or https page in the browser. */
  openUrl(url: string): Promise<void>;
}

/**
 * The desktop adapter for one server. `window.tommy` and `server` are read on each call: tests and
 * stories replace them per case, and a role can change.
 */
export function desktopWorkflowHost(serverId: string, server: () => ServerSummary | undefined): WorkflowHost {
  const api = () => window.tommy.workflows;
  /** A server that has not loaded yet is this computer, as the page reads it. */
  const local = () => server()?.kind !== "remote";
  const githubSupported = () =>
    local() || server()?.compatibility?.capabilities.includes(WORKFLOWS_GITHUB_CAPABILITY) === true;
  const integrationsSupported = () =>
    local() || server()?.compatibility?.capabilities.includes(WORKFLOWS_EXTENSIONS_CAPABILITY) === true;
  const catalogSupported = () => integrationsSupported() && (local() || serverRoleCanAdminister(server()));
  /** Share one catalog read across the destination pickers. A change or reconnect reads it again. */
  let catalog: Promise<WorkflowIntegrationCatalog> | undefined;
  const integrationCatalog = () => {
    if (!catalog)
      catalog = api()
        .integrationCatalog(serverId)
        .catch((error: unknown) => {
          catalog = undefined;
          throw error;
        });
    return catalog;
  };
  return {
    workflows: {
      list: () => api().list(serverId),
      get: (workflowId) => api().get(workflowId, serverId),
      create: (input) => api().create(input, serverId),
      rename: (input) => api().rename(input, serverId),
      delete: (workflowId) => api().delete(workflowId, serverId),
      saveGraph: (input) => api().saveGraph(input, serverId),
      versions: (workflowId) => api().versions(workflowId, serverId),
      versionGraph: (input) => api().versionGraph(input, serverId),
      restoreVersion: (input) => api().restoreVersion(input, serverId),
      startRun: (input) => api().startRun(input, serverId),
      runStep: (input) => api().runStep(input, serverId),
      stopStep: (stepId) => api().stopStep(stepId, serverId),
      stopRun: (runId) => api().stopRun(runId, serverId),
      retryStep: (input) => api().retryStep(input, serverId),
      decide: (input) => api().decide(input, serverId),
      runs: (input) => api().runs(input, serverId),
      run: (runId) => api().run(runId, serverId),
      rotateWebhookSecret: (input) => api().rotateWebhookSecret(input, serverId),
      setSenderSecret: (input) => api().setSenderSecret(input, serverId),
      githubCatalog: () => api().githubCatalog(serverId),
      githubOptions: (input) => api().githubOptions(input, serverId),
      githubHistory: (workflowId) => api().githubHistory(workflowId, serverId),
      githubRunLastEvent: (input) => api().githubRunLastEvent(input, serverId),
      integrationCatalog,
    },
    onChanged(changed) {
      const unsubscribe = window.tommy.agent.onScopedEvent((scoped) => {
        if (scoped.serverId !== serverId) return;
        if (scoped.event.type === "workflows-changed") {
          catalog = undefined;
          changed(scoped.event.workflowId, scoped.event.agentId);
        } else if (scoped.event.type === "agent-access-changed") {
          catalog = undefined;
          changed(null);
        }
      });
      const reconnect = window.tommy.servers.onEvent((servers) => {
        if (servers.some((server) => server.id === serverId && server.state === "online")) {
          catalog = undefined;
          changed(null);
        }
      });
      return () => {
        unsubscribe();
        reconnect();
      };
    },
    onChannelsChanged(changed) {
      return window.tommy.agent.onScopedEvent((scoped) => {
        if (scoped.serverId === serverId && scoped.event.type === "channels-changed") changed();
      });
    },
    async places() {
      if (!catalogSupported()) return [];
      return (await integrationCatalog()).places;
    },
    async channels() {
      if (!integrationsSupported()) return [];
      return (await window.tommy.agent.listChannels(serverId))
        .filter((channel) => !channel.archived)
        .map((channel) => ({ id: channel.id, name: channel.name }));
    },
    async discordServers() {
      if (!catalogSupported()) return [];
      return (await integrationCatalog()).discord;
    },
    async telegramChats() {
      if (!catalogSupported()) return [];
      return (await integrationCatalog()).telegram;
    },
    async slackWorkspaces() {
      if (!catalogSupported()) return [];
      return (await integrationCatalog()).slack;
    },
    async agentLevels() {
      if (local() || serverRoleCanAdminister(server())) return null;
      return (await window.tommy.hostAdmin.getAgentAccess(serverId)).mine;
    },
    githubSupported,
    extensionsSupported: integrationsSupported,
    senderKeysSupported: () =>
      local() ||
      (serverRoleCanAdminister(server()) &&
        server()?.compatibility?.capabilities.includes("webhook-sender-secret-v1") === true),
    senderKeyScope: () =>
      `${serverId}:${server()?.apiUrl ?? ""}:${server()?.connectionSequence ?? 0}:${server()?.keyChangedAt ?? 0}:${server()?.role ?? ""}`,
    hostName: () => (local() ? undefined : server()?.name),
    openUrl: (url) => window.tommy.openUrl(url),
  };
}
