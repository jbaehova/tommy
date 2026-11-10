// Runs the real AgentService, SQLite, mailbox and skill library in a scratch profile. A local
// stdio stand-in is the only provider. It reads no account, user database or provider home.
// Run: bun scripts/conversation-removal-e2e.ts
// Artifact: .tommy-build/conversation-removal-e2e/report.json
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type AgentEvent, type AgentSummary, type ConversationMessage } from "@tommy/contracts/ipc";
import { skillSuggestionItemType } from "@tommy/contracts/ipc-skill-learning";
import { isDynamicRecord } from "@tommy/contracts/runtime-values";
import { Effect } from "effect";
import { MemoryReviewCursors } from "../src/backend/agent/memory-review-store";
import { SkillLearningFailed } from "../src/backend/agent/skill-learning";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { CodexAppServerClient } from "../src/backend/app-server-client";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { MessageDeleteRefused } from "../src/backend/message-deletion";
import { TommyDatabase } from "../src/backend/tommy-database";
import { LocalSkillLibrary } from "../src/main/local-skill-library";
import { SkillLearningService } from "../src/main/skill-learning-service";
import { SkillMarketplaceService } from "../src/main/skill-marketplace-service";

const OUT = resolve(import.meta.dirname, "../.tommy-build/conversation-removal-e2e");
const scratch = await mkdtemp(join(tmpdir(), "tommy-conversation-removal-"));
const userData = join(scratch, "user-data");
const home = join(scratch, "profile-home");
const executable = join(scratch, "codex");
const providerLog = join(scratch, "provider.jsonl");
const failRelease = join(scratch, "fail-release");
const failArchive = join(scratch, "fail-archive");
const commandFile = join(scratch, "provider-command.json");
const previousCli = process.env.TOMMY_CODEX_PATH;
// Only CLI discovery changes. HOME and CODEX_HOME stay untouched. The injected client below
// always runs our stand-in, which has no credential or filesystem discovery code.
process.env.TOMMY_CODEX_PATH = executable;
await mkdir(home, { recursive: true });
await writeFile(providerLog, "");

