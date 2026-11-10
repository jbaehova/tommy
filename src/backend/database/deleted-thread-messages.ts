import type { DatabaseSync } from "node:sqlite";
import { type ConversationMessage, ROUTINE_QUIET_ANSWER_ITEM_TYPE } from "@tommy/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isString } from "@tommy/contracts/runtime-values";
import type { ThreadItem } from "../protocol";
import { ORDER_KEY_COLUMNS, ORDER_KEY_DESC, ORDERED_THREAD_MESSAGES } from "./conversation-queries";
import { databaseRow, databaseRows, requiredNumberColumn, requiredStringColumn } from "./database-rows";

/**
 * The messages that a person deleted from a thread (`projection_deleted_thread_messages`).
 *
 * Pure functions over a connection that the caller holds. They open no transaction: the conversation
 * writer calls them inside its dispatch, so the delete, its event and its record commit together.
 */

/** The ids that a person deleted from one thread. */
export function deletedThreadMessageIds(db: DatabaseSync, threadId: string): Set<string> {
  const rows = databaseRows(
    db.prepare("SELECT message_id FROM projection_deleted_thread_messages WHERE thread_id = ?").all(threadId),
  );
  return new Set(rows.map((row) => requiredStringColumn(row, "message_id")));
}

/** A regular write needs only the incoming IDs, even after a very large history deletion. */
function matchingDeletedMessageIds(db: DatabaseSync, threadId: string, messageIds: readonly string[]): Set<string> {
  const ids = [...new Set(messageIds)];
  const deleted = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 400) {
    const page = ids.slice(offset, offset + 400);
    const rows = databaseRows(
      db
        .prepare(`
      SELECT message_id FROM projection_deleted_thread_messages
      WHERE thread_id = ? AND message_id IN (${page.map(() => "?").join(",")})
    `)
        .all(threadId, ...page),
    );
    for (const row of rows) deleted.add(requiredStringColumn(row, "message_id"));
  }
  return deleted;
}

/** The ids of the shown messages of a thread, in no order. */
export function threadMessageIds(db: DatabaseSync, threadId: string): string[] {
  return databaseRows(
    db.prepare("SELECT message_id FROM projection_thread_messages WHERE thread_id = ?").all(threadId),
  ).map((row) => requiredStringColumn(row, "message_id"));
}

/** Whether a person deleted this message from the thread. */
export function isDeletedThreadMessage(db: DatabaseSync, threadId: string, messageId: string): boolean {
  return (
    databaseRow(
      db
        .prepare("SELECT 1 AS deleted FROM projection_deleted_thread_messages WHERE thread_id = ? AND message_id = ?")
        .get(threadId, messageId),
    ) !== null
  );
}

/** The messages without the ones that a person deleted from the thread. */
export function withoutDeletedMessages<T extends Pick<ConversationMessage, "id">>(
  db: DatabaseSync,
  threadId: string,
  messages: readonly T[],
): T[] {
  if (messages.length === 0) return [];
  const deleted = matchingDeletedMessageIds(
    db,
    threadId,
    messages.map((message) => message.id),
  );
  return deleted.size === 0 ? [...messages] : messages.filter((message) => !deleted.has(message.id));
}

/** Claude can replay a live aggregate under different transcript IDs. Keep that removal too. */
export function withoutDeletedConversationMessages(
  db: DatabaseSync,
  threadId: string,
  messages: readonly ConversationMessage[],
): ConversationMessage[] {
  if (messages.length === 0) return [];
  const deleted = matchingDeletedMessageIds(
    db,
    threadId,
    messages.map((message) => message.id),
  );
  const kinds = deletedMessageKinds(
    db,
    threadId,
    messages.flatMap((message) => (message.turnId ? [message.turnId] : [])),
  );
  return messages.filter((message) => !deleted.has(message.id) && !isDeletedKind(message, kinds));
}

export function isDeletedConversationMessage(
  db: DatabaseSync,
  threadId: string,
  message: ConversationMessage,
): boolean {
  return (
    isDeletedThreadMessage(db, threadId, message.id) ||
    isDeletedKind(message, deletedMessageKinds(db, threadId, message.turnId ? [message.turnId] : []))
  );
}

