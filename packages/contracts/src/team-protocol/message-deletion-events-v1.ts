// Additive events for message-delete-v1 and chat-history-v1. Each event names only committed
// tombstone ids, in chunks of at most 500. It never means clear all cached content: a late event or
// a retried history receipt must not remove messages received after the original commit.
import { isDynamicRecord, isString } from "../runtime-values";

export type MessageDeletionWireEvent =
  | { type: "conversation-messages-deleted"; agentId: string; threadId: string; messageIds: string[] }
  | { type: "channel-messages-deleted"; channelId: string; messageIds: string[] };

function identifier(value: unknown): string {
  if (!isString(value) || value.length === 0 || value.length > 128)
    throw new Error("Invalid deleted message identifier.");
  return value;
}
function messageIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500)
    throw new Error("Invalid deleted message list.");
  return value.map(identifier);
}
/** Unknown events return null. A malformed known event fails the transport closed. */
export function messageDeletionEvent(value: unknown): MessageDeletionWireEvent | null {
  if (!isDynamicRecord(value)) return null;
  if (value.type === "conversation-messages-deleted")
    return {
      type: value.type,
      agentId: identifier(value.agentId),
      threadId: identifier(value.threadId),
      messageIds: messageIds(value.messageIds),
    };
  if (value.type === "channel-messages-deleted")
    return {
      type: value.type,
      channelId: identifier(value.channelId),
      messageIds: messageIds(value.messageIds),
    };
  return null;
}
