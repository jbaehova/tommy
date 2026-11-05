// Agent conversations and member-to-member direct messages, as a host sends them.
// See `remote-host-decoding.ts` for why the `FromHost` suffix exists and must not be merged away.

import type {
  ConversationMessage,
  ConversationPage,
  ConversationReadState,
  ConversationSearchPage,
  ConversationWithReadState,
} from "@tommy/contracts/ipc";
import { isConversationMessage, isConversationReadState, isConversationWithReadState } from "@tommy/contracts/ipc";
import {
  decodeRecord,
  guardedListDecoder,
  nullableString,
  optionalHistoryExtent,
  requiredBoolean,
  requiredNumber,
  requiredString,
} from "@tommy/contracts/ipc-decoding";

export function decodeConversationReadState(value: unknown): ConversationReadState {
  if (!isConversationReadState(value)) throw new Error("Invalid conversation read state.");
  return {
    unreadCount: value.unreadCount,
    firstUnreadMessageId: value.firstUnreadMessageId,
    throughMessageId: value.throughMessageId,
  };
}

export function decodeConversationReadStates(value: unknown): Record<string, ConversationReadState> {
  const record = decodeRecord(value, "conversation read states");
  return Object.fromEntries(
    Object.entries(record).map(([agentId, state]) => [agentId, decodeConversationReadState(state)]),
  );
}

export function decodeConversationWithReadState(value: unknown): ConversationWithReadState {
  if (!isConversationWithReadState(value)) {
    throw new Error("Invalid agent conversation response.");
  }
  return { ...value, readState: decodeConversationReadState(value.readState) };
}

export function decodeConversationPageFromHost(value: unknown): ConversationPage {
  const record = decodeRecord(value, "agent conversation page");
  return {
    agentId: requiredString(record, "agentId"),
    threadId: nullableString(record, "threadId"),
    activeTurnId: nullableString(record, "activeTurnId"),
    revision: requiredNumber(record, "revision"),
    messages: decodeConversationMessages(record.messages),
    references: decodeConversationReferencesFromHost(record.references),
    pageInfo: decodePageInfo(record.pageInfo),
    ...(record.readState === undefined ? {} : { readState: decodeConversationReadState(record.readState) }),
  };
}

export function decodeConversationSearchPageFromHost(value: unknown): ConversationSearchPage {
  const record = decodeRecord(value, "conversation search page");
  if (!Array.isArray(record.results)) throw new Error("Invalid conversation search results.");
  return {
    results: record.results.map((value) => {
      const result = decodeRecord(value, "conversation search result");
      return {
        agentId: requiredString(result, "agentId"),
        message: decodeConversationMessage(result.message, "conversation search message"),
      };
    }),
    total: requiredNumber(record, "total"),
    nextCursor: nullableString(record, "nextCursor"),
  };
}

const decodeConversationMessages = guardedListDecoder(isConversationMessage, "conversation page messages");

function decodeConversationReferencesFromHost(value: unknown): Record<string, ConversationMessage> {
  const references = decodeRecord(value, "conversation references");
  const decoded: Record<string, ConversationMessage> = {};
  for (const [messageId, message] of Object.entries(references)) {
    decoded[messageId] = decodeConversationMessage(message, "conversation reference");
  }
  return decoded;
}

function decodeConversationMessage(value: unknown, label: string): ConversationMessage {
  if (!isConversationMessage(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function decodePageInfo(value: unknown): ConversationPage["pageInfo"] {
  const record = decodeRecord(value, "conversation page info");
  return {
    hasOlder: requiredBoolean(record, "hasOlder"),
    olderCursor: nullableString(record, "olderCursor"),
    // history-extent-v1: the host sends the unloaded length only when it was negotiated.
    ...optionalHistoryExtent(record),
  };
}
