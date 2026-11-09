import { isDynamicRecord, isString } from "@tommy/contracts/runtime-values";
import { remoteHostFingerprint } from "@tommy/team-client";
import * as SecureStore from "expo-secure-store";

/** The agent that the phone's assistant action opens. Each account on this phone has its own. */
export interface AssistantTarget {
  serverId: string;
  agentId: string;
}

function assistantTargetKey(apiUrl: string, userId: string): string {
  return `tommy.assistant-target.v1.${remoteHostFingerprint(JSON.stringify([new URL(apiUrl).origin, userId]))}`;
}

/** Null when nothing is saved, or the value cannot be read. */
export async function loadAssistantTarget(apiUrl: string, userId: string): Promise<AssistantTarget | null> {
  try {
    const value = JSON.parse((await SecureStore.getItemAsync(assistantTargetKey(apiUrl, userId))) ?? "null");
    if (!isDynamicRecord(value)) return null;
    const { serverId, agentId } = value;
    return isString(serverId) && isString(agentId) ? { serverId, agentId } : null;
  } catch {
    return null;
  }
}

/** Rejects when the choice cannot be saved, so the screen can keep showing the saved one. */
export async function saveAssistantTarget(apiUrl: string, userId: string, target: AssistantTarget): Promise<void> {
  await SecureStore.setItemAsync(assistantTargetKey(apiUrl, userId), JSON.stringify(target));
}
