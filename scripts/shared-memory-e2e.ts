// Runs the real AgentStore, SQLite, ConversationRuntime and AgentMemories in a scratch profile, with
// no provider: it makes the tool calls that an agent makes, and reads what the next prompt gets.
// It reads no account, user database or provider home.
// Run: bun scripts/shared-memory-e2e.ts
// Artifact: .tommy-build/shared-memory-e2e/report.json
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SHARED_MEMORY_CONTEXT_BUDGET_BYTES, SHARED_MEMORY_OWNER_ID } from "@tommy/contracts/agent-memory-context";
import type { AgentEvent, AgentSummary } from "@tommy/contracts/ipc";
import { Schema } from "effect";
import { AgentMemories } from "../src/backend/agent/agent-memories";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { memoryContext, memoryContextUpdate } from "../src/backend/agent/developer-instructions";
import { MemoryReviewResult, memoryReviewPrompt } from "../src/backend/agent/memory-review-prompt";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { TommyDatabase } from "../src/backend/tommy-database";

const OUT = resolve(import.meta.dirname, "../.tommy-build/shared-memory-e2e");
const scratch = await mkdtemp(join(tmpdir(), "tommy-shared-memory-"));
const userData = join(scratch, "user-data");
const home = join(scratch, "profile-home");
await mkdir(home, { recursive: true });

const database = new TommyDatabase(userData);
const store = new AgentStore(userData, home, database);
const events: AgentEvent[] = [];
const emit = (event: AgentEvent) => void events.push(event);
const conversation = new ConversationRuntime(store, emit, () => store.list());
const memories = new AgentMemories({
  store,
  conversation,
  emit,
  emitError: (code, error) => {
    throw new Error(`${code}: ${String(error)}`);
  },
});
const checks: { name: string; passed: true }[] = [];
const check = (name: string, run: () => void) => {
  run();
  checks.push({ name, passed: true });
};

let calls = 0;
/** One memory tool call of an agent, as the tool router passes it on. */
function call(agent: AgentSummary, turnId: string, tool: string, args: unknown) {
  calls += 1;
  const response = memories.handleTool(
    { threadId: "", turnId, callId: `call-${calls}`, namespace: "tommy", tool, arguments: args },
    agent.id,
  );
  assert.ok(response, `${tool} is a memory tool`);
  return { success: response.success, value: JSON.parse(response.contentItems[0]?.text ?? "null") };
}
/** What the next prompt of the agent states, as the thread start builds it. */
const prompt = (agent: AgentSummary) =>
  memoryContext(memories.essentialFor(agent.id), {
    storedMemoryCount: memories.listFor(agent.id).length,
    sharedMemories: memories.sharedEssential(),
  });

