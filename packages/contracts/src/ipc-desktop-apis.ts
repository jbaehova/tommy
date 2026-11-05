import type { AgentEvent } from "./ipc-agent-events";
import type { AgentFolderChange } from "./ipc-agent-folders";
import type { AttachmentImportEvent } from "./ipc-attachments";
import type { BrowserLiveViewInput } from "./ipc-browser";
import type { BridgedDesktopApi, GroupApi, IpcEndpoints, PathApi } from "./ipc-endpoints";
import type { TeamPresenceSnapshot } from "./ipc-team-host";

/**
 * Every agent group, spread into one namespace. Each scoped method takes its server last; left out,
 * it is the selected server. `onEvent` is `onScopedEvent` filtered to the selected server, and
 * `onAttachmentImport` reports the files the preload imports from a drop or a paste.
 */
export interface AgentDesktopApi extends PathApi<"agent"> {
  /** Gives the agent a folder that the user dropped. The preload reads its path; the page never does. */
  addDroppedAgentFolder: (agentId: string, folder: File) => Promise<AgentFolderChange>;
  onAttachmentImport: (listener: (event: AttachmentImportEvent) => void) => () => void;
  onEvent: (listener: (event: AgentEvent) => void) => () => void;
}

/**
 * `startLiveView` starts a live view of a tab on the active remote server; a local tab is already on
 * screen. `sendLiveViewInput` is the untyped `browserInput` endpoint, so it is written here.
 */
export interface BrowserDesktopApi extends GroupApi<IpcEndpoints["browser"]> {
  sendLiveViewInput: (input: BrowserLiveViewInput) => Promise<void>;
}

export type ProviderRuntimesDesktopApi = GroupApi<IpcEndpoints["providerRuntimes"]>;

/**
 * The preload wraps some bridged methods: the server list calls record which server is selected, and
 * `onEvent` does too. The scoped events come from every server; the three methods below keep one.
 */
export interface ServersDesktopApi extends GroupApi<IpcEndpoints["servers"]> {
  /** `onScopedPresence` for one server: the selected one when `serverId` is left out. */
  onPresence: (listener: (snapshot: TeamPresenceSnapshot) => void, serverId?: string) => () => void;
}

export type RoutineFeedDesktopApi = GroupApi<IpcEndpoints["routineFeed"]>;

/**
 * The user's own model endpoints. `save` and `delete` both answer with the whole list plus how the
 * provider restart went, so the renderer replaces its snapshot in one write and can say honestly
 * whether the models are on their way.
 */

/**
 * Local model servers on this computer, the model list of one endpoint, and where the scan looks.
 * Main makes each request; a scan sends no key.
 */

/**
 * The providers of one server's host: code sign-in, API keys, managed CLI runtimes and custom
 * endpoints. Every method names its server. A remote host answers only an owner or admin, and only
 * when it advertises `providers-v1`.
 */
export type ProviderAdminDesktopApi = GroupApi<IpcEndpoints["providerAdmin"]>;

/** The Slack workspaces where this computer's agents answer. */

/**
 * Agent import into the local host. `choose` opens the file dialog and answers null when the user
 * cancels. A token is used once: `apply` and `discard` both release the staged archive.
 */

// Each member is at its place in `IPC_GROUP_PATHS`, so a new group needs no line here. Only the
// members with methods that the preload writes by hand are named.
export interface TommyDesktopApi extends Omit<BridgedDesktopApi, "agent" | "browser" | "servers"> {
  agent: AgentDesktopApi;
  browser: BrowserDesktopApi;
  servers: ServersDesktopApi;
}
