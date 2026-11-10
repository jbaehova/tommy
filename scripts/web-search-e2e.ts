// Drives the production web search controller, disposable Codex process adapter and SQLite usage
// store in a scratch profile. Only the provider process is a local JSON-RPC stand-in. No network,
// account, running app or real user database is used. Root runs this check serially.
// Run: bun scripts/web-search-e2e.ts
// Artifact: .tommy-build/web-search-e2e/report.json
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentModelOption, AgentSummary } from "@tommy/contracts/ipc";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { codexPromptSettings } from "../src/backend/agent/codex-prompt-settings";
import { ProfileClients } from "../src/backend/agent/profile-clients";
import { discoverTools, resolveDeferredTool, visibleDynamicTools } from "../src/backend/agent/tool-catalog";
import { sideSessionUsageObserver } from "../src/backend/agent/usage-collection";
import { WebSearch } from "../src/backend/agent/web-search";
import { CodexAppServerClient } from "../src/backend/app-server-client";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { type DynamicToolCallParams, getRecord, getString, isRecord } from "../src/backend/protocol";
import { TommyDatabase } from "../src/backend/tommy-database";

const OUT = resolve(import.meta.dirname, "../.tommy-build/web-search-e2e");
const scratch = await mkdtemp(join(tmpdir(), "tommy-web-search-"));
const executable = join(scratch, "codex-stand-in");
const logPath = join(scratch, "provider.jsonl");
const database = new TommyDatabase(join(scratch, "data"));
const clients: CodexAppServerClient[] = [];
const profileClients = new ProfileClients();
const report: { passed: boolean; checks: string[]; failure?: string } = { passed: false, checks: [] };
const checked = (name: string) => report.checks.push(name);
const agent: AgentSummary = {
  id: "agent-search-example",
  name: "Search example",
  title: "",
  description: "",
  notifications: false,
  provider: "pi",
  model: "pi-example",
  reasoningEffort: "low",
  threadId: null,
  workspacePath: join(scratch, "workspace"),
  preview: "",
  updatedAt: null,
  avatarSeed: "example",
  avatarHue: null,
  avatarUrl: null,
};
const model: AgentModelOption = {
  provider: "codex",
  id: "example-search-model",
  name: "Search example",
  description: "",
  supportedReasoningEfforts: ["low", "medium"],
  defaultReasoningEffort: "medium",
};
let ready = true;
let stopping = false;
let readyGate: Deferred.Deferred<void> | null = null;
let readyReached: Deferred.Deferred<void> | null = null;
let started: Deferred.Deferred<void> | null = null;
let releaseHold: Deferred.Deferred<void> | null = null;
const redact = (text: string) => text.replaceAll("EXAMPLE_PRIVATE_TOKEN_123", "[REDACTED]");
const createClient = () => {
  const client = new CodexAppServerClient(executable, 5_000, {
    CODEX_HOME: join(scratch, "codex-home"),
    TOMMY_SEARCH_TEST_LOG: logPath,
  });
  client.on("notification", (notification) => {
    if (notification.method === "turn/started" && started) Deferred.doneUnsafe(started, Effect.void);
  });
  clients.push(client);
  return client;
};
const search = new WebSearch({
  profileClients,
  agent: (id) => (id === agent.id ? agent : undefined),
  ready: () =>
    Effect.gen(function* () {
      if (readyReached) yield* Deferred.succeed(readyReached, undefined);
      if (readyGate) yield* Deferred.await(readyGate);
      if (!ready) return yield* Effect.fail({ cause: new Error("The example Codex account is signed out.") });
      return [model];
    }),
  createClient,
  usageObserver: (caller, picked) =>
    sideSessionUsageObserver("web-search", database.usage, caller.id, "codex", picked.id),
  stopping: () => stopping,
  redact,
});

