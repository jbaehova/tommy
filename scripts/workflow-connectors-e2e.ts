// Runs the real workflow service, SQLite store, connector adapters and public HTTP receiver.
// Only official-provider HTTP calls use a local stand-in. No provider, account or live secret is used.
// Run: bun scripts/workflow-connectors-e2e.ts
// Writes .tommy-build/workflow-connectors-e2e/report.json.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WorkflowGraph, WorkflowNode, WorkflowRunDetail } from "@tommy/contracts/ipc";
import { redactText } from "@tommy/logging";
import { Effect, Schema } from "effect";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { TommyDatabase } from "../src/backend/tommy-database";
import { EXTERNAL_EVENT_START } from "../src/backend/webhook-trigger";
import { WorkflowGitHubStore } from "../src/backend/workflows/workflow-github-store";
import { WorkflowRunStore } from "../src/backend/workflows/workflow-run-store";
import { WorkflowStore } from "../src/backend/workflows/workflow-store";
import { workflowScheduleDueAt } from "../src/backend/workflows/workflow-triggers";
import { createWorkflows, type WorkflowsHandle } from "../src/backend/workflows/workflows";
import { DirectWebhookIngress } from "../src/main/direct-webhook-ingress";
import type { WorkflowConnectorConfig } from "../src/main/workflow-connector-config";
import type { ConnectorJson, WorkflowConnectorFetch } from "../src/main/workflow-connector-http";
import { WorkflowConnectors } from "../src/main/workflow-connectors";

const OUT = resolve(import.meta.dirname, "../.tommy-build/workflow-connectors-e2e");
const SECRET = "example-signing-secret-123456789";
const TOKEN = "example-provider-token-123456789";
const TELEGRAM_SECRET = "example_telegram_secret_123456789";
const config: WorkflowConnectorConfig = {
  github: { token: TOKEN, webhookSecret: SECRET, appSlug: "tommy-example", repositories: ["example/project"] },
  slack: [
    {
      id: "slack-example",
      name: "Example workspace",
      token: TOKEN,
      signingSecret: SECRET,
      workspaceId: "TEXAMPLE",
      serviceUserId: "UTOMMY",
      channels: [{ id: "CEXAMPLE", name: "general" }],
    },
  ],
  telegram: [
    {
      id: "telegram-example",
      name: "Example chat",
      token: TOKEN,
      webhookSecret: TELEGRAM_SECRET,
      serviceUserId: "12345",
      username: "tommy_example",
      chatId: "-1001234567890",
    },
  ],
};
const report: {
  passed: boolean;
  checks: string[];
  requests: { service: string; method: string; body: ConnectorJson }[];
  failure?: string;
} = {
  passed: false,
  checks: [],
  requests: [],
};
const check = (label: string, condition: boolean) => {
  assert.ok(condition, label);
  report.checks.push(label);
};

const providerRequest: WorkflowConnectorFetch = async (url, input) => {
  const target = new URL(url);
  check(
    "an outbound request uses an official provider origin",
    ["https://api.github.com", "https://slack.com", "https://api.telegram.org"].includes(target.origin),
  );
  const body = typeof input.body === "string" ? Schema.decodeUnknownSync(Schema.Json)(JSON.parse(input.body)) : null;
  report.requests.push({ service: target.hostname, method: target.pathname.split("/").at(-1) ?? "", body });
  if (target.hostname === "api.github.com") {
    if (target.pathname.endsWith("/comments"))
      return Response.json({ id: 123, html_url: "https://github.com/example/project/issues/1#issuecomment-123" });
    if (target.pathname.endsWith("/issues") && input.method === "POST")
      return Response.json({ number: 2, html_url: "https://github.com/example/project/issues/2" });
    return Response.json([]);
  }
  return Response.json({ ok: true });
};
const directory = await mkdtemp(join(tmpdir(), "tommy-connectors-"));
const database = new TommyDatabase(directory);
let workflows: WorkflowsHandle | null = null;
const connectors = new WorkflowConnectors({ config, workflows: () => workflows, request: providerRequest });
const ingress = new DirectWebhookIngress({ connectors, events: () => null, enabled: () => true });
const server = createServer((request, response) => {
  void Effect.runPromise(ingress.handle(request, response))
    .then((matched) => {
      if (!matched) response.writeHead(404).end();
    })
    .catch(() => response.writeHead(500).end());
});
let origin = "";

async function openWorkflows() {
  return await Effect.runPromise(
    createWorkflows({
      store: new WorkflowStore({ database, nextDueAt: workflowScheduleDueAt(() => "UTC") }),
      runs: new WorkflowRunStore({ database }),
      github: new WorkflowGitHubStore({ database }),
      githubApp: () => connectors.githubApp(),
      githubApi: connectors.githubApi(),
      delivery: () => null,
      turnAnswer: () => null,
      sendHandoff: () => Effect.fail({ cause: new Error("No agent step runs in this check.") }),
      stopDelivery: () => Effect.void,
      generateText: () => Effect.succeed(`A workflow answer ${TOKEN}`),
      notify: () => {},
      changed: () => {},
      rearm: () => {},
      timezone: () => "UTC",
      connectionOn: (id) => connectors.connectionOn(id),
      post: (id, place, text) => connectors.post(id, place, text),
      slackSend: (id, send) => connectors.slackSend(id, send),
      telegramSend: (id, send) => connectors.telegramSend(id, send),
    }),
  );
}

