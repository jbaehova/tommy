// Production SQLite and AgentStore, with temporary data only. No provider, account or app starts.
// Run: bun scripts/message-deletion-e2e.ts
// Writes .tommy-build/message-deletion-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChannelMessage, ChannelTask, ConversationMessage, ConversationSnapshot } from "@tommy/contracts/ipc";
import { AgentStore } from "../src/backend/agent-store";
import { type ChannelAssignment, ChannelStore } from "../src/backend/channel-store";
import { databaseRow, databaseRows, requiredStringColumn } from "../src/backend/database/database-rows";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MessageDeleteRefused } from "../src/backend/message-deletion";
import { TommyDatabase } from "../src/backend/tommy-database";

const OUT = resolve(import.meta.dirname, "../.tommy-build/message-deletion-e2e");
const report: { passed: boolean; checks: string[]; error?: string } = { passed: false, checks: [] };
const scratch = await mkdtemp(join(tmpdir(), "tommy-message-deletion-"));
let database = new TommyDatabase(join(scratch, "state"));
const store = new AgentStore(join(scratch, "state"), join(scratch, "home"), database);

function message(id: string, minute: number, extra: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id,
    author: "assistant",
    itemType: "agentMessage",
    text: `Text ${id}`,
    createdAt: new Date(Date.UTC(2026, 10, 10, 12, minute)).toISOString(),
    status: "completed",
    ...extra,
  };
}

function refused(fn: () => unknown, reason: MessageDeleteRefused["reason"]): void {
  assert.throws(fn, (error) => error instanceof MessageDeleteRefused && error.reason === reason);
}

