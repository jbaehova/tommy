import type { ManagedProviderId, ManagedToolRuntimeId } from "./agent-providers";
import type { AgentModelId } from "./ipc-agent-identity";
import type { AgentProviderId } from "./ipc-agent-status";

export type HourCycle = "h12" | "h23";

/** The phase list is the source of truth: `UpdatePhase` is derived from it. */
export const UPDATE_PHASES = [
  "idle",
  "checking",
  "available",
  "downloading",
  "ready",
  "installing",
  "up-to-date",
  "error",
  "unsupported",
] as const;

export type UpdatePhase = (typeof UPDATE_PHASES)[number];

export const UPDATE_FAILURE_CODES = ["check_failed", "download_failed", "install_failed"] as const;
export type UpdateFailureCode = (typeof UPDATE_FAILURE_CODES)[number];

export interface UpdatePreference {
  autoDownload: boolean;
  /** Owners and admins of a joined server can start an update of this computer. */
  allowRemoteUpdates: boolean;
  /** Restart into a downloaded update when no work runs, without a request. */
  autoInstall: boolean;
}

/** `now` restarts as soon as the update is ready; `when-idle` waits until no work runs. */
export const UPDATE_RESTART_MODES = ["when-idle", "now"] as const;
export type UpdateRestartMode = (typeof UPDATE_RESTART_MODES)[number];

export interface ScheduledUpdateRestart {
  /** The name of the member who asked, or null when this computer installs updates automatically. */
  requestedBy: string | null;
  mode: UpdateRestartMode;
  /** The restart blockers that still run, such as `agent-turn`. Empty when none. */
  waitingFor: string[];
}

/** `managed`: a Host Manager controls the updates of this host. */
export const REMOTE_UPDATES_STATES = ["allowed", "disabled", "managed"] as const;
export type RemoteUpdatesState = (typeof REMOTE_UPDATES_STATES)[number];

/** The app update of a joined server's host, as `host-update-v1` reports it. */
export interface HostUpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  /** An integer from 0 to 100, or null. */
  progress: number | null;
  errorCode: UpdateFailureCode | null;
  remoteUpdates: RemoteUpdatesState;
  autoDownload: boolean;
  autoInstall: boolean;
  restart: ScheduledUpdateRestart | null;
}

/** The host's update switches that an admin sets. An absent field keeps its stored value. */
export type HostUpdateSettingsChange = Partial<Pick<UpdatePreference, "autoDownload" | "autoInstall">>;

export type ProviderRuntimePhase = "not-downloaded" | "downloading" | "finishing" | "ready" | "download-error";

export interface ProviderRuntimeStatus {
  /**
   * The newer version an update installs, when an older install exists: the latest upstream release
   * the last check found, or the version this Tommy release carries, whichever is newer.
   */
  availableVersion?: string | null;
  phase: ProviderRuntimePhase;
  progress: number | null;
  message: string | null;
  version: string | null;
}

export interface ProviderRuntimeSnapshot {
  revision: number;
  /**
   * Only the providers whose CLI Tommy downloads and pins itself. A provider that ships without a
   * managed runtime is absent from `ManagedProviderId`, so it needs no fake entry here, and every
   * provider that is in the tuple has a real status.
   */
  providers: Record<ManagedProviderId, ProviderRuntimeStatus>;
  /**
   * The tool runtimes, in a field of their own rather than mixed in above.
   *
   * These are downloaded for the MCP servers, not for an agent: nothing signs in to one, nothing
   * picks a model on one, and the provider cards must not grow an entry for one. Required, so a
   * reader that needs the status of a managed tool cannot silently read `undefined` instead.
   */
  toolRuntimes: Record<ManagedToolRuntimeId, ProviderRuntimeStatus>;
}

export interface AppSetupState {
  completed: boolean;
  preferredProvider: AgentProviderId | null;
  /**
   * The model setup chose beside the provider, and `null` when the user took the provider's own
   * default. A new agent starts on it while that provider still lists it, which is how a custom
   * endpoint becomes the default: the provider is the CLI that runs it, and only the model names it.
   */
  preferredModel: AgentModelId | null;
}

export interface SaveSetupInput {
  preferredProvider: AgentProviderId;
  preferredModel: AgentModelId | null;
}

export interface CentralAuthUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export type ExternalDestination =
  | "opencode-install"
  | "opencode-auth"
  | "agent-setup"
  | "claude-install"
  | "hermes-install"
  // The x.ai marketplace listing of the Grok Bot agent that exports agents for Tommy.
  | "grok-bot-export"
  // Not a page: the macOS pane that grants Tommy screen recording. It is here rather than behind
  // its own endpoint because the destination is still a fixed address the renderer only names.
  | "mac-screen-recording";
