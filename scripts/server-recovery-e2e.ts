// Run with bun scripts/server-recovery-e2e.ts. All database and workspace files are temporary.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sourceText } from "@tommy/i18n/source";
import { Effect } from "effect";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { SidebarLayoutStore } from "../src/backend/sidebar-layout-store";
import { TommyDatabase } from "../src/backend/tommy-database";
import { AgentInitializationGate } from "../src/main/agent-initialization";
import { TeardownRegistry } from "../src/main/teardown-registry";
import { TelegramCommands } from "../src/main/telegram-commands";

async function startup() {
  // The second start arrives while the first is waiting. Both see the same failure.
  let attempts = 0;
  const entered = Promise.withResolvers<void>();
  const fail = Promise.withResolvers<void>();
  const retry = new AgentInitializationGate(() =>
    Effect.gen(function* () {
      attempts++;
      if (attempts === 1) {
        entered.resolve();
        yield* Effect.promise(() => fail.promise);
        return yield* Effect.fail("fixture failure");
      }
    }),
  );
  assert.equal(retry.succeeded, false);
  const initial = Effect.runPromise(Effect.result(retry.start()));
  await entered.promise;
  const joined = Effect.runPromise(Effect.result(retry.start()));
  fail.resolve();
  assert.deepEqual(await joined, await initial);
  assert.equal((await initial)._tag, "Failure");
  assert.equal(attempts, 1);
  assert.equal(retry.succeeded, false);
  await Effect.runPromise(retry.start());
  await Effect.runPromise(retry.start());
  assert.equal(retry.succeeded, true);
  assert.equal(attempts, 2);

  // Shutdown joins initialization before the registry closes the database.
  const events: string[] = [];
  const writing = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  const gate = new AgentInitializationGate(() =>
    Effect.gen(function* () {
      events.push("begin");
      writing.resolve();
      yield* Effect.promise(() => commit.promise);
      events.push("commit");
    }),
  );
  const teardown = new TeardownRegistry({
    reportError: (_name, error) => {
      throw error;
    },
  });
  teardown.push(1, "the database", () => {
    events.push("close");
  });
  const initializing = Effect.runPromise(gate.start());
  await writing.promise;
  const stopping = Effect.runPromise(gate.stop()).then(() => teardown.runAll());
  await Effect.runPromise(Effect.yieldNow);
  assert.deepEqual(events, ["begin"]);
  commit.resolve();
  await Promise.all([initializing, stopping]);
  assert.deepEqual(events, ["begin", "commit", "close"]);
  assert.equal(gate.succeeded, false);
  await Effect.runPromise(gate.start());
  await Effect.runPromise(gate.stop());
  assert.deepEqual(events, ["begin", "commit", "close"]);

  const early = new AgentInitializationGate(() => Effect.die("The stopped host tried to initialize."));
  await Effect.runPromise(early.stop());
  await Effect.runPromise(early.start());
  assert.equal(early.succeeded, false);
}

