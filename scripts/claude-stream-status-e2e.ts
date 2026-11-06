// Checks what the real `ClaudeAgentClient` makes of the stream of a stand-in `claude` executable,
// which the Claude Agent SDK starts and talks to with stream-json.
// - API retries: Claude Code tries a failed request again by itself. Each `api_retry` frame becomes
//   one turn progress line (no connection, then a busy server), and the first reply frame after
//   them one "gets answers again" line. Before, the chat showed nothing while Claude retried.
// - Streamed thinking: each stream event has a uuid of its own. A thinking block whose deltas came in
//   three events stays one line, two blocks are one line apart, and the complete message corrects a
//   chunk that the stream lost. Before, each delta began a new line.
// - A Claude resume of a session that the CLI never wrote ("No conversation found with session ID")
//   reads as a refused session, so the existing path starts a new session from the chat history.
// - Each SDK process names Tommy (`CLAUDE_CODE_ENTRYPOINT=tommy`) and turns the Artifact tools off.
// `bun scripts/claude-stream-status-e2e.ts`. Writes .tommy-build/claude-stream-status-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sourceText } from "@tommy/i18n/source";
import { refusedSessionFailure } from "../src/backend/agent/thread-items";
import { ClaudeAgentClient } from "../src/backend/claude-client";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { type AppServerNotification, getRecord, getString, isRecord } from "../src/backend/protocol";

const OUT = resolve(import.meta.dirname, "../.tommy-build/claude-stream-status-e2e");
const REPORT = join(OUT, "report.json");
const root = await mkdtemp(join(tmpdir(), "tommy-claude-stream-status-"));
const executable = join(root, "claude");
const envLog = join(root, "env.jsonl");
const MODEL = "claude-stand-in";
// The complete message has the true text. The stream lost " words" of the first block.
const FIRST_BLOCK = "Weigh the words";
const SECOND_BLOCK = "Then answer.";
const ANSWER = "Here is the answer.";

