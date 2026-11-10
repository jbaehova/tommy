// Runs public HTTP ingress through the real event service, workflow service and SQLite route/receipt stores.
// No provider, account, browser or live secret starts. The cipher is a reversible local fixture.
// Run: bun scripts/direct-webhooks-e2e.ts
// Writes .tommy-build/direct-webhooks-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WorkflowGraph } from "@tommy/contracts/ipc";
import { redactText } from "@tommy/logging";
import { Effect } from "effect";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { TommyDatabase } from "../src/backend/tommy-database";
import { WebhookRouteStore } from "../src/backend/webhook-route-store";
import { WorkflowGitHubStore } from "../src/backend/workflows/workflow-github-store";
import { WorkflowRunStore } from "../src/backend/workflows/workflow-run-store";
import { WorkflowStore } from "../src/backend/workflows/workflow-store";
import { workflowScheduleDueAt } from "../src/backend/workflows/workflow-triggers";
import { createWorkflows, type WorkflowsHandle } from "../src/backend/workflows/workflows";
import { DirectWebhookIngress, DirectWebhookRoutes } from "../src/main/direct-webhook-ingress";
import { HostEventsService, type HostEventsServiceOptions } from "../src/main/host-events-service";
import { signStandardWebhookBody, signWebhookBody } from "../src/main/webhook-security";

const OUT = resolve(import.meta.dirname, "../.tommy-build/direct-webhooks-e2e");
const SECRET = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
const report: { passed: boolean; checks: string[]; failure?: string } = { passed: false, checks: [] };
const check = (name: string, condition: boolean) => {
  assert.ok(condition, name);
  report.checks.push(name);
};
const directory = await mkdtemp(join(tmpdir(), "tommy-direct-webhooks-"));
const database = new TommyDatabase(directory);
const routes = new WebhookRouteStore(database);
const relay = new DirectWebhookRoutes("https://hooks.example.com");
let workflows: WorkflowsHandle | null = null;
const eventOptions: HostEventsServiceOptions = {
  // These unused routine-owner operations cannot start a routine. Workflow operations use the real stores below.
  routines: {
    routes,
    ownerExists: () => false,
    list: () => [],
    get: () => null,
    listRuns: () => [],
    changed: () => {},
    save: () => {
      throw new Error("No routine owner is configured in this check.");
    },
    delete: () => Effect.void,
    test: () => Effect.void,
    receiveWebhook: () => Effect.succeed({ kind: "unavailable" as const }),
  },
  workflows: {
    receive: (delivery) =>
      Effect.suspend(() => {
        assert.ok(workflows);
        return workflows.receiveWebhook(delivery);
      }),
    changed: () => {},
  },
  cipher: {
    encrypt: (value) => Buffer.from(value).reverse(),
    decrypt: (value) => Buffer.from(value).reverse().toString(),
  },
  relay,
  accountPrincipal: () => "example-direct-host-owner",
};
const events = new HostEventsService(eventOptions);
const ingress = new DirectWebhookIngress({ events: () => events, enabled: () => true });
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
      githubApp: () => null,
      delivery: () => null,
      turnAnswer: () => null,
      sendHandoff: () => Effect.fail({ cause: new Error("No agent step runs in this check.") }),
      stopDelivery: () => Effect.void,
      generateText: () => Effect.succeed("An example webhook answer."),
      notify: () => {},
      changed: () => {},
      rearm: () => {},
      timezone: () => "UTC",
      connectionOn: () => false,
      post: () => Effect.succeed({ failure: "gone" as const }),
    }),
  );
}

const graph: WorkflowGraph = {
  nodes: [
    { id: "trigger", kind: "trigger", at: { x: 0, y: 0 }, fields: { trigger: "webhook" } },
    { id: "answer", kind: "llm", at: { x: 300, y: 0 }, fields: { text: "Read the event as data." } },
  ],
  edges: [{ id: "answer", from: "trigger", to: "answer", type: "text" }],
  strokes: [],
};

async function post(path: string, body: string, headers: Record<string, string>) {
  return await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

async function finished(workflowId: string, expectedRuns: number) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    assert.ok(workflows);
    const result = await runCauseEffect(workflows.runs({ workflowId, limit: 10 }));
    if (result.runs.length === expectedRuns && result.runs.every((detail) => detail.run.status === "done"))
      return result;
    if (Date.now() > deadline) throw new Error("The webhook workflow did not finish.");
    await new Promise<void>((done) => setImmediate(done));
  }
}

