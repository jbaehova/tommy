// Runs the real AgentStore, SQLite, MailboxStore and NewsShare in a scratch profile. A scripted
// model answer stands for the generation, so the script checks what Tommy does with an answer: which
// turns it checks, what the model reads, and which messages go out.
// It reads no account, user database or provider home.
// Run: bun scripts/news-share-e2e.ts
// Artifact: .tommy-build/news-share-e2e/report.json
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { type FinishedTurn, NewsShare } from "../src/backend/agent/news-share";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { TommyDatabase } from "../src/backend/tommy-database";

const OUT = resolve(import.meta.dirname, "../.tommy-build/news-share-e2e");
const scratch = await mkdtemp(join(tmpdir(), "tommy-news-share-"));
const userData = join(scratch, "user-data");
const home = join(scratch, "profile-home");
await mkdir(home, { recursive: true });

const database = new TommyDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, database);
const checks: { name: string; passed: true }[] = [];
const check = async (name: string, run: () => Promise<void>) => {
  await run();
  checks.push({ name, passed: true });
};

/** The answer of the model for the next check, and the prompts that it read. */
let modelAnswer = '{"private":false,"shares":[]}';
const prompts: string[] = [];
/** The turns that only mark the end of the checks before them. */
const marks = new Map<string, () => void>();
/** Called when a check reads the agents, so a test can change them only after that read. */
let agentsRead: (() => void) | null = null;
const SECRET = "sk-test-0123456789";
/** The teammates that the agent told itself, as `<turn id>:<agent id>`. */
const told = new Set<string>();

const share = new NewsShare({
  listAgents: () => {
    const agents = store.list();
    agentsRead?.();
    return agents;
  },
  canGenerate: () => true,
  generate: (_agent, prompt) =>
    Effect.sync(() => {
      for (const [mark, reached] of marks) {
        if (!prompt.includes(mark)) continue;
        marks.delete(mark);
        reached();
        return '{"private":false,"shares":[]}';
      }
      prompts.push(prompt);
      return modelAnswer;
    }),
  sentMessages: (agentId) =>
    mailbox
      .conversationMessages(agentId)
      .flatMap((message) =>
        message.exchange?.direction === "outgoing"
          ? [{ recipientAgentIds: message.exchange.recipientAgentIds, text: message.text }]
          : [],
      ),
  send: ({ senderAgentId, recipientAgentId, text }) =>
    mailbox.enqueue({
      sender: { kind: "agent", agentId: senderAgentId },
      recipientAgentIds: [recipientAgentId],
      text,
      replyToMessageId: null,
      expectsReply: false,
    }),
  toldInTurn: (_agentId, turnId, recipientAgentId) => told.has(`${turnId}:${recipientAgentId}`),
  redact: (text) => text.replaceAll(SECRET, "[redacted]"),
  stopping: () => false,
});

let turns = 0;
const turn = (agentId: string, said: string, answer: string, from: "user" | "routine" = "user"): FinishedTurn => {
  turns += 1;
  return { agentId, turnId: `turn-${turns}`, said: [{ from, text: said }], steps: [], answer };
};
/** Ends when every check before this call ended: the checks run one at a time, in order. */
async function checked(agentId: string) {
  const mark = `end-mark-${marks.size}-${turns}`;
  const reached = new Promise<void>((done, reject) => {
    const deadline = setTimeout(() => reject(new Error("Timed out waiting for the checks.")), 20_000);
    marks.set(mark, () => {
      clearTimeout(deadline);
      done();
    });
  });
  await Effect.runPromise(share.turnEnded(turn(agentId, mark, "ok")));
  await reached;
}
/** One finished turn and the model's answer for it, checked to the end. */
async function finish(finished: FinishedTurn, answer: string | { private?: boolean; shares: unknown }) {
  modelAnswer = typeof answer === "string" ? answer : JSON.stringify({ private: false, ...answer });
  await Effect.runPromise(share.turnEnded(finished));
  await checked(finished.agentId);
}
const queued = (agentId: string) => mailbox.listQueue(agentId).deliveries;