try {
  await runCauseEffect(store.initialize());
  const writer = await runCauseEffect(
    store.createAgent({ name: "Writer", description: "Deletion fixture", avatarSeed: "writer", avatarHue: null }),
  );
  const other = await runCauseEffect(
    store.createAgent({
      name: "Other",
      description: "Shared attachment fixture",
      avatarSeed: "other",
      avatarHue: null,
    }),
  );
  const threadId = store.ensureThreadIdNow(writer.id);
  const otherThread = store.ensureThreadIdNow(other.id);
  const attachment = {
    id: "shared-attachment",
    name: "shared.txt",
    size: 4,
    kind: "file" as const,
    mimeType: "text/plain",
    previewKind: "text" as const,
    previewUrl: null,
  };
  const target = message("delete-target", 1, {
    author: "user",
    source: "user",
    senderMember: { id: "member-a", name: "Example" },
    text: "unique removed message text",
    attachments: [attachment],
  });
  const seed: ConversationSnapshot = {
    agentId: writer.id,
    threadId,
    activeTurnId: null,
    revision: 0,
    messages: [message("before", 0), target, message("after", 2)],
  };
  database.persistConversation(seed, "conversation.seeded");
  database.persistConversation(
    {
      agentId: other.id,
      threadId: otherThread,
      activeTurnId: null,
      revision: 0,
      messages: [message("kept-file", 0, { attachments: [attachment] })],
    },
    "conversation.seeded",
  );
  database.connection
    .prepare("INSERT INTO projection_thread_reads(thread_id,member_id,through_message_id,updated_at) VALUES (?,?,?,?)")
    .run(threadId, "member-a", target.id, target.createdAt);
  database.connection
    .prepare("INSERT INTO projection_thread_read_baselines(thread_id,through_message_id,initialized_at) VALUES (?,?,?)")
    .run(threadId, target.id, target.createdAt);

  refused(
    () =>
      database.deleteConversationMessage({
        agentId: writer.id,
        threadId,
        messageId: target.id,
        requestId: "forbidden",
        access: { memberId: "member-b", deleteAny: false },
      }),
    "forbidden",
  );
  refused(
    () =>
      database.deleteConversationMessage({
        agentId: other.id,
        threadId,
        messageId: target.id,
        requestId: "wrong-owner",
        access: { memberId: null, deleteAny: true },
      }),
    "not-found",
  );
  const removed = database.deleteConversationMessage({
    agentId: writer.id,
    threadId,
    messageId: target.id,
    requestId: "remove-one",
    access: { memberId: "member-a", deleteAny: false },
  });
  assert.equal(removed.deleted, true);
  assert.deepEqual(removed.removedMessageIds, [target.id]);
  assert.equal(
    database.readConversation(writer.id, threadId).messages.some((item) => item.id === target.id),
    false,
  );
  assert.equal(database.readConversation(other.id, otherThread).messages[0]?.attachments?.[0]?.id, attachment.id);
  assert.equal(
    requiredStringColumn(
      databaseRow(
        database.connection
          .prepare("SELECT through_message_id FROM projection_thread_reads WHERE thread_id = ? AND member_id = ?")
          .get(threadId, "member-a"),
      ) ?? {},
      "through_message_id",
    ),
    "before",
  );
  assert.equal(
    requiredStringColumn(
      databaseRow(
        database.connection
          .prepare("SELECT through_message_id FROM projection_thread_read_baselines WHERE thread_id = ?")
          .get(threadId),
      ) ?? {},
      "through_message_id",
    ),
    "before",
  );
  report.checks.push("ownership, member access, shared attachment and read cursors");

  database.persistConversation(seed, "conversation.stale-snapshot");
  database.persistStreamingMessage({ snapshot: seed, messageId: target.id, eventType: "conversation.stale-stream" });
  database.persistConversationChanges({
    agentId: writer.id,
    threadId,
    activeTurnId: null,
    changedMessages: [target],
    eventType: "conversation.stale-update",
  });
  database.upsertProviderHistoryMessage({ agentId: writer.id, threadId, message: target });
  database.appendConversationMessage({
    agentId: writer.id,
    threadId,
    activeTurnId: null,
    message: target,
    eventType: "conversation.stale-append",
  });
  assert.equal(database.changedConversationMessages(threadId, [target]).length, 0);
  assert.equal(
    database.rebuildThreadProjection(threadId).messages.some((item) => item.id === target.id),
    false,
  );
  const oldText = databaseRows(
    database.connection
      .prepare("SELECT payload_json FROM orchestration_events WHERE aggregate_type = 'thread' AND aggregate_id = ?")
      .all(threadId),
  ).some((row) => requiredStringColumn(row, "payload_json").includes(target.text));
  assert.equal(oldText, false);
  report.checks.push("all durable writer paths and event replay keep a deleted message out");

  const live = message("live-answer", 3, { turnId: "live-turn", status: "streaming" });
  database.persistConversationChanges({
    agentId: writer.id,
    threadId,
    activeTurnId: "live-turn",
    changedMessages: [live],
    eventType: "turn.started",
  });
  refused(
    () =>
      database.deleteConversationMessage({
        agentId: writer.id,
        threadId,
        messageId: live.id,
        requestId: "delete-active",
        access: { memberId: null, deleteAny: true },
      }),
    "busy",
  );
  refused(
    () => database.deleteThreadHistory({ agentId: writer.id, threadId, requestId: "delete-active-history" }),
    "busy",
  );
  database.persistConversationChanges({
    agentId: writer.id,
    threadId,
    activeTurnId: null,
    changedMessages: [{ ...live, status: "completed" }],
    eventType: "turn.completed",
    detail: { turnId: "live-turn", status: "completed" },
  });
  report.checks.push("active turn deletion is refused without partial changes");

  const canonical = message("claude-turn:assistant", 4, { turnId: "claude-turn", text: "canonical Claude answer" });
  database.persistConversationChanges({
    agentId: writer.id,
    threadId,
    activeTurnId: null,
    changedMessages: [canonical],
    eventType: "conversation.claude-fixture",
  });
  const session = database.bindProviderSession({
    threadId,
    provider: "claude",
    externalSessionId: "deleted-source",
    model: writer.model,
    effort: writer.reasoningEffort,
  });
  database.ensureProviderHistoryImport({
    sessionId: session.id,
    threadId,
    provider: "claude",
    externalSessionId: session.externalSessionId,
  });
  database.stageProviderHistoryFragment({
    sessionId: session.id,
    fragment: {
      turnId: "claude-turn",
      items: [{ id: "transcript-original", type: "agentMessage", text: canonical.text }],
      complete: true,
    },
  });
  database.deleteConversationMessage({
    agentId: writer.id,
    threadId,
    messageId: canonical.id,
    requestId: "remove-canonical",
    access: { memberId: null, deleteAny: true },
  });
  assert.equal(database.stagedProviderHistoryItems({ sessionId: session.id, turnId: "claude-turn" }).length, 0);
  database.stageProviderHistoryFragment({
    sessionId: session.id,
    fragment: {
      turnId: "claude-turn",
      items: [{ id: "transcript-alias", type: "agentMessage", text: canonical.text }],
      complete: true,
    },
  });
  database.upsertProviderHistoryMessage({
    agentId: writer.id,
    threadId,
    message: { ...canonical, id: "transcript-alias" },
  });
  assert.equal(database.stagedProviderHistoryItems({ sessionId: session.id, turnId: "claude-turn" }).length, 0);
  assert.equal(
    database.readConversation(writer.id, threadId).messages.some((item) => item.turnId === "claude-turn"),
    false,
  );
  report.checks.push("Claude aggregate aliases and raw staging do not restore removed output");

  database.saveThreadSummary(threadId, "after", "unique history summary text", 10);
  database.rebuildThreadProjection(threadId);
  const revision = database.deleteThreadHistory({ agentId: writer.id, threadId, requestId: "remove-history" });
  assert.equal(database.readConversation(writer.id, threadId).messages.length, 0);
  assert.equal(database.latestThreadSummary(threadId), null);
  assert.equal(database.activeProviderSession(threadId, "claude"), null);
  assert.equal(database.stagedProviderHistoryTurns(session.id).length, 0);
  const rawRows = databaseRows(
    database.connection
      .prepare("SELECT payload_json FROM projection_thread_activities WHERE thread_id = ?")
      .all(threadId),
  );
  assert.equal(
    rawRows.some((row) => requiredStringColumn(row, "payload_json").includes("unique history summary text")),
    false,
  );
  assert.equal(database.rebuildThreadProjection(threadId).messages.length, 0);
  const staged = database.stageProviderHistoryFragment({
    sessionId: session.id,
    fragment: {
      turnId: "late-turn",
      items: [{ id: "late-answer", type: "agentMessage", text: "old provider history" }],
      complete: true,
    },
  });
  assert.equal(staged.turnImported, true);
  database.importProviderHistoryMessages({
    sessionId: session.id,
    turnId: "late-turn",
    agentId: writer.id,
    threadId,
    messages: [message("late-answer", 4)],
    complete: true,
  });
  assert.equal(database.readConversation(writer.id, threadId).messages.length, 0);
  assert.throws(() =>
    database.bindProviderSession({
      threadId,
      provider: "claude",
      externalSessionId: session.externalSessionId,
      model: writer.model,
      effort: writer.reasoningEffort,
    }),
  );
  database.persistConversationChanges({
    agentId: writer.id,
    threadId,
    activeTurnId: null,
    changedMessages: [message("new-after-delete", 6)],
    eventType: "conversation.new-after-delete",
  });
  assert.equal(database.deleteThreadHistory({ agentId: writer.id, threadId, requestId: "remove-history" }), revision);
  assert.equal(
    database.threadHistoryDeletionReceipt(threadId, "remove-history")?.messageIds.includes("new-after-delete"),
    false,
  );
  assert.equal(database.readConversation(writer.id, threadId).messages[0]?.id, "new-after-delete");
  database.close();
  database = new TommyDatabase(join(scratch, "state"));
  await runCauseEffect(database.initialize());
  assert.equal(database.rebuildThreadProjection(threadId).messages[0]?.id, "new-after-delete");
  assert.equal(database.readConversation(other.id, otherThread).messages[0]?.attachments?.[0]?.id, attachment.id);
  report.checks.push(
    "whole history removes summaries, staged text and provider sources; retry and restart preserve new work",
  );

  const channels = new ChannelStore(database);
  const channelId = "deletion-channel";
  const channelMessage = (id: string, minute: number): ChannelMessage => ({
    id,
    channelId,
    sequence: 0,
    author: { kind: "member", id: "member-a", name: "Example" },
    taskId: null,
    superseded: false,
    message: message(id, minute, { author: "user", source: "user", text: `unique channel text ${id}` }),
  });
  let channel = channels.update(
    channels.create(channelId, {
      name: "deletion",
      title: "",
      instructions: "Keep instructions",
      members: [{ agentId: writer.id }],
      leadAgentId: writer.id,
    }),
    { messages: [channelMessage("channel-before", 1), channelMessage("channel-target", 2)] },
    "channel-seed",
  );
  const removedChannelMessage = channels.message(channelId, "channel-target");
  assert.ok(removedChannelMessage);
  channel = channels.deleteMessage(channel, removedChannelMessage, "channel-remove-one");
  assert.equal(channels.message(channelId, removedChannelMessage.id), null);
  assert.equal(channels.messageDeleted(channelId, removedChannelMessage.id), true);
  channel = channels.update(channel, { messages: [removedChannelMessage] }, "channel-late-capture");
  assert.equal(channels.message(channelId, removedChannelMessage.id), null);
  channels.rebuild(channelId);
  assert.deepEqual(
    channels.page(channelId).messages.map((entry) => entry.id),
    ["channel-before"],
  );
  assert.equal(channels.page(channelId).throughSequence, 2);
  const execution = channels.context(channelId, writer.id);
  database.persistConversationChanges({
    agentId: writer.id,
    threadId: execution.threadId,
    activeTurnId: null,
    changedMessages: [message("channel-execution-text", 5)],
    eventType: "conversation.channel-fixture",
  });
  database.bindProviderSession({
    threadId: execution.threadId,
    provider: "codex",
    externalSessionId: "channel-deleted-source",
    model: writer.model,
    effort: writer.reasoningEffort,
  });
  const stopped: ChannelTask = {
    id: "deleted-history-task",
    channelId,
    parentTaskId: null,
    rootTaskId: "deleted-history-task",
    ownerAgentId: writer.id,
    requestMessageId: "channel-before",
    instruction: "private stopped request text",
    expectedResult: "private expected result",
    attachmentDraftIds: [],
    sourceMessageIds: ["channel-before"],
    dependencies: [],
    resources: ["private resource path"],
    state: "paused",
    revision: 4,
    assignmentCount: 1,
    error: "private stopped failure",
  };
  const stoppedAssignment: ChannelAssignment = {
    id: "deleted-history-assignment",
    channelId,
    taskId: stopped.id,
    agentId: writer.id,
    taskRevision: stopped.revision,
    requestMessageId: stopped.requestMessageId,
    resources: [...stopped.resources],
    deliveryId: "old-assignment-delivery",
    turnId: "old-assignment-turn",
    state: "interrupted",
    throughSequence: 2,
    summaryVersion: 0,
    awaitedTaskIds: [],
    pendingRevision: null,
    pendingOutcome: "private pending outcome",
  };
  channels.update(
    channels.get(channelId),
    { tasks: [stopped], assignments: [stoppedAssignment] },
    "channel-stopped-task",
  );
  channels.saveSummary(channelId, { version: 10, throughSequence: 2, text: "unique channel summary text" });
  const channelDeleted = channels.deleteHistory(channels.get(channelId), "channel-remove-history");
  assert.equal(channelDeleted.deleted, true);
  assert.equal(channels.page(channelId).messages.length, 0);
  assert.equal(channels.summary(channelId).text, "");
  const removedTask = channels.tasks(channelId).find((task) => task.id === stopped.id);
  assert.ok(removedTask);
  assert.equal(removedTask.state, "cancelled");
  assert.equal(removedTask.instruction, "");
  assert.equal(removedTask.expectedResult, "");
  assert.equal(removedTask.error, null);
  assert.deepEqual(removedTask.resources, []);
  assert.deepEqual(channelDeleted.deliveries, [{ agentId: writer.id, deliveryId: stoppedAssignment.deliveryId }]);
  assert.equal(channels.assignments(channelId)[0]?.pendingOutcome, null);

  assert.equal(database.readConversation(writer.id, execution.threadId).messages.length, 0);
  assert.equal(database.activeProviderSession(execution.threadId, "codex"), null);
  assert.equal(database.readConversation(writer.id, threadId).messages[0]?.id, "new-after-delete");
  channel = channels.update(
    channels.get(channelId),
    { messages: [channelMessage("channel-new-after-delete", 7)] },
    "channel-future-message",
  );
  assert.deepEqual(channels.deleteHistory(channel, "channel-remove-history"), channelDeleted);
  assert.equal(channels.page(channelId).messages[0]?.id, "channel-new-after-delete");
  channels.rebuild(channelId);
  assert.equal(channels.page(channelId).messages[0]?.id, "channel-new-after-delete");
  assert.equal(channels.get(channelId).instructions, "Keep instructions");
  assert.deepEqual(
    channels.tasks(channelId).find((task) => task.id === stopped.id),
    removedTask,
  );
  const channelEventText = databaseRows(
    database.connection
      .prepare("SELECT payload_json FROM orchestration_events WHERE aggregate_type = 'channel' AND aggregate_id = ?")
      .all(channelId),
  )
    .map((row) => requiredStringColumn(row, "payload_json"))
    .join("\n");
  assert.equal(channelEventText.includes(removedChannelMessage.message.text), false);
  assert.equal(channelEventText.includes("unique channel summary text"), false);
  for (const text of [
    stopped.instruction,
    stopped.expectedResult,
    stopped.error,
    ...stopped.resources,
    stoppedAssignment.pendingOutcome,
  ]) {
    assert.ok(text);
    assert.equal(channelEventText.includes(text), false);
  }

  report.checks.push(
    "channel tombstones, stopped task privacy, old event text, execution sessions, sequence cursors and history retry",
  );
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  database.close();
  await rm(scratch, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const check of report.checks) process.stdout.write(`ok ${check}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (!report.passed) process.exitCode = 1;
}
