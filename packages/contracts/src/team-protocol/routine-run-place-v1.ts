// Optional routine-run-place-v1. A routine can keep its work in an independent side thread.
// Released routine routes stay unchanged. New routes preserve limit and missed policies and add
// runIn (absent means chat). Event routines require owner/admin; ordinary agent routes require
// view to list and manage to change. The task relation and completion event go only to this peer.
import type { AgentTurnCompletedEvent } from "../ipc-agent-events";
import { isAgentEvent } from "../ipc-agent-events";
import { isDynamicRecord, isString } from "../runtime-values";
import {
  adminRoute,
  boolean,
  fields,
  identifier,
  list,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";
import { routineOwner, routineSchedule, routineTrigger, routineTriggerInput } from "./events-v1";
import { decodeTeamProtocolV2Json } from "./v2";

export const ROUTINE_RUN_PLACE_CAPABILITY = "routine-run-place-v1";
export const ROUTINE_RUN_PLACE_ROUTES = {
  list: "/v1/routines/run-place/list",
  create: "/v1/routines/run-place/create",
  update: "/v1/routines/run-place/update",
  eventList: "/v1/routines/run-place/events/list",
  eventSave: "/v1/routines/run-place/events/save",
} as const;
const timestamp = string(160);
const policies = {
  limitPolicy: oneOf("wait", "skip"),
  missedPolicy: oneOf("skip", "run-once"),
  runIn: oneOf("chat", "thread"),
};
const settings = { name: string(256), instruction: string(100_000), active: boolean, timezone: string(128) };
const trigger = fields({
  id: identifier,
  routineId: identifier,
  schedule: routineSchedule,
  nextRunAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const routine = fields(
  { id: identifier, agentId: identifier, ...settings, trigger, createdAt: timestamp, updatedAt: timestamp },
  policies,
);
const eventRoutine = fields(
  {
    id: identifier,
    owner: routineOwner,
    ...settings,
    trigger: routineTrigger,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  policies,
);
export const ROUTINE_RUN_PLACE_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [ROUTINE_RUN_PLACE_ROUTES.list, adminRoute(fields({ agentId: identifier }), list(routine, 10_000))],
  [
    ROUTINE_RUN_PLACE_ROUTES.create,
    adminRoute(fields({ agentId: identifier, ...settings, schedule: routineSchedule }, policies), routine),
  ],
  [
    ROUTINE_RUN_PLACE_ROUTES.update,
    adminRoute(
      fields({ agentId: identifier, routineId: identifier }, { ...settings, schedule: routineSchedule, ...policies }),
      routine,
    ),
  ],
  [ROUTINE_RUN_PLACE_ROUTES.eventList, adminRoute(fields({ owner: routineOwner }), list(eventRoutine, 10_000))],
  [
    ROUTINE_RUN_PLACE_ROUTES.eventSave,
    adminRoute(
      fields({ owner: routineOwner, ...settings, trigger: routineTriggerInput }, { id: identifier, ...policies }),
      fields({ routine: eventRoutine, secret: nullable(string(1_024)) }),
    ),
  ],
]);

export interface RoutineThreadTurnEvent {
  type: "routine-thread-turn-completed";
  taskId: string;
  turn: AgentTurnCompletedEvent;
}
const turn = fields(
  { type: oneOf("turn-completed"), agentId: identifier, threadId: identifier, turnId: identifier, status: string(64) },
  { origin: oneOf("user", "routine", "agent", "unknown"), quiet: oneOfTrue, continues: oneOfTrue },
);
function oneOfTrue(value: unknown): true {
  if (value !== true) throw new Error("Invalid routine turn flag.");
  return true;
}
export function routineThreadTurnEvent(value: unknown): RoutineThreadTurnEvent | null {
  if (!isDynamicRecord(value) || value.type !== "routine-thread-turn-completed") return null;
  const decoded = {
    type: "routine-thread-turn-completed" as const,
    taskId: identifier(value.taskId),
    turn: turn(value.turn),
  };
  if (typeof decoded.taskId !== "string" || !isAgentEvent(decoded) || decoded.type !== "routine-thread-turn-completed")
    throw new Error("Invalid routine thread completion.");
  return decoded;
}

const MAX_DEPTH = 12;
function taskReferences(value: unknown, found: Map<string, string | null>, depth: number): void {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) taskReferences(item, found, depth + 1);
    return;
  }
  if (!isDynamicRecord(value)) return;
  if (
    isString(value.id) &&
    isString(value.agentId) &&
    isString(value.threadId) &&
    (value.routineId === null ||
      (isString(value.routineId) && value.routineId.length > 0 && value.routineId.length <= 128))
  )
    found.set(value.id, value.routineId);
  for (const child of Object.values(value)) taskReferences(child, found, depth + 1);
}
function copyReferences(value: unknown, found: ReadonlyMap<string, string | null>, depth: number): void {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) copyReferences(item, found, depth + 1);
    return;
  }
  if (!isDynamicRecord(value)) return;
  if (isString(value.id) && isString(value.agentId) && isString(value.threadId) && found.has(value.id))
    Object.assign(value, { routineId: found.get(value.id) });
  for (const child of Object.values(value)) copyReferences(child, found, depth + 1);
}
/** Copy only the relation of a task that survived the frozen projection. */
export function addRoutineTaskReferences(target: unknown, source: unknown): void {
  const found = new Map<string, string | null>();
  taskReferences(source, found, 0);
  if (found.size) copyReferences(target, found, 0);
}
export function withRoutineTaskReferences(encoded: string, source: unknown): string {
  const found = new Map<string, string | null>();
  taskReferences(source, found, 0);
  if (!found.size) return encoded;
  const decoded = decodeTeamProtocolV2Json(JSON.parse(encoded));
  copyReferences(decoded, found, 0);
  return JSON.stringify(decoded);
}