function deletedMessageKinds(db: DatabaseSync, threadId: string, turnIds?: readonly string[]): Set<string> {
  const kinds = new Set<string>();
  const ids = turnIds === undefined ? undefined : [...new Set(turnIds)];
  const pages =
    ids === undefined
      ? [undefined]
      : Array.from({ length: Math.ceil(ids.length / 400) }, (_, page) => ids.slice(page * 400, page * 400 + 400));
  for (const page of pages) {
    const rows = databaseRows(
      db
        .prepare(`
      SELECT turn_id, message_kind FROM projection_deleted_thread_messages
      WHERE thread_id = ? AND message_kind IS NOT NULL
      ${page === undefined ? "" : `AND turn_id IN (${page.map(() => "?").join(",")})`}
    `)
        .all(threadId, ...(page ?? [])),
    );
    for (const row of rows)
      kinds.add(JSON.stringify([requiredStringColumn(row, "turn_id"), requiredStringColumn(row, "message_kind")]));
  }
  return kinds;
}

function isDeletedKind(message: ConversationMessage, kinds: ReadonlySet<string>): boolean {
  if (!message.turnId || message.author !== "assistant") return false;
  const kind =
    message.itemType === "agentMessage" || message.itemType === ROUTINE_QUIET_ANSWER_ITEM_TYPE
      ? "claude-answer"
      : message.id.endsWith(":reasoning")
        ? "claude-reasoning"
        : null;
  return kind !== null && kinds.has(JSON.stringify([message.turnId, kind]));
}

/** A deleted source must not stage or import raw transcript text again after Delete history. */
export function isDeletedProviderHistorySource(
  db: DatabaseSync,
  source: { threadId: string; provider: string; externalSessionId: string },
): boolean {
  return Boolean(
    db
      .prepare(`
    SELECT 1 FROM projection_deleted_provider_history_sources
    WHERE thread_id = ? AND provider = ? AND external_session_id = ?
  `)
      .get(source.threadId, source.provider, source.externalSessionId),
  );
}

export function isDeletedProviderHistoryImport(db: DatabaseSync, sessionId: string): boolean {
  return Boolean(
    db
      .prepare(`
    SELECT 1 FROM provider_history_imports source
    JOIN projection_deleted_provider_history_sources deleted
      ON deleted.thread_id = source.thread_id AND deleted.provider = source.provider
      AND deleted.external_session_id = source.external_session_id
    WHERE source.session_id = ?
  `)
      .get(sessionId),
  );
}

/** Item IDs, delivery client IDs and a live Claude aggregate all keep a person-deleted item out. */
export function deletedProviderHistoryItemFilter(
  db: DatabaseSync,
  threadId: string,
): (turnId: string, item: ThreadItem) => boolean {
  const ids = deletedThreadMessageIds(db, threadId);
  const kinds = deletedMessageKinds(db, threadId);
  return (turnId, item) => {
    if (isString(item.id) && ids.has(item.id)) return true;
    if (isString(item.clientId) && ids.has(item.clientId)) return true;
    if (
      item.type === "agentMessage" &&
      item.phase !== "commentary" &&
      kinds.has(JSON.stringify([turnId, "claude-answer"]))
    )
      return true;
    return item.type === "reasoning" && kinds.has(JSON.stringify([turnId, "claude-reasoning"]));
  };
}

/**
 * Records the delete of one shown message. Each read cursor and read baseline on the message moves
 * to the message shown before it, so the messages after it keep their unread state. Then the thread's
 * earlier events lose the message, so a replay and the event log do not keep its text.
 * Call it before the projection row is removed: the shown order comes from that row.
 */
