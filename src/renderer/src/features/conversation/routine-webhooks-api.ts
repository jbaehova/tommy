import type { ServerSummary } from "@tommy/contracts/ipc";
import type {
  EventActivity,
  EventRoutine,
  EventRoutineRef,
  EventRoutineRun,
  EventStatus,
  ListEventActivityInput,
  ListEventRoutineRunsInput,
  ListEventRoutinesInput,
  SaveEventRoutineInput,
  SaveEventRoutineResult,
  WebhookSecret,
  WebhookTestResult,
} from "@tommy/contracts/ipc-events";
import type { SetRoutineSenderSecretInput } from "@tommy/contracts/ipc-webhook-sender-secret";
import { WEBHOOK_SENDER_SECRET_CAPABILITY } from "@tommy/contracts/team-protocol/webhook-sender-secret-v1";
import { remoteRoutineRecovery, serverCanAdminister, serverSendsWebhookTests } from "../servers/server-capabilities";
import type { ConversationRuntime } from "./conversation-runtime";

/** The webhook operations of one host that the routine editor uses. Every action names its routine. */
export interface RoutineWebhooksApi {
  /** The host identity used to discard a write-only key when views change. */
  readonly scopeId?: string | undefined;
  readonly setSenderSecret?: ((input: SetRoutineSenderSecretInput) => Promise<void>) | undefined;
  getStatus: () => Promise<EventStatus>;
  rotateSecret: (input: EventRoutineRef) => Promise<WebhookSecret>;
  listActivity: (input: ListEventActivityInput) => Promise<EventActivity[]>;
  /** Set for this computer's host and a remote host with `webhook-tests-v1`: sends one signed test event. */
  readonly sendTestEvent?: ((input: EventRoutineRef) => Promise<WebhookTestResult>) | undefined;
}

/** The event routine operations of one host: the routines themselves, their webhooks and their activity. */
export interface EventRoutinesApi extends RoutineWebhooksApi {
  listRoutines: (input: ListEventRoutinesInput) => Promise<EventRoutine[]>;
  saveRoutine: (input: SaveEventRoutineInput) => Promise<SaveEventRoutineResult>;
  deleteRoutine: (input: EventRoutineRef) => Promise<void>;
  testRoutine: (input: EventRoutineRef) => Promise<void>;
  /**
   * Set for a remote host with `routine-recovery-v1`: the routine's runs with its missed occurrences.
   * The same host also reads and saves `missedPolicy`.
   */
  readonly listRuns?: ((input: ListEventRoutineRunsInput) => Promise<EventRoutineRun[]>) | undefined;
}

/** Discards an entered key after reconnects, role changes, or a signed host-key handover. */
export function routineWebhookScope(server: ServerSummary | undefined): string {
  return server
    ? `${server.id}:${server.apiUrl ?? ""}:${server.connectionSequence ?? 0}:${server.keyChangedAt ?? 0}:${server.role ?? ""}`
    : "local";
}

/**
 * The event API of the host of a desktop chat, when this person can manage its webhook routines.
 * A chat with a `runtime` is the browser client, which has no desktop bridge.
 */
export function desktopChatEventRoutinesApi(
  server: ServerSummary | undefined,
  runtime: ConversationRuntime | undefined,
): EventRoutinesApi | undefined {
  return !runtime && serverCanAdminister(server, "events-v1")
    ? desktopEventRoutinesApi(
        server.id,
        remoteRoutineRecovery(server),
        serverSendsWebhookTests(server),
        serverCanAdminister(server, WEBHOOK_SENDER_SECRET_CAPABILITY),
        routineWebhookScope(server),
      )
    : undefined;
}

/**
 * The desktop adapter for the server-scoped `events` group. Main picks the `routine-recovery-v1`
 * routes for a host that has them; `recovery` adds the run list of those routes, and `tests` the
 * test event of a host that sends one.
 */
export function desktopEventRoutinesApi(
  serverId: string,
  recovery = false,
  tests = false,
  senderKeys = serverId === "local",
  scopeId = serverId,
): EventRoutinesApi {
  const events = window.tommy.events;
  return {
    scopeId,
    ...(senderKeys
      ? { setSenderSecret: (input: SetRoutineSenderSecretInput) => events.setSenderSecret(input, serverId) }
      : {}),
    ...(recovery ? { listRuns: (input: ListEventRoutineRunsInput) => events.listRoutineRuns(input, serverId) } : {}),
    ...(tests ? { sendTestEvent: (input: EventRoutineRef) => events.sendTestEvent(input, serverId) } : {}),
    getStatus: () => events.getStatus(serverId),
    listRoutines: (input) => events.listRoutines(input, serverId),
    saveRoutine: (input) => events.saveRoutine(input, serverId),
    deleteRoutine: (input) => events.deleteRoutine(input, serverId),
    testRoutine: (input) => events.testRoutine(input, serverId),
    rotateSecret: (input) => events.rotateSecret(input, serverId),
    listActivity: (input) => events.listActivity(input, serverId),
  };
}
