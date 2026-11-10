import { guardedDecoder, guardedListDecoder } from "@tommy/contracts/ipc-decoding";
import {
  decodeEventActivity,
  decodeEventRoutineRuns,
  decodeEventRoutines,
  decodeEventStatus,
  decodeSaveEventRoutineResult,
  decodeWebhookSecret,
  decodeWebhookTestResult,
  isEventRoutineWithRunPlace,
  isSaveEventRoutineResultWithRunPlace,
} from "@tommy/contracts/ipc-events";
import { parseSetRoutineSenderSecret } from "@tommy/contracts/ipc-webhook-sender-secret";
import type { TeamCurrentCapability } from "@tommy/contracts/team-protocol/current";
import { EVENTS_CAPABILITY, EVENTS_ROUTES } from "@tommy/contracts/team-protocol/events-v1";
import {
  ROUTINE_RECOVERY_CAPABILITY,
  ROUTINE_RECOVERY_ROUTES,
} from "@tommy/contracts/team-protocol/routine-recovery-v1";
import {
  ROUTINE_RUN_PLACE_CAPABILITY,
  ROUTINE_RUN_PLACE_ROUTES,
} from "@tommy/contracts/team-protocol/routine-run-place-v1";
import {
  WEBHOOK_SENDER_SECRET_CAPABILITY,
  WEBHOOK_SENDER_SECRET_ROUTES,
} from "@tommy/contracts/team-protocol/webhook-sender-secret-v1";
import { WEBHOOK_TESTS_CAPABILITY, WEBHOOK_TESTS_ROUTES } from "@tommy/contracts/team-protocol/webhook-tests-v1";
import { sourceText } from "@tommy/i18n/source";
import { registerSecretValue } from "@tommy/logging";
import type { Effect } from "effect";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { HostEventsApi } from "../host-events-api";
import {
  parseEventRoutineRef,
  parseListEventActivity,
  parseListEventRoutineRuns,
  parseListEventRoutines,
  parseSaveEventRoutine,
} from "../host-events-inputs";
import { acceptEmpty, type ResponseDecoder } from "../remote-host-decoding";
import type { RemoteRequestInit } from "../remote-server-client";
import type { RemoteWorkflowError } from "../remote-service-effects";
import { isStandardWebhookSecret } from "../webhook-security";
import type { IpcGroupHandlers } from "./define-ipc-group";
import { scopedHandler, scopedQueryHandler } from "./scoped-handler";

interface EventsRemoteServers {
  supportsCapability(serverId: string, capability: TeamCurrentCapability): boolean;
  request<T>(
    serverId: string,
    path: string,
    decoder: ResponseDecoder<T>,
    init?: RemoteRequestInit,
  ): Effect.Effect<T, RemoteWorkflowError>;
}

interface EventsIpcDependencies {
  events: HostEventsApi;
  remoteServers: EventsRemoteServers;
}

const decodeEventRoutinesFromHost = guardedListDecoder(isEventRoutineWithRunPlace, "event routine response");
const decodeSavedEventRoutineFromHost = guardedDecoder(
  isSaveEventRoutineResultWithRunPlace,
  "saved event routine response",
);

