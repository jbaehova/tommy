import { INPUT_LIMITS } from "@tommy/contracts/input-limits";
import { decodeRecord, requiredString } from "@tommy/contracts/ipc-decoding";
import type {
  HistoryDeleteResult,
  MessageDeleteResult,
  MessageDeletionEvent,
} from "@tommy/contracts/ipc-message-deletion";
import { isDynamicRecord, isString } from "@tommy/contracts/runtime-values";

export function decodeMessageDeleteResultFromMain(value: unknown): MessageDeleteResult {
  if (!isDynamicRecord(value) || typeof value.deleted !== "boolean")
    throw new Error("Invalid message delete result from main.");
  return { deleted: value.deleted };
}

export function decodeHistoryDeleteResultFromMain(value: unknown): HistoryDeleteResult {
  if (!isDynamicRecord(value) || typeof value.deleted !== "boolean")
    throw new Error("Invalid history delete result from main.");
  return { deleted: value.deleted };
}

export function decodeMessageDeletionEventFromMain(value: unknown): MessageDeletionEvent {
  const event = decodeRecord(value, "message deletion event from main");
  if (!Array.isArray(event.messageIds) || event.messageIds.length === 0 || event.messageIds.length > 500)
    throw new Error("Invalid message deletion event from main.");
  const messageIds = event.messageIds.map((id) => {
    if (!isString(id) || !id || id.length > INPUT_LIMITS.identifier)
      throw new Error("Invalid deleted message id from main.");
    return id;
  });
  if (event.type === "conversation-messages-deleted") {
    const agentId = requiredString(event, "agentId");
    const threadId = requiredString(event, "threadId");
    if (!agentId || agentId.length > INPUT_LIMITS.identifier || !threadId || threadId.length > INPUT_LIMITS.identifier)
      throw new Error("Invalid deleted conversation from main.");
    return { type: event.type, agentId, threadId, messageIds };
  }
  if (event.type === "channel-messages-deleted") {
    const channelId = requiredString(event, "channelId");
    if (!channelId || channelId.length > INPUT_LIMITS.identifier) throw new Error("Invalid deleted channel from main.");
    return { type: event.type, channelId, messageIds };
  }
  throw new Error("Invalid message deletion event from main.");
}
