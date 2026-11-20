import type { MemoryEntry } from "./ipc-agent-memories";

export const AGENT_MEMORY_CONTEXT_BUDGET_BYTES = 8192;
/**
 * The owner of the shared memories: the facts that every agent of this server has. They are rows of
 * the agent memory table with this owner in place of an agent id, so they need no table of their
 * own. An agent id starts with `agent-` (or the older `bot-`), so no agent has this id.
 */
export const SHARED_MEMORY_OWNER_ID = "tommy-shared-memory";
/** The essential shared memories go into the prompt of every agent, so their budget is smaller. */
export const SHARED_MEMORY_CONTEXT_BUDGET_BYTES = 4096;
/** `scope` is set only on a shared memory. */
export type ContextMemory = Pick<MemoryEntry, "id" | "text" | "origin"> & { scope?: "shared" | undefined };

/** The essential-memory budget of an agent, or of the shared memories. */
export function essentialMemoryBudgetBytes(
  ownerId: string,
): typeof SHARED_MEMORY_CONTEXT_BUDGET_BYTES | typeof AGENT_MEMORY_CONTEXT_BUDGET_BYTES {
  return ownerId === SHARED_MEMORY_OWNER_ID ? SHARED_MEMORY_CONTEXT_BUDGET_BYTES : AGENT_MEMORY_CONTEXT_BUDGET_BYTES;
}

/** One format for migration selection, mutation budgets, and provider instructions. */
export function serializeEssentialMemories(memories: readonly ContextMemory[]): string {
  const entries = memories.map(({ id, text, origin, scope }) => ({ id, text, origin, ...(scope ? { scope } : {}) }));
  return `<agent_memories count="${entries.length}">\n${JSON.stringify(entries)}\n</agent_memories>`;
}

export function essentialMemoryBytes(memories: readonly ContextMemory[]): number {
  return new TextEncoder().encode(serializeEssentialMemories(memories)).byteLength;
}
