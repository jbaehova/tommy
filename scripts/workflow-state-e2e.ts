// Checks non-English conditions, answer reuse after graph edits and GitHub repository selection
// on the real workflow service and SQLite. A temporary profile owns all data.
// Run: bun scripts/workflow-state-e2e.ts
// Writes .tommy-build/workflow-state-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { WorkflowGraph, WorkflowRunDetail } from "@tommy/contracts/ipc";
import { Effect } from "effect";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { TommyDatabase } from "../src/backend/tommy-database";
import { WorkflowGitHubStore } from "../src/backend/workflows/workflow-github-store";
import { WorkflowRunStore } from "../src/backend/workflows/workflow-run-store";
import { WorkflowStore } from "../src/backend/workflows/workflow-store";
import { workflowScheduleDueAt } from "../src/backend/workflows/workflow-triggers";
import { createWorkflows, type WorkflowsHandle } from "../src/backend/workflows/workflows";

const OUT = resolve(import.meta.dirname, "../.tommy-build/workflow-state-e2e");
const profile = await mkdtemp(join(tmpdir(), "tommy-workflow-state-"));
const database = new TommyDatabase(profile);
const checks: string[] = [];
const prompts: string[] = [];
let service: WorkflowsHandle | undefined;
let tick = Date.UTC(2026, 0, 1);
let failure: string | undefined;
let suppliedAnswer: string | undefined;

const graphOf = (text: string, rule: string): WorkflowGraph => ({
  nodes: [
    { id: "input", kind: "prompt", at: { x: 0, y: 0 }, fields: { text } },
    { id: "condition", kind: "condition", at: { x: 400, y: 0 }, fields: { rule } },
    { id: "yes", kind: "output", at: { x: 800, y: 0 }, fields: { target: "notify" } },
    { id: "no", kind: "output", at: { x: 800, y: 300 }, fields: { target: "notify" } },
  ],
  edges: [
    { id: "input-condition", from: "input", to: "condition", type: "text" },
    { id: "condition-yes", from: "condition", to: "yes", type: "text", branch: "yes" },
    { id: "condition-no", from: "condition", to: "no", type: "text", branch: "no" },
  ],
  strokes: [],
});

async function ended(workflows: WorkflowsHandle, runId: string): Promise<WorkflowRunDetail> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const detail = await runCauseEffect(workflows.run(runId));
    if (detail.run.status === "done" || detail.run.status === "failed" || detail.run.status === "stopped")
      return detail;
    if (Date.now() >= deadline) throw new Error(`Workflow run ${runId} did not end.`);
    await setImmediate();
  }
}

async function save(workflows: WorkflowsHandle, workflowId: string, graph: WorkflowGraph) {
  const current = await runCauseEffect(workflows.get(workflowId));
  const result = await runCauseEffect(workflows.saveGraph({ workflowId, baseRevision: current.revision, graph }));
  assert.ok(result.ok, "The graph saves without a conflict.");
}

