import type { DatabaseSync } from "node:sqlite";
import type { ChannelMessage, ChannelTask } from "@tommy/contracts/ipc";
import { isChannelMessage, isChannelTask } from "@tommy/contracts/ipc";
import { isDynamicRecord } from "@tommy/contracts/runtime-values";
import type { ChannelAssignment } from "./channel-store";
import { databaseRow, databaseRows, requiredNumberColumn, requiredStringColumn } from "./database/database-rows";

/** A row keeps its sequence after removal. Current and old clients never receive the row. */
export function deletedChannelMessage(entry: ChannelMessage): ChannelMessage & { deleted: true } {
  return {
    id: entry.id,
    channelId: entry.channelId,
    sequence: entry.sequence,
    author: entry.author,
    taskId: entry.taskId,
    superseded: entry.superseded,
    deleted: true,
    message: {
      id: entry.message.id,
      author: entry.message.author,
      text: "",
      createdAt: entry.message.createdAt,
      status: "completed",
      itemType: "deleted",
    },
  };
}

export function isDeletedChannelMessage(value: unknown): boolean {
  return isDynamicRecord(value) && value.deleted === true;
}

/** A removed history cannot leave its requests in resumable tasks or error cards. */
export function deletedChannelTask(task: ChannelTask): ChannelTask {
  return {
    ...task,
    instruction: "",
    expectedResult: "",
    error: null,
    attachmentDraftIds: [],
    sourceMessageIds: [],
    dependencies: [],
    resources: [],
    state: task.state === "completed" ? "completed" : "cancelled",
  };
}

export function deletedChannelAssignment(assignment: ChannelAssignment): ChannelAssignment {
  return { ...assignment, resources: [], pendingRevision: null, pendingOutcome: null };
}

/** Message bodies and old summaries are replaced a row at a time, including the INTEGER PK alias. */
export function scrubChannelEvents(db: DatabaseSync, channelId: string, messageId: string | null): void {
  const select = db.prepare(`
    SELECT sequence FROM orchestration_events WHERE aggregate_type = 'channel' AND aggregate_id = ?
      AND event_type IN ('channel.changed', 'channel.summarized') AND sequence > ?
      AND (? IS NULL OR instr(payload_json, ?) > 0) ORDER BY sequence LIMIT 128
  `);
  const read = db.prepare("SELECT event_type, payload_json FROM orchestration_events WHERE sequence = ?");
  const write = db.prepare("UPDATE orchestration_events SET payload_json = ? WHERE sequence = ?");
  const needle = messageId === null ? null : JSON.stringify(messageId).slice(1, -1);
  let after = 0;
  for (;;) {
    const rows = databaseRows(select.all(channelId, after, needle, needle));
    if (rows.length === 0) break;
    for (const row of rows) {
      after = requiredNumberColumn(row, "sequence");
      const event = databaseRow(read.get(after));
      const payload = event ? JSON.parse(requiredStringColumn(event, "payload_json")) : null;
      if (!event || !isDynamicRecord(payload)) continue;
      if (event.event_type === "channel.summarized") {
        if (messageId === null && typeof payload.text === "string" && payload.text)
          write.run(JSON.stringify({ ...payload, text: "" }), after);
        continue;
      }
      let changed = false;
      const messages = Array.isArray(payload.messages)
        ? payload.messages.map((entry: unknown) => {
            if (
              !isChannelMessage(entry) ||
              isDeletedChannelMessage(entry) ||
              (messageId !== null && entry.id !== messageId)
            )
              return entry;
            changed = true;
            return deletedChannelMessage(entry);
          })
        : payload.messages;
      let tasks = payload.tasks;
      let assignments = payload.assignments;
      if (messageId === null) {
        if (Array.isArray(tasks)) {
          tasks = tasks.map((task: unknown) => {
            if (!isChannelTask(task)) return task;
            changed = true;
            return deletedChannelTask(task);
          });
        }
        if (Array.isArray(assignments)) {
          assignments = assignments.map((assignment: unknown) => {
            if (!isDynamicRecord(assignment)) return assignment;
            changed = true;
            return { ...assignment, resources: [], pendingRevision: null, pendingOutcome: null };
          });
        }
      }
      if (changed) write.run(JSON.stringify({ ...payload, messages, tasks, assignments }), after);
    }
  }
}