try {
  await runCauseEffect(store.initialize());
  const create = (name: string, description: string) =>
    runCauseEffect(store.createAgent({ name, description, avatarSeed: name.toLowerCase(), avatarHue: null }));
  const planner = await create("Planner", "Plans travel.");
  const writer = await create("Writer", "Writes posts.");

  check("an agent saves a shared memory, and the change shows in its own turn", () => {
    const staged = call(planner, "turn-1", "remember", {
      text: "The user lives in Seoul and writes in Korean.",
      scope: "shared",
      inclusion: "essential",
    });
    assert.deepEqual(staged, {
      success: true,
      value: { status: "staged", memoryId: null, inclusion: "essential", scope: "shared" },
    });
    call(planner, "turn-1", "remember", { text: "The trip to Busan is on 2027-03-02." });
    assert.equal(memories.listShared().length, 0, "nothing commits before the turn completes");
    const changes = memories.finishTurn("turn-1", "completed");
    assert.deepEqual([...changes.keys()], [planner.id]);
    assert.deepEqual(
      changes.get(planner.id)?.map((change) => change.action),
      ["saved", "saved"],
    );
    assert.deepEqual(
      memories.listShared().map((memory) => memory.text),
      ["The user lives in Seoul and writes in Korean."],
    );
    assert.deepEqual(
      memories.listFor(planner.id).map((memory) => memory.text),
      ["The trip to Busan is on 2027-03-02."],
    );
  });

  check("a shared change reloads every agent, and an own change only its agent", () => {
    const reloaded = events.filter((event) => event.type === "memories-changed").map((event) => event.agentId);
    assert.deepEqual([...new Set(reloaded)].sort(), [planner.id, writer.id].sort());
    assert.equal(reloaded.filter((id) => id === writer.id).length, 1);
  });

  check("the prompt of another agent has the shared memory and not the first agent's own", () => {
    const context = prompt(writer);
    assert.deepEqual(
      context.memories.map(({ text, scope }) => ({ text, scope })),
      [{ text: "The user lives in Seoul and writes in Korean.", scope: "shared" }],
    );
    assert.equal(context.storedCount, 0);
    const block = memoryContextUpdate(null, context) ?? "";
    assert.match(block, /"scope":"shared"/u);
    assert.match(block, /You have 0 saved memories; 0 additional entries/u);
  });

  check("search finds a shared memory for another agent, and never another agent's own", () => {
    const found = call(writer, "turn-2", "search_memories", { query: "Seoul" });
    assert.equal(found.value.memories.length, 1);
    assert.equal(found.value.memories[0].scope, "shared");
    const other = call(writer, "turn-2", "search_memories", { query: "Busan" });
    assert.equal(other.value.memories.length, 0);
    const listed = call(writer, "turn-2", "list_memories", { scope: "shared" });
    assert.equal(listed.value.memories.length, 1);
    assert.equal(call(writer, "turn-2", "list_memories", {}).value.memories.length, 0);
  });

  check("a Korean word finds a memory that has it with another particle", () => {
    call(writer, "turn-ko", "remember", { text: "주간 회의를 매주 월요일 오전에 한다." });
    call(writer, "turn-ko", "remember", { text: "월간 보고 회의 자료는 공유 폴더에 둔다." });
    memories.finishTurn("turn-ko", "completed");
    const texts = (query: string) =>
      call(writer, "turn-ko-2", "search_memories", { query }).value.memories.map(
        (memory: { text: string }) => memory.text,
      );
    assert.equal(texts("회의").length, 2);
    assert.equal(texts("회의에서").length, 2);
    assert.equal(texts("월요일에").length, 1);
    assert.equal(texts("출장").length, 0);
    for (const memory of memories.listFor(writer.id))
      call(writer, "turn-ko-3", "forget_memory", { memoryId: memory.id });
    memories.finishTurn("turn-ko-3", "completed");
    assert.equal(memories.listFor(writer.id).length, 0);
  });

  check("another agent corrects a shared memory by its id, and cannot change an own one", () => {
    const sharedId = memories.listShared()[0]?.id ?? "";
    const ownId = memories.listFor(planner.id)[0]?.id ?? "";
    const before = prompt(planner);
    assert.equal(call(writer, "turn-3", "remember", { memoryId: ownId, text: "Changed." }).success, false);
    assert.equal(call(writer, "turn-3", "forget_memory", { memoryId: ownId }).success, false);
    assert.equal(call(writer, "turn-3", "remember", { memoryId: sharedId, text: "x", scope: "own" }).success, false);
    const staged = call(writer, "turn-3", "remember", {
      memoryId: sharedId,
      text: "The user lives in Busan and writes in Korean.",
    });
    assert.equal(staged.value.scope, "shared");
    const changes = memories.finishTurn("turn-3", "completed").get(writer.id) ?? [];
    assert.deepEqual(
      changes.map((change) => change.action),
      ["updated"],
    );
    assert.equal(memories.listShared()[0]?.text, "The user lives in Busan and writes in Korean.");
    assert.equal(memories.listFor(planner.id)[0]?.text, "The trip to Busan is on 2027-03-02.");
    const update = memoryContextUpdate(before, prompt(planner)) ?? "";
    assert.match(update, /lives in Busan/u);
  });

  check("a turn that does not complete leaves the shared memories as they were", () => {
    call(writer, "turn-4", "remember", { text: "Not kept.", scope: "shared" });
    assert.equal(memories.finishTurn("turn-4", "failed").size, 0);
    assert.equal(memories.listShared().length, 1);
  });

  check("a shared memory that only search finds reloads no agent", () => {
    const before = events.length;
    call(writer, "turn-5", "remember", { text: "The user's bank is Example Bank.", scope: "shared" });
    memories.finishTurn("turn-5", "completed");
    assert.equal(memories.listShared().length, 2);
    assert.equal(events.slice(before).filter((event) => event.type === "memories-changed").length, 0);
    assert.equal(prompt(planner).memories.filter((memory) => memory.scope === "shared").length, 1);
  });

  check("the essential shared memories stay in their own, smaller budget", () => {
    const text = (index: number) => `Fact ${index}: ${"x".repeat(480)}`;
    let essential = 0;
    for (let index = 0; index < 12; index += 1) {
      const staged = call(planner, "turn-6", "remember", {
        text: text(index),
        scope: "shared",
        inclusion: "essential",
      });
      if (staged.value.inclusion === "essential") essential += 1;
    }
    memories.finishTurn("turn-6", "completed");
    const bytes = new TextEncoder().encode(JSON.stringify(memories.sharedEssential())).byteLength;
    assert.ok(essential > 0 && essential < 12, `${essential} of 12 fit`);
    assert.ok(memories.sharedEssential().length === essential + 1);
    assert.ok(bytes > 0 && memories.reviewBase(planner.id).shared.essentialBytes <= SHARED_MEMORY_CONTEXT_BUDGET_BYTES);
    // The agent's own budget is the larger one, and the shared memories take none of it.
    const own = call(planner, "turn-7", "remember", { text: text(99), inclusion: "essential" });
    assert.equal(own.value.inclusion, "essential");
    memories.finishTurn("turn-7", "completed");
  });

  check("a review reads the shared memories, and its shared changes go to them", () => {
    const base = memories.reviewBase(writer.id);
    assert.equal(base.memories.length, 0);
    assert.equal(base.shared.memories.length, memories.listShared().length);
    const reviewPrompt = memoryReviewPrompt(writer, base, []);
    assert.match(reviewPrompt, /<shared_memories>/u);
    assert.match(reviewPrompt, /"scope":"own"\|"shared"/u);
    const bank = base.shared.memories.find((entry) => entry.memory.text.includes("Example Bank"))?.memory.id ?? "";
    const result = Schema.decodeUnknownSync(MemoryReviewResult)({
      operations: [
        {
          type: "add",
          text: "The user wants short answers from every agent.",
          inclusion: "searchable",
          scope: "shared",
        },
        { type: "add", text: "Posts go out on Mondays.", inclusion: "searchable" },
        // A fact that every agent has needs no copy of the agent's own.
        { type: "add", text: "The user lives in Busan and writes in Korean.", inclusion: "searchable" },
        { type: "forget", memoryId: bank },
      ],
    });
    const changes = memories.applyReview(writer.id, base, result.operations, "review-1");
    assert.deepEqual(changes.map((change) => change.action).sort(), ["forgotten", "saved", "saved"]);
    assert.deepEqual(
      memories.listFor(writer.id).map((memory) => memory.text),
      ["Posts go out on Mondays."],
    );
    const shared = memories.listShared().map((memory) => memory.text);
    assert.ok(shared.includes("The user wants short answers from every agent."));
    assert.ok(!shared.some((text) => text.includes("Example Bank")));
  });

  check("a removed agent takes its own memories, and the shared ones stay", () => {
    const shared = memories.listShared().length;
    database.hardDeleteAgent("shared-memory-e2e:delete", planner.id, null, [writer]);
    assert.equal(memories.listFor(planner.id).length, 0);
    assert.equal(memories.listShared().length, shared);
    assert.equal(memories.listFor(SHARED_MEMORY_OWNER_ID).length, shared);
  });

  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), JSON.stringify({ passed: true, checks }, null, 2));
  process.stdout.write(`shared-memory-e2e: ${checks.length} checks passed\n`);
} finally {
  database.close();
  await rm(scratch, { recursive: true, force: true });
}