const FAKE = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, unlinkSync, watch } = require("node:fs");
if (process.argv.includes("--version")) { console.log("codex-cli 0.160.1"); process.exit(0); }
const LOG = ${JSON.stringify(providerLog)};
const COMMAND = ${JSON.stringify(commandFile)};
const RELEASE = ${JSON.stringify(failRelease)};
const ARCHIVE = ${JSON.stringify(failArchive)};
const log = (entry) => appendFileSync(LOG, JSON.stringify({ pid: process.pid, ...entry }) + "\\n");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffer = "", threads = 0, turns = 0, lastCommand = "";
const held = new Map();
process.on("exit", () => log({ method: "process-exit" }));
process.on("SIGTERM", () => process.exit(0));
process.stdout.on("error", (error) => { if (error.code === "EPIPE") process.exit(0); throw error; });
const finish = (threadId, turnId, text) => setImmediate(() => {
  write({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "reply-" + turnId, text, phase: "final_answer" } } });
  setImmediate(() => write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } }));
});
// Test commands release the actual pending provider turn. A cancelled disposable process cannot
// consume its old command, so a late answer after deletion cannot reach the application.
const watcher = watch(${JSON.stringify(scratch)}, (_event, name) => {
  if (name !== "provider-command.json" || !existsSync(COMMAND)) return;
  let command;
  try { command = JSON.parse(readFileSync(COMMAND, "utf8")); } catch { return; }
  if (command.nonce === lastCommand) return;
  lastCommand = command.nonce;
  const pending = held.get(command.turnId);
  if (!pending) return;
  held.delete(command.turnId);
  finish(pending.threadId, command.turnId, command.text);
});
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: ${JSON.stringify(join(home, "config.toml"))}, profile: null }, version: "1", config: { mcp_servers: {} } }] };
function answer(message) {
  const params = message.params || {};
  const result = (value) => write({ id: message.id, result: value });
  switch (message.method) {
    case "initialize": return result({});
    case "account/read": return result({ account: { type: "chatgpt", email: "example@example.com" } });
    case "account/rateLimits/read": return result({ rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null });
    case "model/list": return result({ data: [{ model: "gpt-6-luna", displayName: "GPT-6 Luna" }] });
    case "plugin/list": return result({ marketplaces: [] });
    case "config/read": return result(config);
    case "config/batchWrite": return result({});
    case "thread/start": {
      const threadId = "thread-" + process.pid + "-" + (++threads);
      log({ method: message.method, threadId });
      return result({ thread: { id: threadId, turns: [] } });
    }
    case "thread/resume": {
      log({ method: message.method, threadId: params.threadId });
      return result({ thread: { id: params.threadId, turns: [] } });
    }
    case "thread/unsubscribe":
    case "thread/archive": {
      const marker = message.method === "thread/unsubscribe" ? RELEASE : ARCHIVE;
      const fail = existsSync(marker) && readFileSync(marker, "utf8") === params.threadId;
      log({ method: message.method, threadId: params.threadId, failed: fail });
      if (fail) {
        unlinkSync(marker);
        return write({ id: message.id, error: { code: -32000, message: "Example close failure." } });
      }
      return result(message.method === "thread/unsubscribe" ? { status: "Unsubscribed" } : {});
    }
    case "thread/read": return result({ thread: { id: params.threadId, turns: [] } });
    case "thread/turns/list":
    case "thread/items/list": return result({ data: [], nextCursor: null });
    case "turn/start": {
      const threadId = params.threadId, turnId = "turn-" + process.pid + "-" + (++turns);
      const text = (params.input || []).map((item) => item.text || "").join("\\n");
      const category = text.includes("You keep the skills of the agent in this profile.") ? "writer"
        : text.includes("You keep the long-term memory of the agent in this profile.") ? "review" : "chat";
      log({ method: message.method, threadId, turnId, text, category });
      result({ turn: { id: turnId, status: "inProgress", items: [] } });
      setImmediate(() => {
        write({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
        if (category !== "chat" || text.includes("HOLD_ACTIVE")) held.set(turnId, { threadId });
        else finish(threadId, turnId, "Done.");
      });
      return;
    }
    case "turn/interrupt": {
      held.delete(params.turnId);
      log({ method: message.method, threadId: params.threadId, turnId: params.turnId });
      result({});
      return setImmediate(() => write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } }));
    }
    default: return write({ id: message.id, error: { code: -32601, message: "Unexpected stand-in method: " + message.method } });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method && message.id !== undefined) answer(message);
  }
});
process.stdin.on("end", () => { watcher.close(); process.exit(0); });
`;
await writeFile(executable, FAKE, { mode: 0o755 });

const unused = () => Effect.die(new Error("This check does not use the browser."));
const unshared: string[] = [];
const browser: AgentBrowserHost = {
  shareTab: () => {},
  unshareThread: (id) => {
    unshared.push(id);
  },
  agentTab: () => null,
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};
const database = new TommyDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, database);
let service: AgentService | null = null;
let reviewInterval = 1_000;
const library = new LocalSkillLibrary(join(scratch, "library"), () => service?.listAgents() ?? []);
const skills = new SkillMarketplaceService(
  () => service?.listAgents() ?? [],
  () => Effect.void,
  library,
);
const learning = new SkillLearningService({
  preferencePath: join(scratch, "learning.json"),
  skills,
  redact: (text) => text,
});
const cursors = new MemoryReviewCursors(join(scratch, "review-cursors.json"));
const agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  timezone: () => "UTC",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  clientFactory: (provider) => {
    assert.equal(provider, "codex");
    return new CodexAppServerClient(executable, 5_000);
  },
  memoryReviewInterval: () => reviewInterval,
  memoryReviewIdleMs: 3_600_000,
  memoryReviewCursors: cursors,
  skillLearning: () => learning.get().mode,
  skillLearner: learning.learner(),
  reviewSkills: (agentId) =>
    skills.listInstalled(agentId).pipe(
      Effect.map((installed) =>
        installed.map((skill) => ({ skillId: skill.skillId, name: skill.name, description: skill.description })),
      ),
      Effect.mapError((cause) => new SkillLearningFailed({ cause })),
    ),
});
service = agents;
const events: AgentEvent[] = [];
const changed = new Set<() => void>();
const signal = () => {
  for (const listener of [...changed]) listener();
};
agents.on("event", (event) => {
  events.push(event);
  signal();
});
const files = watch(scratch, signal);
interface ProviderLog {
  pid: number;
  method: string;
  threadId?: string;
  turnId?: string;
  text?: string;
  category?: string;
  failed?: boolean;
}
function logs(): ProviderLog[] {
  return readFileSync(providerLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line: string): ProviderLog => JSON.parse(line));
}
// Both provider log writes and service events re-check state. The timer is only a failure deadline.
function waitFor<T>(label: string, read: () => T | null | undefined | false): Promise<T> {
  return new Promise((resolveValue, reject) => {
    const deadline = setTimeout(() => finish(new Error(`Timed out waiting for ${label}.`)), 20_000);
    const finish = (error?: Error, value?: T) => {
      clearTimeout(deadline);
      changed.delete(check);
      if (error) reject(error);
      else if (value !== undefined) resolveValue(value);
    };
    const check = () => {
      try {
        const value = read();
        if (value !== false && value !== null && value !== undefined) finish(undefined, value);
      } catch (cause) {
        finish(cause instanceof Error ? cause : new Error(String(cause)));
      }
    };
    changed.add(check);
    check();
  });
}
async function settled(agent: AgentSummary): Promise<void> {
  await waitFor("the personal queue and turn to settle", () => {
    const threadId = store.list().find((entry) => entry.id === agent.id)?.threadId;
    return (
      threadId &&
      database.readActiveTurnId(agent.id, threadId) === null &&
      agents
        .listQueue(agent.id)
        .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status))
    );
  });
}
async function create(name: string): Promise<AgentSummary> {
  const agent = await runCauseEffect(
    agents.createAgent({
      provider: "codex",
      model: "gpt-6-luna",
      name,
      description: "An isolated deletion check.",
      avatarSeed: name.toLowerCase(),
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await settled(agent);
  return store.list().find((entry) => entry.id === agent.id) ?? agent;
}
const threadOf = (agent: AgentSummary): string => {
  const id = store.list().find((entry) => entry.id === agent.id)?.threadId;
  assert.ok(id);
  return id;
};
const snapshot = (agent: AgentSummary) => database.readConversation(agent.id, threadOf(agent));
const deletionEvents = (agent: AgentSummary) =>
  events
    .filter((event) => event.type === "conversation-messages-deleted")
    .filter((event) => event.agentId === agent.id);
function refusal(cause: unknown): boolean {
  if (cause instanceof MessageDeleteRefused) return cause.reason === "busy";
  return isDynamicRecord(cause) && "cause" in cause && refusal(cause.cause);
}
async function send(agent: AgentSummary, text: string): Promise<void> {
  await runCauseEffect(agents.sendMessage({ agentId: agent.id, text }));
  await settled(agent);
}
function append(agent: AgentSummary, message: ConversationMessage): void {
  const current = snapshot(agent);
  database.persistConversation({ ...current, messages: [...current.messages, message] }, "conversation-removal.check");
}
async function suggestion(agent: AgentSummary): Promise<string> {
  const id = randomUUID();
  append(agent, {
    id,
    author: "system",
    source: "system",
    status: "completed",
    createdAt: new Date().toISOString(),
    text: "Save this repeatable check as a skill?",
    itemType: skillSuggestionItemType({ action: "create" }),
    skillSuggestion: { name: "Reusable check" },
  });
  await runCauseEffect(agents.readConversation(agent.id));
  return id;
}
async function releaseOld(log: ProviderLog): Promise<void> {
  assert.ok(log.turnId);
  await writeFile(
    commandFile,
    JSON.stringify({
      nonce: randomUUID(),
      turnId: log.turnId,
      text: JSON.stringify({
        operations: [{ type: "add", text: "An obsolete private fact.", inclusion: "searchable" }],
        skill: { action: "create", name: "Obsolete lesson", message: "Save the old lesson?" },
        description: "An obsolete lesson.",
        instructions: "Use the obsolete transcript.",
      }),
    }),
  );
}
const report: { passed: boolean; checks: string[]; error?: string } = { passed: false, checks: [] };
const checked = (name: string) => {
  report.checks.push(name);
};
try {
  await runCauseEffect(learning.load());
  await runCauseEffect(agents.initialize());
  const agent = await create("Example");
  const oldAssistant = snapshot(agent).messages.find(
    (message) => message.author === "assistant" && message.status === "completed",
  );
  assert.ok(oldAssistant);
  const keptCursor = snapshot(agent).messages.find((message) => message.author === "user");
  assert.ok(keptCursor);
  await runCauseEffect(cursors.set(agent.id, null, keptCursor.id));
  const activeReceipt = await runCauseEffect(agents.sendMessage({ agentId: agent.id, text: "HOLD_ACTIVE" }));
  const active = await waitFor("the held personal turn", () => {
    const current = snapshot(agent);
    return current.activeTurnId ? logs().find((entry) => entry.turnId === current.activeTurnId) : undefined;
  });
  await runCauseEffect(
    agents.deleteMessage({ agentId: agent.id, messageId: oldAssistant.id, requestId: "old-message" }),
  );
  assert.ok(!snapshot(agent).messages.some((message) => message.id === oldAssistant.id));
  assert.equal(cursors.get(agent.id, null), keptCursor.id);
  assert.ok(
    !(await runCauseEffect(agents.readConversation(agent.id))).messages.some(
      (message) => message.id === oldAssistant.id,
    ),
  );
  assert.ok(deletionEvents(agent).some((event) => event.messageIds.includes(oldAssistant.id)));
  await assert.rejects(
    runCauseEffect(agents.deleteAgentHistory({ agentId: agent.id, requestId: "busy-history" })),
    refusal,
  );
  const activeMessage = activeReceipt.deliveries[0]?.id;
  assert.ok(activeMessage);
  await assert.rejects(
    runCauseEffect(agents.deleteMessage({ agentId: agent.id, messageId: activeMessage, requestId: "busy-current" })),
    refusal,
  );
  const queued = await runCauseEffect(agents.sendMessage({ agentId: agent.id, text: "Queued after Stop." }));
  const queuedId = queued.deliveries[0]?.id;
  assert.ok(queuedId);
  await assert.rejects(
    runCauseEffect(agents.deleteMessage({ agentId: agent.id, messageId: queuedId, requestId: "busy-queued" })),
    refusal,
  );
  assert.ok(active.turnId);
  await runCauseEffect(agents.interrupt(agent.id, active.turnId));
  await settled(agent);
  assert.ok(logs().some((entry) => entry.method === "turn/interrupt" && entry.turnId === active.turnId));
  checked(
    "An old message can be deleted during another turn. Current, queued and busy history deletions refuse. Stop releases the queue.",
  );

  const other = await create("Other");
  const attachment = await runCauseEffect(
    mailbox.stageGeneratedBytes({
      bytes: new TextEncoder().encode("A shared check file."),
      name: "shared.txt",
      mimeType: "text/plain",
      ownerAgentId: agent.id,
      ownerThreadId: threadOf(agent),
    }),
  );
  const attachmentMessage: ConversationMessage = {
    id: randomUUID(),
    author: "assistant",
    source: "assistant",
    status: "completed",
    createdAt: new Date().toISOString(),
    text: "A shared result.",
    attachments: [attachment],
  };
  const current = snapshot(agent);
  mailbox.persistGeneratedAttachmentsWithConversation(
    { ...current, messages: [...current.messages, attachmentMessage] },
    "conversation-removal.shared-file",
    {},
    [attachment.id],
  );
  append(other, { ...attachmentMessage, id: randomUUID() });
  await runCauseEffect(agents.readConversation(agent.id));
  const oldSession = database.activeProviderSession(threadOf(agent), "codex");
  assert.ok(oldSession);
  await writeFile(failRelease, oldSession.externalSessionId);
  await writeFile(failArchive, oldSession.externalSessionId);
  // This scratch trigger fails the real post-commit mailbox write, after the transcript and its
  // receipt are durable. It does not alter a production migration or bypass a service adapter.
  database.connection.exec(
    "CREATE TRIGGER example_cleanup_failure BEFORE DELETE ON projection_deliveries BEGIN SELECT RAISE(ABORT, 'Example cleanup failure.'); END",
  );
  const historyInput = { agentId: agent.id, requestId: "history-with-failed-cleanup" };
  const loadedOldPage = snapshot(agent).messages;
  await assert.rejects(runCauseEffect(agents.deleteAgentHistory(historyInput)));
  database.connection.exec("DROP TRIGGER example_cleanup_failure");
  const receipt = database.threadHistoryDeletionReceipt(threadOf(agent), historyInput.requestId);
  assert.ok(receipt && receipt.messageIds.length > 0);
  assert.ok(receipt.externalSessionIds.includes(oldSession.externalSessionId));
  assert.ok(!database.activeProviderSession(threadOf(agent), "codex"));
  assert.ok(
    logs().some(
      (entry) =>
        entry.method === "thread/unsubscribe" && entry.threadId === oldSession.externalSessionId && entry.failed,
    ),
  );
  assert.ok(
    logs().some(
      (entry) => entry.method === "thread/archive" && entry.threadId === oldSession.externalSessionId && entry.failed,
    ),
  );
  assert.ok(unshared.includes(threadOf(agent)));
  const latePage = new Map(loadedOldPage.map((message) => [message.id, message]));
  await send(agent, "NEW_AFTER_HISTORY");
  const newSession = database.activeProviderSession(threadOf(agent), "codex");
  assert.ok(newSession && newSession.externalSessionId !== oldSession.externalSessionId);
  const newMessages = snapshot(agent).messages;
  assert.ok(newMessages.some((message) => message.text === "NEW_AFTER_HISTORY"));
  for (const message of newMessages) latePage.set(message.id, message);
  const beforeRetry = logs().length;
  await runCauseEffect(agents.deleteAgentHistory(historyInput));
  assert.equal(
    database.activeProviderSession(threadOf(agent), "codex")?.externalSessionId,
    newSession.externalSessionId,
  );
  const retryCalls = logs().slice(beforeRetry);
  for (const method of ["thread/unsubscribe", "thread/archive"]) {
    assert.ok(
      retryCalls.some(
        (entry) => entry.method === method && entry.threadId === oldSession.externalSessionId && !entry.failed,
      ),
    );
    assert.ok(!retryCalls.some((entry) => entry.method === method && entry.threadId === newSession.externalSessionId));
  }
  assert.deepEqual(
    snapshot(agent).messages.map((message) => message.id),
    newMessages.map((message) => message.id),
  );
  for (const event of deletionEvents(agent)) {
    assert.ok(event.messageIds.length <= 500);
    for (const id of event.messageIds) latePage.delete(id);
  }
  assert.ok(newMessages.every((message) => latePage.has(message.id)));
  assert.ok(receipt.messageIds.every((id) => !latePage.has(id)));
  assert.ok(
    (await runCauseEffect(agents.readConversation(agent.id))).messages.every(
      (message) => !receipt.messageIds.includes(message.id),
    ),
  );
  const storedFile = await runCauseEffect(mailbox.resolveAttachment(attachment.id));
  assert.ok(storedFile);
  assert.equal(await readFile(storedFile.path, "utf8"), "A shared check file.");
  assert.ok(snapshot(other).messages.some((message) => message.attachments?.some((file) => file.id === attachment.id)));
  checked(
    "A failed cleanup retries only durable old IDs. Old sessions close and unbind; a new session and its messages survive. Exact-ID events preserve late pages and shared files.",
  );

  const saveId = await suggestion(agent);
  const beforeWriter = logs().length;
  const save = runCauseEffect(agents.saveSkillSuggestion({ agentId: agent.id, messageId: saveId }));
  const writer = await waitFor("a pending skill writer", () =>
    logs()
      .slice(beforeWriter)
      .find((entry) => entry.category === "writer"),
  );
  await runCauseEffect(agents.deleteAgentHistory({ agentId: agent.id, requestId: "cancel-save" }));
  assert.equal(await save, false);
  await waitFor("the cancelled writer process to exit", () =>
    logs().some((entry) => entry.method === "process-exit" && entry.pid === writer.pid),
  );
  await releaseOld(writer);
  assert.equal((await runCauseEffect(library.list())).length, 0);
  assert.equal(snapshot(agent).messages.length, 0);
  assert.equal(cursors.get(agent.id, null), null);
  checked(
    "History deletion cancels a Save that already captured the old transcript, without publishing a skill or restoring its card.",
  );

  reviewInterval = 1;
  const beforeReview = logs().length;
  await send(agent, "Remember this only if the conversation remains.");
  const review = await waitFor("a pending background memory review", () =>
    logs()
      .slice(beforeReview)
      .find((entry) => entry.category === "review"),
  );
  reviewInterval = 1_000;
  await runCauseEffect(agents.deleteAgentHistory({ agentId: agent.id, requestId: "cancel-review" }));
  await waitFor("the cancelled review process to exit", () =>
    logs().some((entry) => entry.method === "process-exit" && entry.pid === review.pid),
  );
  await releaseOld(review);
  assert.equal(snapshot(agent).messages.length, 0);
  assert.equal(cursors.get(agent.id, null), null);
  assert.equal(agents.listMemories(agent.id).length, 0);
  assert.equal((await runCauseEffect(library.list())).length, 0);
  checked(
    "History deletion cancels an in-flight background review and its cursor before a late answer can recreate old content.",
  );

  await send(agent, "Keep this chat except for its old reply.");
  const singleId = await suggestion(agent);
  const beforeSingleWriter = logs().length;
  const singleSave = runCauseEffect(agents.saveSkillSuggestion({ agentId: agent.id, messageId: singleId }));
  const singleWriter = await waitFor("a writer before single-message deletion", () =>
    logs()
      .slice(beforeSingleWriter)
      .find((entry) => entry.category === "writer"),
  );
  const reply = snapshot(agent).messages.find((message) => message.author === "assistant");
  assert.ok(reply);
  await runCauseEffect(
    agents.deleteMessage({ agentId: agent.id, messageId: reply.id, requestId: "cancel-single-save" }),
  );
  assert.equal(await singleSave, false);
  await waitFor("the single-delete writer to exit", () =>
    logs().some((entry) => entry.method === "process-exit" && entry.pid === singleWriter.pid),
  );
  assert.ok(snapshot(agent).messages.some((message) => message.id === singleId));
  assert.equal((await runCauseEffect(library.list())).length, 0);
  checked("Single-message deletion cancels a writer that captured that transcript and keeps the remaining messages.");
  const ownFile = await runCauseEffect(
    mailbox.stageGeneratedBytes({
      bytes: new TextEncoder().encode("An unshared result."),
      name: "unshared.txt",
      mimeType: "text/plain",
      ownerAgentId: agent.id,
      ownerThreadId: threadOf(agent),
    }),
  );
  const ownFileMessage: ConversationMessage = {
    id: randomUUID(),
    author: "assistant",
    source: "assistant",
    status: "completed",
    createdAt: new Date().toISOString(),
    text: "An unshared file.",
    attachments: [ownFile],
  };
  mailbox.persistGeneratedAttachmentsWithConversation(
    { ...snapshot(agent), messages: [...snapshot(agent).messages, ownFileMessage] },
    "conversation-removal.unshared-file",
    {},
    [ownFile.id],
  );
  const ownFileSource = await runCauseEffect(mailbox.resolveAttachment(ownFile.id));
  assert.ok(ownFileSource);
  await runCauseEffect(
    agents.deleteMessage({ agentId: agent.id, messageId: ownFileMessage.id, requestId: "unshared-file-delete" }),
  );
  assert.equal(await runCauseEffect(mailbox.resolveAttachment(ownFile.id)), null);
  await assert.rejects(readFile(ownFileSource.path), { code: "ENOENT" });
  checked("Generated file cleanup removes an unshared file and retains the other thread's shared file.");

  const channelId = randomUUID();
  const person = { id: "local", name: "Example" };
  await runCauseEffect(
    agents.channels.command(
      {
        type: "save",
        operationId: randomUUID(),
        channelId,
        draft: {
          name: "Private channel",
          title: "",
          instructions: "Keep channel setup",
          members: [{ agentId: agent.id }],
          leadAgentId: agent.id,
        },
      },
      person,
    ),
  );
  const sendChannel = async (text: string) => {
    await runCauseEffect(
      agents.channels.command(
        {
          type: "send",
          operationId: randomUUID(),
          channelId,
          text,
          recipientAgentId: agent.id,
          replyToMessageId: null,
          attachmentDraftIds: [],
        },
        person,
      ),
    );
    await waitFor(
      "the channel work to finish",
      () =>
        agents.channels.store.tasks(channelId).every((task) => ["completed", "cancelled"].includes(task.state)) &&
        mailbox.channelLanes(agent.id).length === 0,
    );
  };
  await sendChannel("An old private channel request.");
  const oldAssignment = agents.channels.store.assignments(channelId)[0];
  assert.ok(oldAssignment?.deliveryId);
  assert.ok(mailbox.getDelivery(oldAssignment.deliveryId));
  const context = agents.channels.store.contexts(channelId)[0];
  assert.ok(context);
  const channelTurn = database.connection
    .prepare("SELECT turn_id FROM projection_turns WHERE thread_id = ? LIMIT 1")
    .get(context.threadId);
  assert.ok(channelTurn && typeof channelTurn.turn_id === "string");
  database.connection
    .prepare("UPDATE projection_turns SET status = 'running' WHERE turn_id = ?")
    .run(channelTurn.turn_id);
  const beforeRefusedArchive = logs().filter((entry) => entry.method === "thread/archive").length;
  await assert.rejects(
    runCauseEffect(agents.deleteChannelHistory({ channelId, requestId: "stale-channel-turn" })),
    refusal,
  );
  assert.equal(logs().filter((entry) => entry.method === "thread/archive").length, beforeRefusedArchive);
  database.connection
    .prepare("UPDATE projection_turns SET status = 'completed' WHERE turn_id = ?")
    .run(channelTurn.turn_id);
  const stopped = agents.channels.store.tasks(channelId)[0];
  assert.ok(stopped);
  agents.channels.store.update(agents.channels.store.get(channelId), {
    tasks: [{ ...stopped, state: "paused", error: "Old private error." }],
  });
  const channelInput = { channelId, requestId: "channel-history-with-failed-cleanup" };
  database.connection.exec(
    "CREATE TRIGGER example_channel_cleanup_failure BEFORE DELETE ON projection_deliveries BEGIN SELECT RAISE(ABORT, 'Example channel cleanup failure.'); END",
  );
  await assert.rejects(runCauseEffect(agents.deleteChannelHistory(channelInput)));
  database.connection.exec("DROP TRIGGER example_channel_cleanup_failure");
  assert.equal(agents.channels.store.page(channelId).messages.length, 0);
  assert.equal(agents.channels.store.tasks(channelId)[0]?.instruction, "");
  assert.equal(agents.channels.store.tasks(channelId)[0]?.state, "cancelled");
  assert.ok(mailbox.getDelivery(oldAssignment.deliveryId));
  await sendChannel("A new private channel request.");
  const newAssignments = agents.channels.store
    .assignments(channelId)
    .filter((assignment) => assignment.id !== oldAssignment.id);
  assert.ok(newAssignments.length > 0);
  await runCauseEffect(agents.deleteChannelHistory(channelInput));
  assert.equal(mailbox.getDelivery(oldAssignment.deliveryId), null);
  for (const assignment of newAssignments) {
    assert.ok(assignment.deliveryId);
    assert.ok(mailbox.getDelivery(assignment.deliveryId));
  }
  assert.ok(
    agents.channels.store
      .page(channelId)
      .messages.some((entry) => entry.message.text === "A new private channel request."),
  );
  checked(
    "Channel history clears stopped requests and old assignment copies. A stale running row refuses before archiving; failed cleanup retries preserve later channel work.",
  );
  report.passed = true;
} catch (cause) {
  report.error = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
  process.exitCode = 1;
} finally {
  try {
    await runCauseEffect(agents.stop());
  } catch (cause) {
    report.passed = false;
    report.error ??= String(cause);
    process.exitCode = 1;
  }
  files.close();
  database.close();
  if (previousCli === undefined) delete process.env.TOMMY_CODEX_PATH;
  else process.env.TOMMY_CODEX_PATH = previousCli;
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  await rm(scratch, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