const node = (id: string, kind: WorkflowNode["kind"], fields: WorkflowNode["fields"], x: number): WorkflowNode => ({
  id,
  kind,
  fields,
  at: { x, y: 0 },
});
const graph = (platform: "slack" | "telegram" | "github"): WorkflowGraph => ({
  nodes: [
    node(
      "trigger",
      "trigger",
      platform === "github"
        ? { trigger: platform, event: "issue.opened", repository: "example/project" }
        : { trigger: platform, event: "mention", connectionId: `${platform}-example`, text: "deploy" },
      0,
    ),
    node("answer", "llm", { text: "Answer the person." }, 300),
    node(
      "reply",
      "output",
      platform === "github"
        ? { target: platform, action: "comment", repository: "example/project" }
        : { target: platform, action: "reply", connectionId: "trigger" },
      600,
    ),
    ...(platform === "github"
      ? []
      : [
          node(
            "reaction",
            "output",
            { target: platform, action: "react", connectionId: "trigger", emoji: platform === "slack" ? "✅" : "👀" },
            300,
          ),
        ]),
  ],
  edges: [
    { id: "answer", from: "trigger", to: "answer", type: "text" },
    { id: "reply", from: "answer", to: "reply", type: "text" },
    ...(platform === "github" ? [] : [{ id: "reaction", from: "trigger", to: "reaction", type: "text" as const }]),
  ],
  strokes: [],
});

async function createWorkflow(platform: "slack" | "telegram" | "github") {
  assert.ok(workflows);
  const created = await runCauseEffect(workflows.create({ title: `Example ${platform} workflow` }));
  const result = await runCauseEffect(
    workflows.saveGraph({ workflowId: created.summary.id, baseRevision: created.revision, graph: graph(platform) }),
  );
  assert.ok(result.ok);
  return created.summary.id;
}

async function ended(workflowId: string): Promise<WorkflowRunDetail> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    assert.ok(workflows);
    const latest = (await runCauseEffect(workflows.runs({ workflowId, limit: 1 }))).runs[0];
    if (latest && latest.run.status !== "running" && latest.run.status !== "stopping") {
      assert.equal(latest.run.status, "done");
      return latest;
    }
    if (Date.now() > deadline) throw new Error("The workflow did not finish.");
    await new Promise<void>((done) => setImmediate(done));
  }
}