export function recordDeletedThreadMessage(
  db: DatabaseSync,
  threadId: string,
  messageId: string,
  deletedAt: string,
): void {
  const shownRow = databaseRow(
    db
      .prepare(`
    SELECT message_json FROM projection_thread_messages WHERE thread_id = ? AND message_id = ?
  `)
      .get(threadId, messageId),
  );
  const shown = shownRow ? databaseRow(JSON.parse(requiredStringColumn(shownRow, "message_json"))) : null;
  const turnId = shown && isString(shown.turnId) ? shown.turnId : null;
  const kind =
    turnId && shown?.author === "assistant" && messageId === `${turnId}:assistant`
      ? "claude-answer"
      : turnId && shown?.author === "assistant" && messageId === `${turnId}:reasoning`
        ? "claude-reasoning"
        : null;
  db.prepare(
    `INSERT OR IGNORE INTO projection_deleted_thread_messages (thread_id, message_id, deleted_at, turn_id, message_kind)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(threadId, messageId, deletedAt, turnId, kind);
  if (turnId) {
    const items = databaseRows(
      db
        .prepare(`
      SELECT source.session_id, item.item_key, item.item_json
      FROM provider_history_staging item JOIN provider_history_imports source ON source.session_id = item.session_id
      WHERE source.thread_id = ? AND item.turn_id = ?
    `)
        .all(threadId, turnId),
    );
    const aliases = db.prepare(`
      INSERT OR IGNORE INTO projection_deleted_thread_messages(thread_id, message_id, deleted_at)
      VALUES (?, ?, ?)
    `);
    const remove = db.prepare(
      "DELETE FROM provider_history_staging WHERE session_id = ? AND turn_id = ? AND item_key = ?",
    );
    for (const row of items) {
      const item = databaseRow(JSON.parse(requiredStringColumn(row, "item_json")));
      if (
        !item ||
        !(
          item.id === messageId ||
          item.clientId === messageId ||
          (kind === "claude-answer" && item.type === "agentMessage" && item.phase !== "commentary") ||
          (kind === "claude-reasoning" && item.type === "reasoning")
        )
      )
        continue;
      if (isString(item.id)) aliases.run(threadId, item.id, deletedAt);
      remove.run(requiredStringColumn(row, "session_id"), turnId, requiredStringColumn(row, "item_key"));
    }
  }
  const previous = previousShownMessageId(db, threadId, messageId);
  db.prepare(
    "UPDATE projection_thread_reads SET through_message_id = ? WHERE thread_id = ? AND through_message_id = ?",
  ).run(previous, threadId, messageId);
  db.prepare(
    "UPDATE projection_thread_read_baselines SET through_message_id = ? WHERE thread_id = ? AND through_message_id = ?",
  ).run(previous, threadId, messageId);
  scrubDeletedMessageEvents(db, threadId, messageId);
}

function previousShownMessageId(db: DatabaseSync, threadId: string, messageId: string): string | null {
  const row = databaseRow(
    db
      .prepare(
        `${ORDERED_THREAD_MESSAGES}
         SELECT message_id FROM ordered
         WHERE (${ORDER_KEY_COLUMNS}) < (SELECT ${ORDER_KEY_COLUMNS} FROM ordered WHERE message_id = ?)
         AND NOT EXISTS (SELECT 1 FROM projection_deleted_thread_messages deleted WHERE deleted.thread_id = ? AND deleted.message_id = ordered.message_id)
         ORDER BY ${ORDER_KEY_DESC} LIMIT 1`,
      )
      .get(threadId, messageId, threadId),
  );
  return row ? requiredStringColumn(row, "message_id") : null;
}

/**
 * Removes one message from the earlier events of its thread. A whole snapshot and a change list lose
 * the message. An event that carries only this message keeps its other keys, and an empty change list
 * replaces the message, so the replay still applies the active turn of the event. The detail of an
 * event and its activity row stay: they hold no message text.
 */
function scrubDeletedMessageEvents(db: DatabaseSync, threadId: string, messageId: string): void {
  const needle = JSON.stringify(messageId).slice(1, -1);
  const isDeleted = (value: unknown) => isDynamicRecord(value) && isString(value.id) && value.id === messageId;
  scrubRows(
    db,
    "orchestration_events",
    "aggregate_type = 'thread' AND aggregate_id = ? AND instr(payload_json, ?) > 0",
    [threadId, needle],
    isDeleted,
  );
  scrubMessageActivities(db, threadId, isDeleted, needle);
  scrubMessageReceipts(db, threadId, isDeleted, needle);
}

/**
 * Records the delete of every shown message of a thread, for "Delete history". As
 * `recordDeletedThreadMessage` for each one, in a fixed number of statements: the read
 * cursors and baselines of the thread go back to "nothing read", and every earlier event of the
 * thread loses all its messages. An activity row that a replay filled with a whole event payload
 * loses them too. Call it before the projection rows are removed.
 */
export function recordDeletedThreadHistory(db: DatabaseSync, threadId: string, deletedAt: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO projection_deleted_thread_messages (thread_id, message_id, deleted_at)
     SELECT thread_id, message_id, ? FROM projection_thread_messages WHERE thread_id = ?`,
  ).run(deletedAt, threadId);
  db.prepare("UPDATE projection_thread_reads SET through_message_id = NULL WHERE thread_id = ?").run(threadId);
  db.prepare("UPDATE projection_thread_read_baselines SET through_message_id = NULL WHERE thread_id = ?").run(threadId);
  scrubAllMessages(db, "orchestration_events", "aggregate_type = 'thread' AND aggregate_id = ?", threadId);
  scrubAllMessages(db, "projection_thread_activities", "thread_id = ?", threadId);
  scrubMessageReceipts(db, threadId, (value) => isDynamicRecord(value) && isString(value.id));
  db.prepare(`
    INSERT OR IGNORE INTO projection_deleted_provider_history_sources(thread_id, provider, external_session_id, deleted_at)
    SELECT thread_id, provider, external_session_id, ? FROM projection_provider_sessions WHERE thread_id = ?
  `).run(deletedAt, threadId);
  db.prepare(`
    INSERT OR IGNORE INTO projection_deleted_provider_history_sources(thread_id, provider, external_session_id, deleted_at)
    SELECT thread_id, provider, external_session_id, ? FROM provider_history_imports WHERE thread_id = ?
  `).run(deletedAt, threadId);
  db.prepare(
    "DELETE FROM provider_history_staging WHERE session_id IN (SELECT session_id FROM provider_history_imports WHERE thread_id = ?)",
  ).run(threadId);
  db.prepare(
    "DELETE FROM provider_history_turns WHERE session_id IN (SELECT session_id FROM provider_history_imports WHERE thread_id = ?)",
  ).run(threadId);
  db.prepare(
    "UPDATE provider_history_imports SET state = 'complete', cursor_json = NULL, updated_at = ? WHERE thread_id = ?",
  ).run(deletedAt, threadId);
}

