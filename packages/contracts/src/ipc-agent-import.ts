/**
 * Agent import: agents exported from another app as one `.zip`, read by the local host.
 *
 * The main process reads and checks the archive, keeps it under a token, and answers a preview.
 * The renderer never receives a path or the archive bytes: it names the token and the agents and
 * channels to import. A remote host is reached with `agent-import-v1`: its preview has no avatars
 * and its result names the new agents only, so the client reads them with the agent list.
 */

import { INPUT_LIMITS } from "./input-limits";
import { isBoundedString } from "./ipc-bounded-values";
import { isBoolean, isDynamicRecord, isNumber, isString } from "./runtime-values";

/** The Grok Bot page of the ready export agent. */
export const GROK_BOT_EXPORT_URL = "https://x.ai/bot/gI0XdhhDYPJeyQaqQBC0O";

export const AGENT_IMPORT_LIMITS = {
  archiveBytes: 500 * 1024 * 1024,
  files: 5_000,
  /** One key names one agent in the archive: lowercase letters, digits and hyphens. */
  key: 64,
  sourceApp: 64,
  /** Group chats in one export. Each becomes a channel. */
  channels: 100,
  message: 500,
  warnings: 200,
} as const;

export interface AgentImportPreviewAgent {
  key: string;
  name: string;
  title: string;
  description: string;
  /** A `data:` URL of the checked avatar, or null when the archive has none. */
  avatarUrl: string | null;
  skillCount: number;
  routineCount: number;
  memoryCount: number;
  fileCount: number;
  fileBytes: number;
  /** An agent on this server already has this name. The import adds another one beside it. */
  nameExists: boolean;
}

export interface AgentImportSkipped {
  key: string;
  name: string;
  reason: string;
}

function invalid(label: string): never {
  throw new Error(`Invalid ${label}.`);
}

function record(value: unknown, label: string) {
  if (!isDynamicRecord(value)) invalid(label);
  return value;
}

export function isAgentImportKey(value: unknown): value is string {
  return isBoundedString(value, AGENT_IMPORT_LIMITS.key) && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value);
}

function count(value: unknown, label: string): number {
  if (!isNumber(value) || !Number.isSafeInteger(value) || value < 0) invalid(label);
  return value;
}

export function decodeAgentImportSkipped(value: unknown, label: string): AgentImportSkipped[] {
  if (!Array.isArray(value)) invalid("import result");
  return value.map((item): AgentImportSkipped => {
    const entry = record(item, label);
    if (
      !isAgentImportKey(entry.key) ||
      !isBoundedString(entry.name, INPUT_LIMITS.agentName) ||
      !isBoundedString(entry.reason, AGENT_IMPORT_LIMITS.message)
    )
      invalid(label);
    return { key: entry.key, name: entry.name, reason: entry.reason };
  });
}

export function decodeAgentImportPreviewAgent(value: unknown): AgentImportPreviewAgent {
  const agent = record(value, "imported agent");
  if (
    !isAgentImportKey(agent.key) ||
    !isBoundedString(agent.name, INPUT_LIMITS.agentName) ||
    !isBoundedString(agent.title, INPUT_LIMITS.agentTitle) ||
    !isBoundedString(agent.description, INPUT_LIMITS.agentDescription) ||
    (agent.avatarUrl !== null && !(isString(agent.avatarUrl) && agent.avatarUrl.startsWith("data:image/"))) ||
    !isBoolean(agent.nameExists)
  )
    invalid("imported agent");
  return {
    key: agent.key,
    name: agent.name,
    title: agent.title,
    description: agent.description,
    avatarUrl: agent.avatarUrl,
    skillCount: count(agent.skillCount, "imported agent"),
    routineCount: count(agent.routineCount, "imported agent"),
    memoryCount: count(agent.memoryCount, "imported agent"),
    fileCount: count(agent.fileCount, "imported agent"),
    fileBytes: count(agent.fileBytes, "imported agent"),
    nameExists: agent.nameExists,
  };
}
