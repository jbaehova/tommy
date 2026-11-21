import { type DynamicRecord, isDynamicRecord, isString } from "@tommy/contracts/runtime-values";
import { EXTERNAL_EVENT_START } from "../webhook-trigger";
import type { WorkflowGitHubFile, WorkflowGitHubFiles } from "./workflow-github-api";

/** The data of the Discord mention in a run payload, or null when a Discord mention did not start the run. */
function discordEventData(payload: string | null): DynamicRecord | null {
  if (!payload?.startsWith(EXTERNAL_EVENT_START)) return null;
  const [, , json] = payload.split("\n");
  let event: unknown;
  try {
    event = JSON.parse(json ?? "");
  } catch {
    return null;
  }
  return isDynamicRecord(event) && event.type === "discord.mention" && isDynamicRecord(event.data) ? event.data : null;
}

function isFile(value: unknown): value is WorkflowGitHubFile {
  return (
    isDynamicRecord(value) &&
    isString(value.name) &&
    value.name.length > 0 &&
    isString(value.contentType) &&
    typeof value.size === "number" &&
    isString(value.url)
  );
}

/**
 * The files of the mention that started a run, and the folder that a GitHub output copies them to. Null
 * when the run has none: a payload of an older version keeps no files.
 */
export function discordTriggerFiles(payload: string | null): WorkflowGitHubFiles | null {
  const data = discordEventData(payload);
  if (!data || !isString(data.messageId) || !/^\d{1,32}$/u.test(data.messageId)) return null;
  const files = Array.isArray(data.attachments) ? data.attachments.filter(isFile) : [];
  if (files.length === 0) return null;
  return {
    folder: `discord/${data.messageId}`,
    files: files.map(({ name, contentType, size, url }) => ({ name, contentType, size, url })),
  };
}