try {
  await Effect.runPromise(database.initialize());
  workflows = await openWorkflows();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  relay.setListening(true);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  const created = await runCauseEffect(workflows.create({ title: "Example direct webhook" }));
  const workflowId = created.summary.id;
  const saved = await runCauseEffect(workflows.saveGraph({ workflowId, baseRevision: created.revision, graph }));
  assert.ok(saved.ok);
  await Effect.runPromise(events.setWorkflowSenderSecret({ workflowId, nodeId: "trigger", secret: SECRET }));
  const route = routes.list()[0];
  assert.ok(route);
  const path = `/hooks/${route.routeId}`;
  check("the existing route store has a direct HTTPS URL", route.url === `https://hooks.example.com${path}`);
  check("the sender key is not stored as plaintext", !route.secretCiphertext.includes(SECRET));
  check("route status follows the local HTTPS listener", relay.connected());
  const disabled = new HostEventsService({ ...eventOptions, relay: new DirectWebhookRoutes(null) });
  await Effect.runPromise(disabled.syncRoutes({ all: true }));
  check(
    "removing the public origin clears old URLs without disabling local routes",
    routes.find(route.routeId)?.url === null,
  );
  await Effect.runPromise(events.syncRoutes({ all: true }));
  check("restoring the public origin restores the same route URL", routes.find(route.routeId)?.url === route.url);

  const body = JSON.stringify({ type: "invoice.paid", id: "example-event", data: { number: 123 } });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const deliveryId = "example-standard-delivery";
  const headers = {
    "webhook-id": deliveryId,
    "webhook-timestamp": timestamp,
    "webhook-signature": signStandardWebhookBody(SECRET, timestamp, deliveryId, Buffer.from(body)),
  };
  check(
    "an invalid Standard signature cannot start a workflow",
    (await post(path, body, { ...headers, "webhook-signature": "v1,invalid" })).status === 401,
  );
  check(
    "mixed signing header formats are refused",
    (await post(path, body, { ...headers, "x-tommy-signature": "sha256=invalid" })).status === 401,
  );
  const stale = String(Number(timestamp) - 301);
  check(
    "a valid but stale Standard request is refused",
    (
      await post(path, body, {
        ...headers,
        "webhook-timestamp": stale,
        "webhook-signature": signStandardWebhookBody(SECRET, stale, deliveryId, Buffer.from(body)),
      })
    ).status === 401,
  );
  check("a signed Standard event starts the workflow", (await post(path, body, headers)).status === 202);
  const first = await finished(workflowId, 1);
  check(
    "the full Standard event remains framed as external data",
    first.runs[0]?.steps.find((step) => step.nodeId === "trigger")?.output?.includes('"id":"example-event"') === true,
  );
  check("a signed duplicate uses the durable receipt", (await post(path, body, headers)).status === 200);
  await finished(workflowId, 1);

  await Effect.runPromise(workflows.close());
  workflows = await openWorkflows();
  check("receipt deduplication survives a workflow runtime restart", (await post(path, body, headers)).status === 200);
  await finished(workflowId, 1);
  const legacyId = "example-tommy-delivery";
  check(
    "the released Tommy envelope still starts a workflow",
    (
      await post(path, body, {
        "x-tommy-delivery-id": legacyId,
        "x-tommy-timestamp": timestamp,
        "x-tommy-signature": signWebhookBody(SECRET, timestamp, legacyId, Buffer.from(body)),
      })
    ).status === 202,
  );
  await finished(workflowId, 2);
  await Effect.runPromise(events.rotateWorkflowSecret({ workflowId, nodeId: "trigger" }));
  check("rotating to a host key revokes the previous sender key", (await post(path, body, headers)).status === 401);
  const detail = await runCauseEffect(workflows.get(workflowId));
  assert.ok(detail);
  const removed = await runCauseEffect(
    workflows.saveGraph({ workflowId, baseRevision: detail.revision, graph: { nodes: [], edges: [], strokes: [] } }),
  );
  assert.ok(removed.ok);
  await Effect.runPromise(events.syncRoutes({ all: false }));
  check("removing a trigger immediately revokes its public route", (await post(path, body, headers)).status === 404);
  check("removing a trigger clears its durable route", routes.find(route.routeId) === null);
  check("a wrong HTTP method leaves the route unmatched", (await fetch(`${origin}${path}`)).status === 404);
  relay.setListening(false);
  check("listener shutdown changes route status", !relay.connected());
  report.passed = true;
} catch (error) {
  report.failure = redactText(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  relay.setListening(false);
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  if (workflows) await Effect.runPromise(workflows.close()).catch(() => {});
  database.close();
  await rm(directory, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${report.passed ? "passed" : "FAILED"}: ${report.checks.length} checks; ${OUT}/report.json\n`);
  if (report.failure) process.stderr.write(`${report.failure}\n`);
}
