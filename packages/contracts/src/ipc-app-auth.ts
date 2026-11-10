import type { ManagedProviderId, ManagedToolRuntimeId } from "./agent-providers";
import type { AgentModelId } from "./ipc-agent-identity";
import type { AgentProviderId } from "./ipc-agent-status";
import { integerInRange, isFiniteNumber, isIdentifier } from "./ipc-bounded-values";
import { isDynamicRecord, isString } from "./runtime-values";

export type DesktopPlatform = "darwin" | "linux";
export type AppVariant = "production" | "dev" | "preview";

export type HourCycle = "h12" | "h23";

export interface AppInfo {
  name: string;
  version: string;
  platform: DesktopPlatform;
  variant: AppVariant;
  hourCycle?: HourCycle;
}

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

/**
 * Phases where the user is waiting on work already under way. Every one of these must be bounded by
 * a timeout in the main-process updater, otherwise the UI renders a spinner that can never resolve.
 */
export const UPDATE_BUSY_PHASES = ["checking", "downloading", "installing"] as const satisfies readonly UpdatePhase[];

export type UpdateBusyPhase = (typeof UPDATE_BUSY_PHASES)[number];

const BUSY_PHASES = new Set<UpdatePhase>(UPDATE_BUSY_PHASES);

export function isUpdateBusyPhase(phase: UpdatePhase): phase is UpdateBusyPhase {
  return BUSY_PHASES.has(phase);
}

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  progress: number | null;
  checkedAt: string | null;
  message: string | null;
  errorCode: UpdateFailureCode | null;
  /**
   * True on a Mac whose host manages updates for every tenant. The tenant UI hides its own
   * install, download and check actions but keeps showing the status; absent means unmanaged.
   */
  managedByHost?: boolean;
  /** A restart that an admin of a joined server asked for. Absent when none waits. */
  scheduledRestart?: ScheduledUpdateRestart;
  /** A restart that the user of this computer asked for. Absent when none waits. */
  idleRestart?: IdleRestart;
}

/** `relaunch` starts Tommy again; `update` installs the downloaded update. */
export const IDLE_RESTART_TARGETS = ["relaunch", "update"] as const;
export type IdleRestartTarget = (typeof IDLE_RESTART_TARGETS)[number];

/**
 * A restart that waits until no work runs. New routine runs wait for it, so a busy schedule does not
 * stop it; they run after the restart, or after a cancel.
 */
export interface IdleRestart {
  target: IdleRestartTarget;
  /** The restart blockers that still run, such as `agent-turn`. Empty when none. */
  waitingFor: string[];
  /** Why the restart did not start. Nothing waits then, and the routines run again. */
  error?: string;
}

export const UPDATE_FAILURE_CODES = ["check_failed", "download_failed", "install_failed"] as const;
export type UpdateFailureCode = (typeof UPDATE_FAILURE_CODES)[number];

export interface UpdatePreference {
  autoDownload: boolean;
  /** Owners and admins of a joined server can start an update of this computer. */
  allowRemoteUpdates: boolean;
  /** Restart into a downloaded update when no work runs, without a request. */
  autoInstall: boolean;
}

/** The fields to change. An absent field keeps its stored value. */
export type UpdatePreferenceChange = Partial<UpdatePreference>;

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

export interface ExportResult {
  saved: boolean;
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

export interface CentralAuthIssue {
  code: string;
  message: string;
  retryAfterSeconds?: number;
  /** A short code a user can copy into a report, such as `auth/timeout`. */
  reference?: string;
}

export type CentralAuthState =
  | { status: "loading" }
  | { status: "signed_out" }
  | { status: "signing_in" }
  | {
      status: "code_sent";
      challengeId: string;
      email: string;
      expiresAt: number;
      resendAvailableAt: number;
      developmentCode?: string;
      issue?: CentralAuthIssue | undefined;
    }
  | { status: "signed_in"; user: CentralAuthUser }
  | { status: "error"; issue: CentralAuthIssue };

/** The server address and the code from `tommy pair`. */
export interface PairDeviceInput {
  address: string;
  code: string;
}

export type MacPermissionId = "screen-recording" | "accessibility";

/**
 * The Apple apps an MCP server may drive through AppleScript. macOS asks once for each, under
 * Privacy & Security › Automation, and keeps the answer for Tommy.
 */
export const MAC_AUTOMATION_TARGETS = [
  "calendar",
  "contacts",
  "mail",
  "notes",
  "reminders",
  "messages",
  "safari",
] as const;

export type MacAutomationTarget = (typeof MAC_AUTOMATION_TARGETS)[number];

export const MAC_AUTOMATION_STATUSES = ["granted", "denied", "failed"] as const;

/**
 * The answer for one app. `denied` is the user's refusal, now or earlier: macOS does not ask again,
 * and only System Settings can change it. `failed` is anything else, such as an app that is not there.
 */
export interface MacAutomationResult {
  target: MacAutomationTarget;
  status: (typeof MAC_AUTOMATION_STATUSES)[number];
}

/**
 * A program that an agent started and left running after its tool call, such as a dev server that
 * `nohup ... &` started. The system adopted it, so no provider process of Tommy holds it now.
 */
export interface BackgroundProcess {
  /** The pid and the start time: a pid is reused. Stop takes it. */
  id: string;
  pid: number;
  /** The command line with secrets redacted. */
  command: string;
  /** Milliseconds since the epoch. */
  startedAt: number;
  /** The TCP ports that the process or its children listen on. */
  ports: number[];
  /** The agent whose workspace holds the working folder of the process, or null when none does. */
  agentId: string | null;
}

export function isBackgroundProcess(value: unknown): value is BackgroundProcess {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    integerInRange(value.pid, 1, Number.MAX_SAFE_INTEGER) &&
    isString(value.command) &&
    isFiniteNumber(value.startedAt) &&
    Array.isArray(value.ports) &&
    value.ports.every((port) => integerInRange(port, 1, 65_535)) &&
    (value.agentId === null || isIdentifier(value.agentId))
  );
}

/**
 * One chat that is open in its own window as well as in the main window (#2964). The main window
 * keeps the chat; closing the extra window closes only the window.
 */
export interface ChatWindowTarget {
  serverId: string;
  agentId: string;
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
