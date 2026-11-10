import type { ConversationMessage } from "@tommy/contracts/ipc";
import type { MessageDeleteAccess } from "../message-deletion";
import { MessageDeleteRefused } from "../message-deletion";
import { type DatabaseCore, deleteReceiptsOf, deleteThreadAttachments } from "./database-core";
import {
  databaseRow,
  databaseRows,
  decodeConversationMessageJson,
  optionalStringColumn,
  requiredNumberColumn,
  requiredStringColumn,
} from "./database-rows";
import {
  deletedThreadMessageIds,
  isDeletedThreadMessage,
  recordDeletedThreadHistory,
  recordDeletedThreadMessage,
  threadMessageIds,
  withoutDeletedConversationMessages,
} from "./deleted-thread-messages";
import { readOrderInputs, refreshChangedOrder } from "./thread-message-order";

export interface ConversationMessageDeletion {
  deleted: boolean;
  revision: number;
  removedMessageIds: string[];
}

export interface DeleteConversationMessage {
  agentId: string;
  threadId: string;
  messageId: string;
  requestId: string;
  access: MessageDeleteAccess;
}

export interface DeleteThreadHistory {
  agentId: string;
  threadId: string;
  requestId: string;
}

export interface ConversationHistoryDeletion {
  revision: number;
  messageIds: string[];
  externalSessionIds: string[];
}

/** Owns person-requested durable removals. The caller owns mailbox cleanup and session teardown. */
export class ConversationDeletion {
  readonly #core: DatabaseCore;

  constructor(core: DatabaseCore) {
    this.#core = core;
  }

