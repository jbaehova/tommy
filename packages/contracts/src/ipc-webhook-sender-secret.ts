import { isIdentifier } from "./ipc-bounded-values";
import { type EventRoutineRef, isEventRoutineOwner } from "./ipc-events";
import { isWorkflowTriggerInput, type WorkflowTriggerInput } from "./ipc-workflows";
import { isDynamicRecord } from "./runtime-values";

export interface SetRoutineSenderSecretInput extends EventRoutineRef {
  secret: string;
}
export interface SetWorkflowSenderSecretInput extends WorkflowTriggerInput {
  secret: string;
}

function secret(value: unknown): string {
  if (typeof value !== "string" || value.length < 22 || value.length > 1_024)
    throw new Error("Invalid webhook sender secret.");
  return value;
}

export function parseSetRoutineSenderSecret(value: unknown): SetRoutineSenderSecretInput {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.id) ||
    !isEventRoutineOwner(value.owner) ||
    !isIdentifier(value.owner.id)
  )
    throw new Error("Invalid webhook routine.");
  return { id: value.id, owner: { kind: value.owner.kind, id: value.owner.id }, secret: secret(value.secret) };
}

export function parseSetWorkflowSenderSecret(value: unknown): SetWorkflowSenderSecretInput {
  if (!isWorkflowTriggerInput(value) || !isDynamicRecord(value)) throw new Error("Invalid workflow webhook.");
  return { workflowId: value.workflowId, nodeId: value.nodeId, secret: secret(value.secret) };
}