function scrubMessageActivities(
  db: DatabaseSync,
  threadId: string,
  isDeleted: (value: unknown) => boolean,
  needle: string,
): void {
  scrubRows(
    db,
    "projection_thread_activities",
    `thread_id = ? AND instr(payload_json, ?) > 0 AND (instr(payload_json, 'Message') > 0 OR instr(payload_json, '"snapshot"') > 0)`,
    [threadId, needle],
    isDeleted,
  );
}

/** Full-snapshot command results are durable copies too; keep receipt identity without its text. */
function scrubMessageReceipts(
  db: DatabaseSync,
  threadId: string,
  isDeleted: (value: unknown) => boolean,
  needle: string | null = null,
): void {
  const commands = db.prepare(`
    SELECT event.sequence, event.command_id FROM orchestration_events event
    JOIN orchestration_command_receipts receipt ON receipt.command_id = event.command_id
    WHERE event.aggregate_type = 'thread' AND event.aggregate_id = ? AND event.sequence > ?
      AND (? IS NULL OR instr(receipt.result_json, ?) > 0) ORDER BY event.sequence LIMIT 128
  `);
  const read = db.prepare("SELECT result_json FROM orchestration_command_receipts WHERE command_id = ?");
  const update = db.prepare("UPDATE orchestration_command_receipts SET result_json = ? WHERE command_id = ?");
  let after = 0;
  for (;;) {
    const rows = databaseRows(commands.all(threadId, after, needle, needle));
    if (rows.length === 0) break;
    for (const command of rows) {
      after = requiredNumberColumn(command, "sequence");
      const commandId = requiredStringColumn(command, "command_id");
      const row = databaseRow(read.get(commandId));
      const result = row ? databaseRow(JSON.parse(requiredStringColumn(row, "result_json"))) : null;
      if (!result) continue;
      const next = scrubbedPayload(result, isDeleted);
      if (result.threadId === threadId && Array.isArray(result.messages) && result.messages.some(isDeleted))
        update.run(
          JSON.stringify({ ...result, messages: result.messages.filter((message) => !isDeleted(message)) }),
          commandId,
        );
      else if (next) update.run(JSON.stringify(next), commandId);
    }
  }
}