export function eventsIpcHandlers({ events, remoteServers }: EventsIpcDependencies): Pick<IpcGroupHandlers, "events"> {
  function remote<T>(serverId: string, path: string, decoder: (value: unknown) => T, body: unknown = {}): Promise<T> {
    if (!remoteServers.supportsCapability(serverId, EVENTS_CAPABILITY))
      throw new Error(sourceText("error.backend.eventsUnavailable"));
    return runCauseEffect(remoteServers.request(serverId, path, decoder, { method: "POST", body }));
  }
  /** A host with `routine-recovery-v1` reads and saves `missedPolicy`, which the `events-v1` routes drop. */
  function recovery(serverId: string): boolean {
    return remoteServers.supportsCapability(serverId, ROUTINE_RECOVERY_CAPABILITY);
  }
  return {
    events: {
      setSenderSecret: scopedHandler(parseSetRoutineSenderSecret, {
        local: (input) => runCauseEffect(events.setRoutineSenderSecret(input)),
        remote: (input, serverId) => {
          if (!remoteServers.supportsCapability(serverId, WEBHOOK_SENDER_SECRET_CAPABILITY))
            throw new Error(sourceText("error.backend.eventsUnavailable"));
          if (!isStandardWebhookSecret(input.secret))
            throw new Error(sourceText("error.backend.webhookSettingsInvalid"));
          registerSecretValue(input.secret);
          return runCauseEffect(
            remoteServers.request(serverId, WEBHOOK_SENDER_SECRET_ROUTES.routine, acceptEmpty, {
              method: "POST",
              body: input,
            }),
          );
        },
      }),
      getStatus: scopedQueryHandler({
        local: () => runCauseEffect(events.getStatus()),
        remote: (serverId) =>
          remoteServers.supportsCapability(serverId, EVENTS_CAPABILITY)
            ? remote(serverId, EVENTS_ROUTES.status, decodeEventStatus)
            : Promise.resolve({ supported: false, connected: false }),
      }),
      listRoutines: scopedHandler(parseListEventRoutines, {
        local: (input) => runCauseEffect(events.listRoutines(input)),
        remote: (input, serverId) =>
          remote(
            serverId,
            remoteServers.supportsCapability(serverId, ROUTINE_RUN_PLACE_CAPABILITY)
              ? ROUTINE_RUN_PLACE_ROUTES.eventList
              : recovery(serverId)
                ? ROUTINE_RECOVERY_ROUTES.listRoutines
                : EVENTS_ROUTES.listRoutines,
            remoteServers.supportsCapability(serverId, ROUTINE_RUN_PLACE_CAPABILITY)
              ? decodeEventRoutinesFromHost
              : decodeEventRoutines,
            input,
          ),
      }),
      saveRoutine: scopedHandler(parseSaveEventRoutine, {
        local: (input) => runCauseEffect(events.saveRoutine(input)),
        remote: (input, serverId) => {
          if (remoteServers.supportsCapability(serverId, ROUTINE_RUN_PLACE_CAPABILITY))
            return remote(serverId, ROUTINE_RUN_PLACE_ROUTES.eventSave, decodeSavedEventRoutineFromHost, input);
          if (input.runIn === "thread") throw new Error(sourceText("error.team.agentSettingsUnsupported"));
          return remote(
            serverId,
            recovery(serverId) ? ROUTINE_RECOVERY_ROUTES.saveRoutine : EVENTS_ROUTES.saveRoutine,
            decodeSaveEventRoutineResult,
            input,
          );
        },
      }),
      deleteRoutine: scopedHandler(parseEventRoutineRef, {
        local: (input) => runCauseEffect(events.deleteRoutine(input)),
        remote: (input, serverId) => remote(serverId, EVENTS_ROUTES.deleteRoutine, acceptEmpty, input),
      }),
      testRoutine: scopedHandler(parseEventRoutineRef, {
        local: (input) => runCauseEffect(events.testRoutine(input)),
        remote: (input, serverId) => remote(serverId, EVENTS_ROUTES.testRoutine, acceptEmpty, input),
      }),
      rotateSecret: scopedHandler(parseEventRoutineRef, {
        local: (input) => runCauseEffect(events.rotateSecret(input)),
        remote: (input, serverId) => remote(serverId, EVENTS_ROUTES.rotateSecret, decodeWebhookSecret, input),
      }),
      sendTestEvent: scopedHandler(parseEventRoutineRef, {
        local: (input) => runCauseEffect(events.sendTestEvent(input)),
        remote: (input, serverId) => {
          if (!remoteServers.supportsCapability(serverId, WEBHOOK_TESTS_CAPABILITY))
            throw new Error(sourceText("error.backend.eventsUnavailable"));
          return remote(serverId, WEBHOOK_TESTS_ROUTES.send, decodeWebhookTestResult, input);
        },
      }),
      listActivity: scopedHandler(parseListEventActivity, {
        local: (input) => runCauseEffect(events.listActivity(input)),
        remote: (input, serverId) => remote(serverId, EVENTS_ROUTES.listActivity, decodeEventActivity, input),
      }),
      listRoutineRuns: scopedHandler(parseListEventRoutineRuns, {
        local: (input) => runCauseEffect(events.listRoutineRuns(input)),
        remote: (input, serverId) => {
          if (!recovery(serverId)) throw new Error(sourceText("error.backend.eventsUnavailable"));
          return remote(serverId, ROUTINE_RECOVERY_ROUTES.listRuns, decodeEventRoutineRuns, input);
        },
      }),
    },
  };
}
