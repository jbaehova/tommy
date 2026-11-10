import { isIdentifier } from "./ipc-bounded-values";
import { isBoolean, isDynamicRecord } from "./runtime-values";

/** Requests name a host-owned message. Access is computed by the host, never supplied by a client. */
export interface MessageDeleteInput {
  agentId: string;
  messageId: string;
  requestId: string;
}

export interface TaskMessageDeleteInput extends MessageDeleteInput {
  taskId: string;
}

export interface ChannelMessageDeleteInput {
  channelId: string;
  messageId: string;
  requestId: string;
}

/** A retry must keep requestId, so it cannot delete messages received after the first success. */
export interface HistoryDeleteInput {
  agentId: string;
  requestId: string;
}

export interface ChannelHistoryDeleteInput {
  channelId: string;
  requestId: string;
}

export interface MessageDeleteResult {
  deleted: boolean;
}

export interface HistoryDeleteResult {
  deleted: boolean;
}

export const MESSAGE_DELETION_EVENT_MAX_IDS = 500;

/** Optional V9 events contain only removed IDs, so delayed retries preserve later messages. */
export type MessageDeletionEvent =
  | { type: "conversation-messages-deleted"; agentId: string; threadId: string; messageIds: string[] }
  | { type: "channel-messages-deleted"; channelId: string; messageIds: string[] };

export function isMessageDeletionEvent(value: unknown): value is MessageDeletionEvent {
  if (
    !isDynamicRecord(value) ||
    !Array.isArray(value.messageIds) ||
    value.messageIds.length === 0 ||
    value.messageIds.length > MESSAGE_DELETION_EVENT_MAX_IDS ||
    !value.messageIds.every(isIdentifier)
  )
    return false;
  if (value.type === "conversation-messages-deleted")
    return isIdentifier(value.agentId) && isIdentifier(value.threadId);
  return value.type === "channel-messages-deleted" && isIdentifier(value.channelId);
}

/** Preserve the independent preload boundary while returning only event fields. */
export function decodeMessageDeletionEvent(value: unknown): MessageDeletionEvent {
  if (!isMessageDeletionEvent(value)) throw new Error("Invalid message deletion event.");
  return value.type === "conversation-messages-deleted"
    ? { type: value.type, agentId: value.agentId, threadId: value.threadId, messageIds: [...value.messageIds] }
    : { type: value.type, channelId: value.channelId, messageIds: [...value.messageIds] };
}

export function parseMessageDeleteInput(value: unknown): MessageDeleteInput {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.agentId) ||
    !isIdentifier(value.messageId) ||
    !isIdentifier(value.requestId)
  )
    throw new Error("Invalid message delete request.");
  return { agentId: value.agentId, messageId: value.messageId, requestId: value.requestId };
}

export function parseTaskMessageDeleteInput(value: unknown): TaskMessageDeleteInput {
  const message = parseMessageDeleteInput(value);
  if (!isDynamicRecord(value) || !isIdentifier(value.taskId)) throw new Error("Invalid task message delete request.");
  return { ...message, taskId: value.taskId };
}

export function parseChannelMessageDeleteInput(value: unknown): ChannelMessageDeleteInput {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.channelId) ||
    !isIdentifier(value.messageId) ||
    !isIdentifier(value.requestId)
  )
    throw new Error("Invalid channel message delete request.");
  return { channelId: value.channelId, messageId: value.messageId, requestId: value.requestId };
}

export function parseHistoryDeleteInput(value: unknown): HistoryDeleteInput {
  if (!isDynamicRecord(value) || !isIdentifier(value.agentId) || !isIdentifier(value.requestId))
    throw new Error("Invalid history delete request.");
  return { agentId: value.agentId, requestId: value.requestId };
}

export function parseChannelHistoryDeleteInput(value: unknown): ChannelHistoryDeleteInput {
  if (!isDynamicRecord(value) || !isIdentifier(value.channelId) || !isIdentifier(value.requestId))
    throw new Error("Invalid channel history delete request.");
  return { channelId: value.channelId, requestId: value.requestId };
}

export function decodeMessageDeleteResult(value: unknown): MessageDeleteResult {
  if (!isDynamicRecord(value) || !isBoolean(value.deleted)) throw new Error("Invalid message delete result.");
  return { deleted: value.deleted };
}

export function decodeHistoryDeleteResult(value: unknown): HistoryDeleteResult {
  if (!isDynamicRecord(value) || !isBoolean(value.deleted)) throw new Error("Invalid history delete result.");
  return { deleted: value.deleted };
}