try {
  await runCauseEffect(store.initialize());
  await runCauseEffect(mailbox.initialize());
  const create = (name: string, description: string) =>
    runCauseEffect(
      store.createAgent({ name, description, avatarSeed: name.toLowerCase().replaceAll(" ", "-"), avatarHue: null }),
    );
  const main = await create("Main", "Helps with daily tasks, the calendar and mail.");
  const coach = await create(
    "Interview Coach",
    "Helps with the process of getting a job, from an application to an interview.",
  );
  const school = await create("Graduation Helper", "Helps with school work and graduation.");

  await check("news of a user turn goes to the teammate that owns it, as a message that needs no answer", async () => {
    await finish(turn(main.id, "I sent the application to Example Corp.", "I marked the task as done."), {
      shares: [{ agentId: coach.id, text: "The user sent the application to Example Corp." }],
    });
    const deliveries = queued(coach.id);
    assert.equal(deliveries.length, 1);
    assert.deepEqual(deliveries[0]?.sender, { kind: "agent", agentId: main.id });
    assert.equal(deliveries[0]?.text, "The user sent the application to Example Corp.");
    assert.equal(deliveries[0]?.expectsReply, false);
    assert.equal(queued(school.id).length, 0);
  });

  await check("the model reads the turn, the remits and the messages that the agent already sent", async () => {
    const prompt = prompts.at(-1) ?? "";
    assert.match(prompt, /I sent the application to Example Corp\./u);
    assert.match(prompt, /I marked the task as done\./u);
    assert.match(prompt, /getting a job/u);
    assert.match(prompt, /Graduation Helper/u);
    assert.doesNotMatch(prompt.slice(prompt.lastIndexOf("<teammates>")), /"name": "Main"/u);
    await finish(turn(main.id, "The coding test of Example Corp is on 2027-03-02.", "I added it to the calendar."), {
      shares: [],
    });
    assert.match(prompts.at(-1) ?? "", /<already_sent>.*The user sent the application to Example Corp\./su);
    assert.equal(queued(coach.id).length, 1);
  });

  await check("a routine turn is checked, and one turn tells each teammate once", async () => {
    await finish(turn(main.id, "Check the mail.", "The school moved the thesis deadline to 2027-04-01.", "routine"), {
      shares: [
        { agentId: school.id, text: "The thesis deadline moved to 2027-04-01." },
        { agentId: school.id, text: "A second message for the same teammate." },
      ],
    });
    assert.match(prompts.at(-1) ?? "", /"from": "routine"/u);
    assert.deepEqual(
      queued(school.id).map((delivery) => delivery.text),
      ["The thesis deadline moved to 2027-04-01."],
    );
  });

  await check("an unknown agent, the agent itself, a hidden agent and an empty text get nothing", async () => {
    store.setHidden(school.id, new Date().toISOString());
    const before = [queued(main.id).length, queued(coach.id).length, queued(school.id).length];
    await finish(turn(main.id, "A fact.", "Done."), {
      shares: [
        { agentId: "agent-unknown", text: "A fact." },
        { agentId: main.id, text: "A fact." },
        { agentId: school.id, text: "A fact." },
        { agentId: coach.id, text: "   " },
      ],
    });
    assert.doesNotMatch(prompts.at(-1) ?? "", /Graduation Helper/u);
    assert.deepEqual([queued(main.id).length, queued(coach.id).length, queued(school.id).length], before);
    store.setHidden(school.id, null);
  });

  await check(
    "an answer that is not the requested JSON sends nothing, and the next turn is still checked",
    async () => {
      const before = queued(coach.id).length;
      await finish(turn(main.id, "A fact.", "Done."), "I think the coach should know this.");
      await finish(turn(main.id, "A fact.", "Done."), { shares: "none" });
      assert.equal(queued(coach.id).length, before);
      await finish(turn(main.id, "The interview is on 2027-03-09.", "Noted."), {
        shares: [{ agentId: coach.id, text: "The interview at Example Corp is on 2027-03-09." }],
      });
      assert.equal(queued(coach.id).length, before + 1);
    },
  );

  await check("a secret does not reach the model or the teammate", async () => {
    const before = queued(coach.id).length;
    await finish(turn(main.id, `The portal key is ${SECRET}.`, `I saved ${SECRET}.`), {
      shares: [{ agentId: coach.id, text: `The portal key is ${SECRET}.` }],
    });
    assert.doesNotMatch(prompts.at(-1) ?? "", new RegExp(SECRET, "u"));
    const sent = queued(coach.id).slice(before);
    assert.deepEqual(
      sent.map((delivery) => delivery.text),
      ["The portal key is [redacted]."],
    );
  });

  await check("a turn that the user wants kept private sends nothing", async () => {
    const before = queued(coach.id).length;
    await finish(turn(main.id, "Example Corp rejected me. Tell nobody.", "I will not pass it on."), {
      private: true,
      shares: [{ agentId: coach.id, text: "Example Corp rejected the user." }],
    });
    assert.equal(queued(coach.id).length, before);
  });

  await check("a teammate that the agent told in the turn is left out, and the others are not", async () => {
    const finished = turn(main.id, "The offer of Example Corp came, and the thesis is approved.", "I told the coach.");
    told.add(`${finished.turnId}:${coach.id}`);
    const before = [queued(coach.id).length, queued(school.id).length];
    await finish(finished, {
      shares: [
        { agentId: coach.id, text: "The offer of Example Corp came." },
        { agentId: school.id, text: "The thesis is approved." },
      ],
    });
    assert.doesNotMatch(prompts.at(-1) ?? "", /"name": "Interview Coach"/u);
    assert.deepEqual([queued(coach.id).length, queued(school.id).length], [before[0], (before[1] ?? 0) + 1]);
  });

  await check("a turn with no answer is not checked", async () => {
    const before = prompts.length;
    await Effect.runPromise(share.turnEnded(turn(main.id, "A fact.", "  ")));
    await Effect.runPromise(
      share.turnEnded({ agentId: main.id, turnId: "turn-empty", said: [], steps: [], answer: "Done." }),
    );
    await checked(main.id);
    assert.equal(prompts.length, before);
  });

  await check("an agent with no teammate that states a remit is not checked", async () => {
    const before = prompts.length;
    store.setHidden(coach.id, new Date().toISOString());
    store.setHidden(school.id, new Date().toISOString());
    const read = new Promise<void>((done) => {
      agentsRead = done;
    });
    await Effect.runPromise(share.turnEnded(turn(main.id, "A fact.", "Done.")));
    await read;
    agentsRead = null;
    store.setHidden(coach.id, null);
    store.setHidden(school.id, null);
    await checked(main.id);
    assert.equal(prompts.length, before);
  });

  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), JSON.stringify({ passed: true, checks }, null, 2));
  process.stdout.write(`news-share-e2e: ${checks.length} checks passed\n`);
} finally {
  await Effect.runPromise(share.dispose());
  database.close();
  await rm(scratch, { recursive: true, force: true });
}