const STAND_IN_CLAUDE = `#!${process.execPath}
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2.1.310 (Claude Code)\\n");
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(envLog)}, JSON.stringify({
  entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
  artifact: process.env.CLAUDE_CODE_ARTIFACT ?? null,
}) + "\\n");
const sessionId = randomUUID();
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const frame = (message) => ({ ...message, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
const event = (value) => write(frame({ type: "stream_event", event: value }));
const turn = (message) => {
  write(frame({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 1, error_status: null, error: "unknown" }));
  write(frame({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 1, error_status: 529, error: "server_error" }));
  const id = "msg_" + message.uuid;
  write(frame({ type: "stream_event", user_message_uuid: message.uuid,
    event: { type: "message_start", message: { id, type: "message", role: "assistant", content: [] } } }));
  event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
  event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Weigh" } });
  event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " the" } });
  event({ type: "content_block_stop", index: 0 });
  event({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } });
  event({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Then" } });
  event({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: " answer." } });
  event({ type: "content_block_stop", index: 1 });
  event({ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } });
  event({ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: ${JSON.stringify(ANSWER)} } });
  const reply = { id, type: "message", role: "assistant", model: ${JSON.stringify(MODEL)},
    content: [
      { type: "thinking", thinking: ${JSON.stringify(FIRST_BLOCK)}, signature: "s" },
      { type: "thinking", thinking: ${JSON.stringify(SECOND_BLOCK)}, signature: "s" },
      { type: "text", text: ${JSON.stringify(ANSWER)} },
    ],
    stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
  write(frame({ type: "assistant", message: reply, user_message_uuid: message.uuid }));
  write(frame({ type: "result", subtype: "success", is_error: false, result: ${JSON.stringify(ANSWER)},
    duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 },
    permission_denials: [] }));
};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === "control_request")
      write({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    else if (message.type === "user") turn(message);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

interface Report {
  progress: string[];
  thinkingDeltas: string[];
  thinking: string | null;
  answer: string | null;
  turnStatus: string | null;
  processes: unknown[];
  result?: "pass" | "fail";
  error?: string;
}

const report: Report = {
  progress: [],
  thinkingDeltas: [],
  thinking: null,
  answer: null,
  turnStatus: null,
  processes: [],
};
const client = new ClaudeAgentClient({ executable, version: "2.1.310" });
try {
  await writeFile(executable, STAND_IN_CLAUDE);
  await chmod(executable, 0o755);
  // A sign-in or a Claude Code session in the shell does not change the stand-in.
  for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) delete process.env[name];

  let reasoningItem: string | null = null;
  const completed = Promise.withResolvers<void>();
  client.on("notification", (notification: AppServerNotification) => {
    const params = notification.params;
    const item = getRecord(params, "item");
    const phase = getString(item, "phase");
    if (notification.method === "tommy/turn-progress") report.progress.push(getString(params, "detail") ?? "");
    if (notification.method === "item/started" && phase === "commentary") reasoningItem = getString(item, "id");
    if (notification.method === "item/agentMessage/delta" && getString(params, "itemId") === reasoningItem)
      report.thinkingDeltas.push(getString(params, "delta") ?? "");
    if (notification.method === "item/completed" && phase === "commentary") report.thinking = getString(item, "text");
    if (notification.method === "item/completed" && getString(item, "type") === "agentMessage" && phase === null)
      report.answer = getString(item, "text");
    if (notification.method === "turn/completed") {
      report.turnStatus = getString(getRecord(params, "turn"), "status");
      completed.resolve();
    }
  });
  client.start();
  const threadId = await runCauseEffect(
    client.request("thread/start", { cwd: root, model: MODEL }, (value) => getString(getRecord(value, "thread"), "id")),
  );
  assert.ok(threadId, "the thread did not start");
  await runCauseEffect(
    client.request("turn/start", { threadId, input: [{ type: "text", text: "Answer me." }] }, (value) => value),
  );
  await completed.promise;
  report.processes = readFileSync(envLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  assert.equal(report.turnStatus, "completed", "the turn did not complete");
  assert.deepEqual(
    report.progress,
    [
      sourceText("status.provider.retryUnreachable", { provider: "Claude", attempt: 1, maxAttempts: 10 }),
      sourceText("status.provider.retryServerError", { provider: "Claude", attempt: 2, maxAttempts: 10 }),
      sourceText("status.provider.retryRecovered", { provider: "Claude" }),
    ],
    "the API retries did not show as turn progress",
  );
  assert.equal(
    report.thinking,
    `${FIRST_BLOCK}\n${SECOND_BLOCK}`,
    "the thinking blocks did not keep their words whole",
  );
  assert.ok(
    !report.thinkingDeltas.slice(0, 2).some((delta) => delta.startsWith("\n")),
    "a streamed delta inside one thinking block began a new line",
  );
  assert.equal(report.answer, ANSWER, "the answer changed");
  assert.ok(report.processes.length > 0, "the SDK started no process");
  assert.ok(
    report.processes.every((entry) => isRecord(entry) && entry.entrypoint === "tommy" && entry.artifact === "0"),
    "an SDK process did not name Tommy or kept the Artifact tools",
  );

  assert.equal(
    refusedSessionFailure("claude", "No conversation found with session ID: 0f0e6c0a-4a1f-4c1f-9a7b-6f3d2f6c9c11"),
    sourceText("error.provider.claudeSessionMissing"),
    "a missing Claude session did not read as a refused session",
  );
  assert.equal(
    refusedSessionFailure("codex", "No conversation found with session ID: x"),
    null,
    "another provider's text read as a missing Claude session",
  );

  report.result = "pass";
} catch (error) {
  report.result = "fail";
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await runCauseEffect(client.stop());
  await rm(root, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`PASS claude-stream-status-e2e: ${REPORT}\n`);