/**
 * Removes every message from the payloads of one thread's rows in `table`, one row at a time: a long
 * thread's events hold full snapshots, too large to read all at once. Only a payload with a snapshot
 * or a message key ("…Message" or "…Messages") can carry one. The alias is required: SQLite names a
 * `rowid` column after the `INTEGER PRIMARY KEY` that it aliases, such as `sequence`.
 */
function scrubAllMessages(
  db: DatabaseSync,
  table: "orchestration_events" | "projection_thread_activities",
  where: string,
  threadId: string,
): void {
  scrubRows(
    db,
    table,
    `${where} AND (instr(payload_json, 'Message') > 0 OR instr(payload_json, '"snapshot"') > 0)`,
    [threadId],
    (value) => isDynamicRecord(value) && isString(value.id),
  );
}

/** Only keys are paged; even old full-snapshot events are decoded and replaced one at a time. */
function scrubRows(
  db: DatabaseSync,
  table: "orchestration_events" | "projection_thread_activities",
  where: string,
  parameters: string[],
  isDeleted: (value: unknown) => boolean,
): void {
  const page = db.prepare(
    `SELECT rowid AS row_key FROM ${table} WHERE ${where} AND rowid > ? ORDER BY rowid LIMIT 128`,
  );
  const read = db.prepare(`SELECT payload_json FROM ${table} WHERE rowid = ?`);
  const update = db.prepare(`UPDATE ${table} SET payload_json = ? WHERE rowid = ?`);
  let after = 0;
  for (;;) {
    const keys = databaseRows(page.all(...parameters, after));
    if (keys.length === 0) break;
    for (const key of keys) {
      after = requiredNumberColumn(key, "row_key");
      const row = databaseRow(read.get(after));
      const payload = row ? databaseRow(JSON.parse(requiredStringColumn(row, "payload_json"))) : null;
      const scrubbed = payload ? scrubbedPayload(payload, isDeleted) : null;
      if (scrubbed) update.run(JSON.stringify(scrubbed), after);
    }
  }
}

/** The payload without the messages that `isDeleted` names, or null when the payload carries none. */
function scrubbedPayload(payload: DynamicRecord, isDeleted: (value: unknown) => boolean): DynamicRecord | null {
  const without = (messages: readonly unknown[]) => messages.filter((message) => !isDeleted(message));
  const next = { ...payload };
  let changed = false;
  const snapshot = payload.snapshot;
  if (isDynamicRecord(snapshot) && Array.isArray(snapshot.messages) && snapshot.messages.some(isDeleted)) {
    next.snapshot = { ...snapshot, messages: without(snapshot.messages) };
    changed = true;
  }
  if (Array.isArray(payload.changedMessages) && payload.changedMessages.some(isDeleted)) {
    next.changedMessages = without(payload.changedMessages);
    changed = true;
  }
  for (const key of ["appendedMessage", "streamedMessage", "importedMessage"]) {
    if (!isDeleted(payload[key])) continue;
    delete next[key];
    if (!Array.isArray(next.changedMessages)) next.changedMessages = [];
    changed = true;
  }
  return changed ? next : null;
}