try {
  await Effect.runPromise(database.initialize());
  const workflows = await Effect.runPromise(
    createWorkflows({
      store: new WorkflowStore({ database, nextDueAt: workflowScheduleDueAt(() => "UTC") }),
      runs: new WorkflowRunStore({ database }),
      github: new WorkflowGitHubStore({ database }),
      githubApp: () => null,
      delivery: () => null,
      turnAnswer: () => null,
      sendHandoff: () => Effect.fail({ cause: new Error("No agent step runs in this check.") }),
      stopDelivery: () => Effect.void,
      generateText: ({ prompt }) =>
        Effect.sync(() => {
          prompts.push(prompt);
          return suppliedAnswer ?? (prompt.includes("아니요 조건") ? "false" : "**true**");
        }),
      notify: () => {},
      connectionOn: () => false,
      post: () => Effect.succeed({ failure: "not-running" as const }),
      changed: () => {},
      rearm: () => {},
      timezone: () => "UTC",
      now: () => new Date(tick++),
    }),
  );
  service = workflows;

  const created = await runCauseEffect(
    workflows.create({ title: "Condition state", graph: graphOf("first", "아니요 조건") }),
  );
  const workflowId = created.summary.id;
  const first = await runCauseEffect(workflows.startRun({ workflowId, requestId: "first" }));
  const before = await ended(workflows, first.run.id);
  assert.equal(before.run.status, "done");
  assert.equal(before.steps.find((step) => step.nodeId === "condition")?.branch, "no");
  assert.equal(before.steps.find((step) => step.nodeId === "yes")?.status, "skipped");
  assert.ok(prompts[0]?.includes("Answer in English also when the condition or the input uses another language."));
  checks.push("A Korean condition requests English and accepts false as the no branch.");

  await save(workflows, workflowId, graphOf("first", "예 조건"));
  const second = await runCauseEffect(
    workflows.startRun({ workflowId, fromNodeId: "yes", requestId: "changed-condition" }),
  );
  const changed = await ended(workflows, second.run.id);
  assert.equal(changed.run.status, "done");
  assert.equal(changed.steps.find((step) => step.nodeId === "condition")?.branch, "yes");
  assert.equal(changed.steps.find((step) => step.nodeId === "yes")?.output, "first");
  assert.equal(prompts.length, 2);
  checks.push("Starting after an edited condition evaluates it again and takes its new branch.");

  const viewEdit = graphOf("first", "예 조건");
  viewEdit.nodes = viewEdit.nodes.map((node) =>
    node.id === "condition" ? { ...node, at: { x: 420, y: 40 }, fields: { ...node.fields, color: "blue" } } : node,
  );
  await save(workflows, workflowId, viewEdit);
  const third = await runCauseEffect(workflows.startRun({ workflowId, fromNodeId: "yes", requestId: "view-only" }));
  const unchanged = await ended(workflows, third.run.id);
  assert.equal(unchanged.run.status, "done");
  assert.equal(unchanged.steps.find((step) => step.nodeId === "yes")?.output, "first");
  assert.equal(prompts.length, 2);
  checks.push("A position or color edit keeps a valid earlier answer.");

  await save(workflows, workflowId, graphOf("second", "예 조건"));
  const fourth = await runCauseEffect(
    workflows.startRun({ workflowId, fromNodeId: "yes", requestId: "changed-input" }),
  );
  const upstream = await ended(workflows, fourth.run.id);
  assert.equal(upstream.run.status, "done");
  assert.equal(upstream.steps.find((step) => step.nodeId === "yes")?.output, "second");
  assert.equal(prompts.length, 3);
  checks.push("An upstream input edit invalidates copied answers and reaches the requested output.");

  const duplicate = await runCauseEffect(
    workflows.startRun({ workflowId, fromNodeId: "yes", requestId: "changed-input" }),
  );
  assert.equal(duplicate.run.id, fourth.run.id);
  assert.equal(prompts.length, 3);
  checks.push("Repeating the same run request starts no second run.");

  const gitGraph: WorkflowGraph = {
    nodes: [
      {
        id: "trigger",
        kind: "trigger",
        at: { x: 0, y: 0 },
        fields: {
          trigger: "github",
          event: "comment",
          repository: "acme/first",
          repositories: "acme/first\nacme/second",
        },
      },
      { id: "output", kind: "output", at: { x: 400, y: 0 }, fields: { target: "notify" } },
    ],
    edges: [{ id: "github-output", from: "trigger", to: "output", type: "text" }],
    strokes: [],
  };
  const git = await runCauseEffect(workflows.create({ title: "Repository state", graph: gitGraph }));
  assert.deepEqual(await runCauseEffect(workflows.githubRepositories()), ["acme/first", "acme/second"]);
  const event = {
    event: "issue_comment",
    deliveryId: "second-repository",
    body: {
      action: "created",
      repository: { full_name: "acme/second" },
      sender: { login: "person", type: "User" },
      issue: {
        number: 2,
        title: "Second repository",
        body: "Example issue",
        labels: [],
        user: { login: "person", type: "User" },
      },
      comment: { id: 10, body: "Please review", user: { login: "person", type: "User" }, author_association: "MEMBER" },
    },
  };
  assert.equal((await runCauseEffect(workflows.receiveGitHub(event))).kind, "saved");
  const history = await runCauseEffect(workflows.githubHistory(git.summary.id));
  const entry = history.deliveries.find((delivery) => delivery.item?.repository === "acme/second");
  assert.ok(entry?.runId);
  assert.equal((await ended(workflows, entry.runId)).run.status, "done");
  checks.push("One GitHub trigger starts a run for its second repository.");

  await runCauseEffect(workflows.receiveGitHub(event));
  const repeated = await runCauseEffect(workflows.githubHistory(git.summary.id));
  assert.equal(repeated.deliveries.length, history.deliveries.length);
  checks.push("A repeated GitHub delivery starts no second run.");

  gitGraph.nodes = gitGraph.nodes.map((node) =>
    node.id === "trigger" ? { ...node, fields: { ...node.fields, repository: "acme/third" } } : node,
  );
  await save(workflows, git.summary.id, gitGraph);
  assert.deepEqual(await runCauseEffect(workflows.githubRepositories()), ["acme/third"]);
  assert.equal(
    (await runCauseEffect(workflows.receiveGitHub({ ...event, deliveryId: "removed-repository" }))).kind,
    "unwatched",
  );
  checks.push("A single-repository client edit removes the stale list and stops watching its old repositories.");

  for (const [answer, branch] of [
    ["네", "yes"],
    ["예", "yes"],
    ["아니오", "no"],
    ["아니요, yes is not my answer", "no"],
    ["불확실 yes", null],
  ] as const) {
    suppliedAnswer = answer;
    const localized = await runCauseEffect(
      workflows.create({ title: "Localized condition", graph: graphOf("A value.", "판단하세요") }),
    );
    const localRun = await runCauseEffect(
      workflows.startRun({ workflowId: localized.summary.id, requestId: `localized-${answer}` }),
    );
    const result = await ended(workflows, localRun.run.id);
    const condition = result.steps.find((step) => step.nodeId === "condition");
    assert.equal(branch === null ? condition?.status : condition?.branch, branch === null ? "failed" : branch);
  }
  checks.push("The first Korean word decides the branch; an unclear first word cannot borrow a later English yes.");
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (service) await Effect.runPromise(service.close());
  database.close();
  await rm(profile, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeFile(
    join(OUT, "report.json"),
    `${JSON.stringify({ passed: failure === undefined, checks, generations: prompts.length, ...(failure ? { failure } : {}) }, null, 2)}\n`,
  );
}