async function storedRecovery(root: string) {
  const data = join(root, "data");
  const home = join(root, "home");
  let db = new TommyDatabase(data);
  let store = new AgentStore(data, home, db);
  const markers = join(data, "agent-duplications");
  try {
    await runCauseEffect(store.initialize());
    const make = (name: string) =>
      runCauseEffect(
        store.createAgent({
          name,
          description: name,
          avatarSeed: name,
          avatarHue: null,
        }),
      );
    const source = await make("source");
    const committed = await make("committed");
    const pending = await make("pending");
    const sidebar = new SidebarLayoutStore(join(data, "sidebar.json"));
    const commitId = randomUUID();
    const sourceBotId = source.id.replace(/^agent-/, "bot-");
    const oldId = (id: string) => id.replace(/^agent-/, "bot-");
    const receipt = { sourceBotId: source.id, result: { bot: committed, layout: sidebar.getSnapshot() } };
    db.dispatch(
      `agent-duplication:${commitId}`,
      [
        {
          aggregateType: "agent-duplications",
          aggregateId: committed.id,
          eventType: "agent-duplication.committed",
          payload: { sourceBotId: source.id, duplicateBotId: committed.id },
        },
      ],
      () => receipt,
    );
    const commitMarker = join(markers, `${oldId(committed.id)}.pending`);
    const partialMarker = join(markers, `${oldId(pending.id)}.pending`);
    await writeFile(commitMarker, JSON.stringify({ operationId: commitId, sourceBotId }));
    await writeFile(partialMarker, JSON.stringify({ operationId: randomUUID(), sourceBotId }));
    const stagedCopy = join(home, "Tommy", "Bots", `${oldId(pending.id)}.tommy-stage`);
    await mkdir(stagedCopy, { recursive: true });
    await writeFile(join(committed.workspacePath, "owner.txt"), "keep this copy");
    await writeFile(join(source.workspacePath, "owner.txt"), "keep source");
    const threadId = store.ensureThreadIdNow(committed.id);
    const turnId = randomUUID();
    db.persistConversation(
      {
        agentId: committed.id,
        threadId,
        activeTurnId: turnId,
        revision: 0,
        messages: [],
      },
      "conversation.updated",
    );
    db.close();
    db = new TommyDatabase(data);
    store = new AgentStore(data, home, db);
    await runCauseEffect(store.initialize());
    assert.ok(store.list().some((agent) => agent.id === committed.id));
    assert.ok(!store.list().some((agent) => agent.id === pending.id));
    assert.equal(await readFile(join(committed.workspacePath, "owner.txt"), "utf8"), "keep this copy");
    assert.equal(await readFile(join(source.workspacePath, "owner.txt"), "utf8"), "keep source");
    for (const removed of [partialMarker, commitMarker, pending.workspacePath, stagedCopy])
      assert.equal(existsSync(removed), false);
    assert.deepEqual(db.commandResult(`agent-duplication:${commitId}`), receipt);
    assert.equal(store.committedAgentDuplication(commitId, source.id)?.agent.id, committed.id);

    // The receipt remains authoritative if the disk marker was damaged or misplaced.
    const conflictingMarkers = [
      { path: commitMarker, contents: '{"operationId":' },
      {
        path: join(markers, `${oldId(source.id)}.pending`),
        contents: JSON.stringify({ operationId: commitId, sourceBotId }),
      },
      { path: commitMarker, contents: JSON.stringify({ operationId: randomUUID(), sourceBotId }) },
      {
        path: join(markers, `${oldId(source.id)}.pending`),
        contents: JSON.stringify({ operationId: randomUUID(), sourceBotId }),
      },
    ];
    for (const marker of conflictingMarkers) {
      await writeFile(marker.path, marker.contents);
      db.close();
      db = new TommyDatabase(data);
      store = new AgentStore(data, home, db);
      await runCauseEffect(store.initialize());
      assert.equal(await readFile(join(committed.workspacePath, "owner.txt"), "utf8"), "keep this copy");
      assert.equal(await readFile(join(source.workspacePath, "owner.txt"), "utf8"), "keep source");
      assert.ok(store.list().some((agent) => agent.id === committed.id));
      assert.deepEqual(db.commandResult(`agent-duplication:${commitId}`), receipt);
    }

    const mailbox = new MailboxStore(data, store.sharedRoot, db);
    await runCauseEffect(mailbox.initialize());
    const unused = () => Effect.die("The cold turn needs no browser operation.");
    const service = new AgentService({
      store,
      mailbox,
      browser: {
        shareTab: () => {},
        unshareThread: () => {},
        agentTab: () => null,
        listTabs: () => [],
        resolveUploadTarget: unused,
        handleDynamicTool: unused,
        onChanged: () => () => {},
        onDocumentChanged: () => () => {},
        clearControls: () => {},
        endControl: () => {},
        close: () => Effect.void,
        clearAgentSession: () => Effect.void,
      },
    });
    try {
      // No provider starts and no conversation is loaded in this new host.
      const commands = new TelegramCommands({ service, dataRoot: data });
      const status = () =>
        runCauseEffect(
          commands.handle(committed.id, "/status", sourceText, {
            timeZone: "UTC",
            language: "en",
            isRoot: false,
          }),
        );
      assert.equal(service.activeTurnId(committed.id), turnId);
      assert.ok((await status())?.html.includes(sourceText("status.messaging.telegramStateWorking")));
      await runCauseEffect(service.interrupt(committed.id, turnId));
      assert.equal(db.readActiveTurnId(committed.id, threadId), null);
      assert.ok((await status())?.html.includes(sourceText("status.messaging.telegramStateIdle")));
    } finally {
      await runCauseEffect(service.stop());
    }
  } finally {
    db.close();
  }
}

const out = resolve(import.meta.dirname, "../.tommy-build/server-recovery-e2e");
const scratch = await mkdtemp(join(tmpdir(), "tommy-server-recovery-"));
const checks: string[] = [];
let passed = false;
try {
  await storedRecovery(scratch);
  checks.push(
    "released marker and receipt recovery",
    "damaged and mismatched markers preserve committed work",
    "cold SQLite turn status and stop",
  );
  await startup();
  checks.push("joined startup failure and retry", "shutdown waits for startup and closes permanently");
  passed = true;
} finally {
  await rm(scratch, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), `${JSON.stringify({ passed, checks }, null, 2)}\n`);
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${join(out, "report.json")}\n`);
}
