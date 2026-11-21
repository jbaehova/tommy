const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isUuidV4(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

/**
 * The directory name a pre-rename build gave this agent, or the id unchanged when no pre-rename build could
 * have minted it.
 *
 * The UUID suffix is what makes this reversible, and it is the whole safety argument. Only the app mints
 * `agent-<uuid>`, so only such an id is guaranteed to have been `bot-<uuid>` before migration v13. An id a
 * user or an imported `bots.json` chose is an ordinary word: `agent-research` translated to `bot-research`
 * names a directory that may well belong to a *different* agent, and callers here delete directories
 * recursively.
 */
export function legacyAgentId(agentId: string): string {
  if (!agentId.startsWith("agent-") || !isGeneratedAgentId(agentId)) return agentId;
  return `bot-${agentId.slice("agent-".length)}`;
}

/** Whether this id is one the app minted for itself, in either the pre- or post-rename spelling. */
export function isGeneratedAgentId(agentId: string): boolean {
  const prefix = agentId.startsWith("agent-") ? "agent-" : agentId.startsWith("bot-") ? "bot-" : null;
  return prefix !== null && isUuidV4(agentId.slice(prefix.length));
}