  deleteMessage(input: DeleteConversationMessage): ConversationMessageDeletion {
    return this.#core.dispatch(
      `conversation:message-delete:${input.threadId}:${input.messageId}:${input.requestId}`,
      [
        {
          aggregateType: "thread",
          aggregateId: input.threadId,
          eventType: "conversation.message-deleted",
          payload: { removedMessageIds: [input.messageId] },
        },
      ],
      (db, sequences) => {
        const owner = databaseRow(
          db.prepare("SELECT agent_id, active_turn_id FROM projection_threads WHERE thread_id = ?").get(input.threadId),
        );
        if (!owner || requiredStringColumn(owner, "agent_id") !== input.agentId)
          throw new MessageDeleteRefused({ reason: "not-found" });
        const row = databaseRow(
          db
            .prepare("SELECT message_json FROM projection_thread_messages WHERE thread_id = ? AND message_id = ?")
            .get(input.threadId, input.messageId),
        );
        const revision = sequences[0] ?? 0;
        if (!row) {
          if (isDeletedThreadMessage(db, input.threadId, input.messageId))
            return { deleted: false, revision, removedMessageIds: [] };
          throw new MessageDeleteRefused({ reason: "not-found" });
        }
        const message = decodeConversationMessageJson(requiredStringColumn(row, "message_json"));
        if (message.author === "system") throw new MessageDeleteRefused({ reason: "not-found" });
        if (!canDeleteMessage(message, input.access)) throw new MessageDeleteRefused({ reason: "forbidden" });
        const activeTurnId = optionalStringColumn(owner, "active_turn_id");
        if (
          message.status === "streaming" ||
          (message.turnId && activeTurnId === message.turnId) ||
          message.delivery?.status === "starting" ||
          message.delivery?.status === "running"
        )
          throw new MessageDeleteRefused({ reason: "busy" });
        const deletedAt = new Date().toISOString();
        recordDeletedThreadMessage(db, input.threadId, input.messageId, deletedAt);
        const candidates = databaseRows(
          db
            .prepare(`
          SELECT message_json FROM projection_thread_messages WHERE thread_id = ?
          AND (message_id = ? OR turn_id = ?)
        `)
            .all(input.threadId, input.messageId, message.turnId ?? null),
        ).map((value) => decodeConversationMessageJson(requiredStringColumn(value, "message_json")));
        const kept = new Set(
          withoutDeletedConversationMessages(db, input.threadId, candidates).map((value) => value.id),
        );
        const removedMessageIds = candidates.filter((value) => !kept.has(value.id)).map((value) => value.id);
        const tombstone = db.prepare(
          "INSERT OR IGNORE INTO projection_deleted_thread_messages(thread_id, message_id, deleted_at) VALUES (?, ?, ?)",
        );
        for (const id of removedMessageIds) tombstone.run(input.threadId, id, deletedAt);
        const before = readOrderInputs(db, input.threadId, removedMessageIds);
        const remove = db.prepare("DELETE FROM projection_thread_messages WHERE thread_id = ? AND message_id = ?");
        const attachments = db.prepare(
          "DELETE FROM projection_attachments WHERE owner_kind = 'thread-message' AND owner_id = ?",
        );
        for (const id of removedMessageIds) {
          if (id !== input.messageId) recordDeletedThreadMessage(db, input.threadId, id, deletedAt);
          attachments.run(`${input.threadId}:${id}`);
          remove.run(input.threadId, id);
        }
        refreshChangedOrder(db, input.threadId, before, removedMessageIds);
        db.prepare("UPDATE orchestration_events SET payload_json = ? WHERE sequence = ?").run(
          JSON.stringify({ removedMessageIds }),
          revision,
        );
        db.prepare("UPDATE projection_threads SET updated_at = ?, last_event_sequence = ? WHERE thread_id = ?").run(
          deletedAt,
          revision,
          input.threadId,
        );
        return { deleted: true, revision, removedMessageIds };
      },
    );
  }

  deleteHistory(input: DeleteThreadHistory): ConversationHistoryDeletion {
    return this.#core.dispatch(
      `conversation:history-delete:${input.threadId}:${input.requestId}`,
      [
        {
          aggregateType: "thread",
          aggregateId: input.threadId,
          eventType: "conversation.history-deleted",
          payload: { changedMessages: [], removedMessageIds: [], activeTurnId: null },
        },
      ],
      (db, sequences) => {
        const owner = databaseRow(
          db.prepare("SELECT agent_id, active_turn_id FROM projection_threads WHERE thread_id = ?").get(input.threadId),
        );
        if (!owner || requiredStringColumn(owner, "agent_id") !== input.agentId)
          throw new MessageDeleteRefused({ reason: "not-found" });
        if (
          optionalStringColumn(owner, "active_turn_id") ||
          db
            .prepare("SELECT 1 FROM projection_turns WHERE thread_id = ? AND status = 'running' LIMIT 1")
            .get(input.threadId)
        )
          throw new MessageDeleteRefused({ reason: "busy" });
        const revision = sequences[0] ?? 0;
        const deletedAt = new Date().toISOString();
        recordDeletedThreadHistory(db, input.threadId, deletedAt);
        const messageIds = [...deletedThreadMessageIds(db, input.threadId)];
        deleteThreadAttachments(db, input.threadId);
        db.prepare("DELETE FROM projection_thread_messages WHERE thread_id = ?").run(input.threadId);
        db.prepare("DELETE FROM projection_thread_summaries WHERE thread_id = ?").run(input.threadId);
        const summaries =
          "FROM orchestration_events WHERE aggregate_type = 'thread' AND aggregate_id = ? AND event_type = 'thread.summary-created'";
        const commands = databaseRows(db.prepare(`SELECT DISTINCT command_id ${summaries}`).all(input.threadId)).map(
          (row) => requiredStringColumn(row, "command_id"),
        );
        db.prepare(
          `DELETE FROM projection_thread_activities WHERE thread_id = ? AND last_event_sequence IN (SELECT sequence ${summaries})`,
        ).run(input.threadId, input.threadId);
        db.prepare(`DELETE ${summaries}`).run(input.threadId);
        deleteReceiptsOf(db, commands);
        // The reset is in the event too, so a projection rebuild cannot mark an old session active.
        const sessions = databaseRows(
          db
            .prepare("SELECT id, external_session_id, state FROM projection_provider_sessions WHERE thread_id = ?")
            .all(input.threadId),
        );
        const sessionIds = sessions
          .filter((row) => requiredStringColumn(row, "state") === "active")
          .map((row) => requiredStringColumn(row, "id"));
        const externalSessionIds = sessions.map((row) => requiredStringColumn(row, "external_session_id"));
        db.prepare(
          "UPDATE projection_provider_sessions SET state = 'inactive', resume_cursor = NULL, updated_at = ?, last_event_sequence = ? WHERE thread_id = ?",
        ).run(deletedAt, revision, input.threadId);
        db.prepare("UPDATE orchestration_events SET payload_json = ? WHERE sequence = ?").run(
          JSON.stringify({
            changedMessages: [],
            removedMessageIds: [],
            activeTurnId: null,
            deactivatedSessionIds: sessionIds,
          }),
          revision,
        );
        db.prepare(
          "UPDATE projection_threads SET active_turn_id = NULL, updated_at = ?, last_event_sequence = ? WHERE thread_id = ?",
        ).run(deletedAt, revision, input.threadId);
        return { revision, messageIds, externalSessionIds };
      },
    );
  }

  historyReceipt(threadId: string, requestId: string): ConversationHistoryDeletion | null {
    const raw = this.#core.commandResult(`conversation:history-delete:${threadId}:${requestId}`);
    if (raw === undefined) return null;
    const receipt = databaseRow(raw);
    if (
      !receipt ||
      !Array.isArray(receipt.messageIds) ||
      !receipt.messageIds.every((id): id is string => typeof id === "string")
    )
      throw new Error("Invalid history deletion receipt.");
    const externalSessionIds = receipt.externalSessionIds ?? [];
    if (!Array.isArray(externalSessionIds) || !externalSessionIds.every((id): id is string => typeof id === "string"))
      throw new Error("Invalid history deletion sessions.");
    return {
      revision: requiredNumberColumn(receipt, "revision"),
      messageIds: [...receipt.messageIds],
      externalSessionIds: [...externalSessionIds],
    };
  }

  messageIds(threadId: string): string[] {
    return threadMessageIds(this.#core.connection, threadId);
  }
}

function canDeleteMessage(message: ConversationMessage, access: MessageDeleteAccess): boolean {
  return (
    access.deleteAny ||
    (access.memberId !== null && message.author === "user" && message.senderMember?.id === access.memberId)
  );
}