async function post(path: string, body: string, headers: Record<string, string>) {
  return await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

function slackHeaders(body: string) {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  return {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:`).update(body).digest("hex")}`,
  };
}

try {
  await Effect.runPromise(database.initialize());
  await Effect.runPromise(connectors.start());
  workflows = await openWorkflows();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  const slackWorkflow = await createWorkflow("slack");
  const telegramWorkflow = await createWorkflow("telegram");
  const githubWorkflow = await createWorkflow("github");

  const challenge = JSON.stringify({ type: "url_verification", challenge: "example-challenge" });
  const verified = await post("/hooks/slack/slack-example", challenge, slackHeaders(challenge));
  check(
    "a signed Slack setup challenge is returned",
    verified.status === 200 && (await verified.json()).challenge === "example-challenge",
  );
  check(
    "an unsigned Slack challenge is refused",
    (await post("/hooks/slack/slack-example", challenge, {})).status === 401,
  );

  const slack = JSON.stringify({
    type: "event_callback",
    team_id: "TEXAMPLE",
    event_id: "EVEXAMPLE",
    event: {
      type: "app_mention",
      user: "UPERSON",
      channel: "CEXAMPLE",
      text: "<@UTOMMY> deploy",
      ts: "1800000000.000100",
      thread_ts: "1800000000.000001",
    },
  });
  check(
    "a signed Slack person mention is accepted",
    (await post("/hooks/slack/slack-example", slack, slackHeaders(slack))).status === 202,
  );
  const slackRun = await ended(slackWorkflow);
  check("Slack starts a run with its real source", slackRun.run.source === "slack");
  check(
    "Slack replies retain the thread",
    report.requests.some(
      (entry) =>
        entry.method === "chat.postMessage" && isJsonObject(entry.body) && entry.body.thread_ts === "1800000000.000001",
    ),
  );
  check(
    "Slack reactions target the received message",
    report.requests.some(
      (entry) =>
        entry.method === "reactions.add" && isJsonObject(entry.body) && entry.body.timestamp === "1800000000.000100",
    ),
  );
  const afterSlack = report.requests.length;
  await post("/hooks/slack/slack-example", slack, slackHeaders(slack));
  check("a Slack redelivery starts no duplicate output", report.requests.length === afterSlack);

  const telegram = JSON.stringify({
    update_id: 1,
    message: {
      message_id: 21,
      message_thread_id: 12,
      from: { id: 67890, is_bot: false, first_name: "Example" },
      chat: { id: -1001234567890, type: "supergroup", title: "Example chat" },
      text: "@tommy_example deploy",
      entities: [{ type: "mention", offset: 0, length: 14 }],
    },
  });
  check(
    "a Telegram request without its secret is refused",
    (await post("/hooks/telegram/telegram-example", telegram, {})).status === 401,
  );
  check(
    "a Telegram person mention is accepted",
    (await post("/hooks/telegram/telegram-example", telegram, { "x-telegram-bot-api-secret-token": TELEGRAM_SECRET }))
      .status === 202,
  );
  const telegramRun = await ended(telegramWorkflow);
  check("Telegram starts a run with its real source", telegramRun.run.source === "telegram");
  check(
    "Telegram replies retain the configured chat and topic",
    report.requests.some(
      (entry) =>
        entry.method === "sendMessage" &&
        isJsonObject(entry.body) &&
        entry.body.chat_id === "-1001234567890" &&
        entry.body.message_thread_id === 12,
    ),
  );
  check(
    "Telegram adds a reaction through the official API",
    report.requests.some((entry) => entry.method === "setMessageReaction"),
  );

  const github = JSON.stringify({
    action: "opened",
    repository: { full_name: "example/project" },
    sender: { login: "example-person", type: "User" },
    issue: {
      number: 1,
      title: "Example issue",
      body: `Please deploy\n${"x".repeat(80 * 1024)}`,
      html_url: "https://github.com/example/project/issues/1",
      user: { login: "example-person" },
      labels: [],
      assignees: [],
      author_association: "MEMBER",
    },
  });
  const githubHeaders = {
    "x-github-delivery": "example-delivery-1",
    "x-github-event": "issues",
    "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(github).digest("hex")}`,
  };
  check(
    "a signed GitHub event above 64 KiB is accepted within the 1 MiB limit",
    Buffer.byteLength(github) > 64 * 1024 && (await post("/hooks/github", github, githubHeaders)).status === 202,
  );
  check("GitHub starts a run with its real source", (await ended(githubWorkflow)).run.source === "github");
  check(
    "GitHub comments use its host-owned API adapter",
    report.requests.some((entry) => entry.service === "api.github.com" && entry.method === "comments"),
  );
  const afterGitHub = report.requests.length;
  await post("/hooks/github", github, { ...githubHeaders, "x-github-delivery": "example-forged-delivery-2" });
  check(
    "changing GitHub's unsigned delivery header cannot replay a signed event",
    report.requests.length === afterGitHub,
  );
  check(
    "a changed GitHub body cannot reuse a valid signature",
    (await post("/hooks/github", `${github} `, githubHeaders)).status === 401,
  );
  const oversizedGitHub = `${github}${" ".repeat(1024 * 1024)}`;
  check(
    "a signed GitHub event above 1 MiB is refused",
    (
      await post("/hooks/github", oversizedGitHub, {
        ...githubHeaders,
        "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(oversizedGitHub).digest("hex")}`,
      })
    ).status === 413,
  );
  const oversizedSlack = `${slack}${" ".repeat(65 * 1024)}`;
  check(
    "a signed Slack event retains its 64 KiB limit",
    (await post("/hooks/slack/slack-example", oversizedSlack, slackHeaders(oversizedSlack))).status === 413,
  );
  check("connector sends redact a registered credential", !JSON.stringify(report.requests).includes(TOKEN));
  check(
    "connector sends do not include raw external event instructions",
    !JSON.stringify(report.requests).includes(EXTERNAL_EVENT_START),
  );
  check(
    "a Slack output cannot choose a non-allowlisted channel",
    "failure" in
      (await Effect.runPromise(
        connectors.slackSend("slack-example", { action: "post", channelId: "COTHER", text: "hello" }),
      )),
  );

  await Effect.runPromise(workflows.close());
  workflows = await openWorkflows();
  const afterRestart = report.requests.length;
  await post("/hooks/slack/slack-example", slack, slackHeaders(slack));
  await post("/hooks/telegram/telegram-example", telegram, { "x-telegram-bot-api-secret-token": TELEGRAM_SECRET });
  await post("/hooks/github", github, githubHeaders);
  check(
    "connector redeliveries stay deduplicated after a workflow runtime restart",
    report.requests.length === afterRestart,
  );
  check("an unrelated method does not claim a public route", (await fetch(`${origin}/hooks/github`)).status === 404);
  await Effect.runPromise(connectors.stop());
  check(
    "stopped connectors refuse new webhook work",
    (await post("/hooks/slack/slack-example", slack, slackHeaders(slack))).status === 503,
  );
  report.passed = true;
} catch (error) {
  report.failure = redactText(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await Effect.runPromise(connectors.stop());
  if (workflows) await Effect.runPromise(workflows.close()).catch(() => {});
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  database.close();
  await rm(directory, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${report.passed ? "passed" : "FAILED"}: ${report.checks.length} checks; ${OUT}/report.json\n`);
  if (report.failure) process.stderr.write(`${report.failure}\n`);
}

function isJsonObject(value: ConnectorJson): value is { readonly [key: string]: ConnectorJson } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