const STAND_IN = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const log = (entry) => appendFileSync(process.env.TOMMY_SEARCH_TEST_LOG, JSON.stringify(entry) + "\\n");
const send = (entry) => process.stdout.write(JSON.stringify(entry) + "\\n");
log({ event: "start", pid: process.pid });
const lines = createInterface({ input: process.stdin });
lines.on("close", () => process.exit(0));
lines.on("line", (line) => {
  const message = JSON.parse(line);
  log(message);
  const answer = (result) => send({ id: message.id, result });
  if (message.method === "initialize") return answer({});
  if (message.method === "initialized") return;
  if (message.method === "config/read") return answer({ config: { mcp_servers: { example: { url: "https://example.com/mcp" } } } });
  if (message.method === "thread/start") return answer({ thread: { id: "search-thread", turns: [] } });
  if (message.method === "turn/start") {
    const threadId = message.params.threadId;
    const turnId = "search-turn";
    answer({ turn: { id: turnId, status: "inProgress", items: [] } });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
    const question = (message.params.input || []).map((part) => part.text || "").join("\\n");
    if (question.includes("CANCEL")) return;
    if (question.includes("FORBIDDEN")) return send({ id: "forbidden-tool", method: "item/tool/call", params: { threadId, turnId, callId: "forbidden", namespace: "tommy", tool: "send_message", arguments: {} } });
    const counts = { totalTokens: 120, inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0 };
    send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: counts, last: counts, modelContextWindow: 100000 } } });
    send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "answer", phase: "final_answer", text: "Example answer. https://example.com/source" } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
    return;
  }
  if (message.id !== undefined && message.method) answer({});
});
`;

const params = (tool: string, args: unknown): DynamicToolCallParams => ({
  threadId: "example-thread",
  turnId: "example-turn",
  callId: "example-call",
  namespace: "tommy",
  tool,
  arguments: args,
});
const providerLog = async () =>
  (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(isRecord);
const wait = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(Effect.timeout("10 seconds")));

try {
  await writeFile(executable, STAND_IN, { mode: 0o700 });
  await runCauseEffect(database.initialize());
  const envelope = params("tool_call", { name: "tommy.web_search", arguments: { query: "example question" } });
  assert.equal(resolveDeferredTool(envelope, "pi")?.tool, "web_search");
  for (const provider of ["codex", "claude", "cursor"] as const) {
    assert.equal(resolveDeferredTool(envelope, provider), null);
    assert.ok(!JSON.stringify(visibleDynamicTools(provider)).includes("web_search"));
    assert.ok(
      !discoverTools(params("tool_search", { query: "tommy.web_search" }), provider).tools.some(
        (tool) => tool.name === "tommy.web_search",
      ),
    );
  }
  assert.ok(
    discoverTools(params("tool_search", { query: "tommy.web_search" }), "pi").tools.some(
      (tool) => tool.name === "tommy.web_search" && "inputSchema" in tool,
    ),
  );
  checked("Only Pi can discover and resolve the deferred search. Native-search providers retain their tools.");

  const ownSkill = { path: "/Users/user/skills/openai-docs/SKILL.md", enabled: true };
  const userConfig = {
    config: { skills: { config: [ownSkill] } },
    layers: [{ config: { features: { tool_suggest: true } } }],
  };
  const settings = codexPromptSettings(userConfig);
  assert.equal(settings["features.tool_suggest"], undefined);
  assert.deepEqual(settings["skills.config"]?.[0], ownSkill);
  assert.ok(!settings["skills.config"]?.some((skill) => skill.name === "openai-docs"));
  assert.equal(codexPromptSettings({ config: {}, layers: [] })["features.tool_suggest"], false);
  assert.deepEqual(codexPromptSettings(null), {});
  checked("Prompt defaults keep explicit user feature settings and path-based skill choices.");

  const answer = await runCauseEffect(search.search(agent.id, "Find EXAMPLE_PRIVATE_TOKEN_123 examples."));
  assert.ok(answer.includes("https://example.com/source"));
  assert.ok(clients.every((client) => !client.running));
  const log = await providerLog();
  const request = log.find((entry) => entry.method === "thread/start");
  const thread = getRecord(request, "params");
  assert.equal(thread?.ephemeral, true);
  assert.equal(thread?.persistSession, false);
  assert.equal(thread?.sandbox, "read-only");
  assert.equal(thread?.approvalPolicy, "never");
  assert.deepEqual(thread?.dynamicTools, []);
  assert.deepEqual(thread?.runtimeWorkspaceRoots, []);
  assert.equal(getRecord(thread, "config")?.web_search, "live");
  assert.deepEqual(getRecord(getRecord(thread, "config"), "mcp_servers"), { example: { enabled: false } });
  assert.equal(getRecord(getRecord(thread, "config"), "features")?.shell_tool, false);
  assert.equal(getRecord(getRecord(thread, "config"), "agents")?.enabled, false);
  assert.ok(!JSON.stringify(log).includes("EXAMPLE_PRIVATE_TOKEN_123"));
  const cwd = getString(thread, "cwd");
  assert.ok(cwd);
  await assert.rejects(access(cwd));
  const usage = database.connection
    .prepare("SELECT agent_id, provider, session_id FROM agent_usage_records WHERE agent_id = ?")
    .all(agent.id);
  assert.ok(usage.length > 0);
  assert.ok(
    usage.every(
      (row) =>
        row.agent_id === agent.id &&
        row.provider === "codex" &&
        typeof row.session_id === "string" &&
        row.session_id.startsWith("web-search:"),
    ),
  );
  checked(
    "A real disposable process gets only live web search, redacts the query, records caller usage and removes its directory.",
  );

  const countBeforeUnavailable = clients.length;
  ready = false;
  await assert.rejects(runCauseEffect(search.search(agent.id, "No account.")));
  assert.equal(clients.length, countBeforeUnavailable);
  ready = true;
  stopping = true;
  await assert.rejects(runCauseEffect(search.search(agent.id, "Shutdown.")));
  assert.equal(clients.length, countBeforeUnavailable);
  stopping = false;
  checked("Missing Codex sign-in and shutdown refuse the tool without starting a process.");

  started = Deferred.makeUnsafe<void>();
  const running = Effect.runFork(search.search(agent.id, "CANCEL this search."));
  await wait(Deferred.await(started));
  await wait(Fiber.interrupt(running));
  const interrupted = await wait(Fiber.await(running));
  assert.ok(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause));
  assert.ok(clients.every((client) => !client.running));
  assert.ok(profileClients.hasSpare());
  started = null;
  checked("Stop interrupts the real side process and releases its generation slot.");

  await assert.rejects(runCauseEffect(search.search(agent.id, "FORBIDDEN local tool.")));
  assert.ok(clients.every((client) => !client.running));
  assert.ok(profileClients.hasSpare());
  checked("An unexpected local tool request fails the search and still closes its process.");

  const release = Deferred.makeUnsafe<void>();
  releaseHold = release;
  const reserved = Deferred.makeUnsafe<void>();
  let holds = 0;
  const hold = () =>
    profileClients.run(createClient(), () =>
      Effect.sync(() => {
        holds += 1;
        if (holds === 2) Deferred.doneUnsafe(reserved, Effect.void);
      }).pipe(Effect.andThen(Deferred.await(release))),
    );
  readyGate = Deferred.makeUnsafe<void>();
  readyReached = Deferred.makeUnsafe<void>();
  const late = Effect.runFork(search.search(agent.id, "Search after readiness."));
  await wait(Deferred.await(readyReached));
  const first = Effect.runFork(hold());
  const second = Effect.runFork(hold());
  await wait(Deferred.await(reserved));
  const startedBeforeBusy = (await providerLog()).filter((entry) => entry.event === "start").length;
  await Effect.runPromise(Deferred.succeed(readyGate, undefined));
  const refused = await wait(Fiber.await(late));
  assert.ok(Exit.isFailure(refused));
  assert.equal((await providerLog()).filter((entry) => entry.event === "start").length, startedBeforeBusy);
  assert.equal(profileClients.busy(), false);
  await Effect.runPromise(Deferred.succeed(release, undefined));
  await wait(Fiber.join(first));
  await wait(Fiber.join(second));
  readyGate = null;
  readyReached = null;
  checked(
    "A slot claimed during Codex readiness atomically refuses background search and leaves the direct-user slot free.",
  );
  report.passed = true;
} catch (failure) {
  report.failure = failure instanceof Error ? failure.message : "The web search check failed.";
  process.exitCode = 1;
} finally {
  if (readyGate) await Effect.runPromise(Deferred.succeed(readyGate, undefined));
  if (releaseHold) await Effect.runPromise(Deferred.succeed(releaseHold, undefined));
  for (const client of clients) await runCauseEffect(client.stop());
  database.close();
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rm(scratch, { recursive: true, force: true });
}
