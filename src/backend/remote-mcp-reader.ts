import type { DynamicRecord } from "@tommy/contracts/runtime-values";
import { optionalStringColumn, requiredStringColumn } from "./database/database-rows";
import type { TommyDatabase } from "./tommy-database";

/** One chat message as the remote MCP tools show it. The text is stored text: redact it before it leaves. */
export interface RemoteMcpMessageRow {
  agentId: string;
  threadId: string;
  messageId: string;
  author: string;
  createdAt: string;
  text: string;
}

/** The position after the last message of a page, newest first. */
export interface RemoteMcpMessageCursor {
  createdAt: string;
  messageId: string;
}

/**
 * Chat items that hold what a person or an agent said. System notices, work notes and subagent
 * cards stay out: they repeat state that the other tools show, or they are noise.
 */
const VISIBLE_MESSAGES = `m.author IN ('user', 'assistant', 'agent')
  AND (m.item_type IS NULL OR m.item_type NOT IN ('commentary', 'subagents'))`;

/**
 * Owns the read-only queries of the remote MCP tools on the agent chats. It reads `.connection` at
 * each use, opens no transaction and never writes. It does not import the facade's controllers.
 */
export class RemoteMcpReader {
  readonly #database: TommyDatabase;

  constructor(database: TommyDatabase) {
    this.#database = database;
  }

  /** The messages of these agents' chats, newest first, after `cursor`. */
  page(agentIds: readonly string[], cursor: RemoteMcpMessageCursor | null, limit: number): RemoteMcpMessageRow[] {
    if (agentIds.length === 0) return [];
    const marks = agentIds.map(() => "?").join(", ");
    const rows = this.#database.connection
      .prepare(
        `SELECT t.agent_id, m.thread_id, m.message_id, m.author, m.created_at,
                COALESCE(json_extract(m.message_json, '$.text'), '') AS text
         FROM projection_thread_messages m JOIN projection_threads t ON t.thread_id = m.thread_id
         WHERE t.agent_id IN (${marks}) AND ${VISIBLE_MESSAGES}
           AND (? IS NULL OR m.created_at < ? OR (m.created_at = ? AND m.message_id < ?))
         ORDER BY m.created_at DESC, m.message_id DESC LIMIT ?`,
      )
      .all(
        ...agentIds,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.messageId ?? null,
        limit,
      );
    return rows.map(decodeRow);
  }

  /** The messages of one agent's chats around one message, with that message, oldest first. */
  around(agentId: string, messageId: string, limit: number): RemoteMcpMessageRow[] {
    const anchor = this.#database.connection
      .prepare(
        `SELECT m.created_at, m.message_id FROM projection_thread_messages m
         JOIN projection_threads t ON t.thread_id = m.thread_id
         WHERE t.agent_id = ? AND m.message_id = ? AND ${VISIBLE_MESSAGES} LIMIT 1`,
      )
      .get(agentId, messageId);
    if (!anchor) return [];
    const createdAt = requiredStringColumn(anchor, "created_at");
    const after = Math.floor(limit / 2);
    const newer = this.#database.connection
      .prepare(
        `SELECT t.agent_id, m.thread_id, m.message_id, m.author, m.created_at,
                COALESCE(json_extract(m.message_json, '$.text'), '') AS text
         FROM projection_thread_messages m JOIN projection_threads t ON t.thread_id = m.thread_id
         WHERE t.agent_id = ? AND ${VISIBLE_MESSAGES}
           AND (m.created_at > ? OR (m.created_at = ? AND m.message_id > ?))
         ORDER BY m.created_at ASC, m.message_id ASC LIMIT ?`,
      )
      .all(agentId, createdAt, createdAt, messageId, after)
      .map(decodeRow);
    // The anchor itself is the first row of the older part.
    const older = this.page([agentId], { createdAt, messageId: `${messageId}\u0000` }, limit - newer.length);
    return [...older.reverse(), ...newer];
  }
}

function decodeRow(row: DynamicRecord): RemoteMcpMessageRow {
  return {
    agentId: requiredStringColumn(row, "agent_id"),
    threadId: requiredStringColumn(row, "thread_id"),
    messageId: requiredStringColumn(row, "message_id"),
    author: requiredStringColumn(row, "author"),
    createdAt: requiredStringColumn(row, "created_at"),
    text: optionalStringColumn(row, "text") ?? "",
  };
}
