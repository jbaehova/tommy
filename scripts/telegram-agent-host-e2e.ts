// Run with bun scripts/telegram-agent-host-e2e.ts. The Codex executable and Telegram transport are local fixtures.
// The scratch host uses the production AgentService, provider driver, mailbox and SQLite store.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AGENT_PROVIDERS, type AgentTurnCompletedEvent } from "@tommy/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { CodexAppServerClient } from "../src/backend/app-server-client";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { SidebarLayoutStore } from "../src/backend/sidebar-layout-store";
import { TommyDatabase } from "../src/backend/tommy-database";
import { TelegramAgentHost, type TelegramAgentReply } from "../src/main/telegram-agent-host";

const artifact = resolve(import.meta.dirname, "../.tommy-build/telegram-agent-host-e2e.json");
const telegramId = 41001;
const ownerId = 42001;
const operationId = randomUUID();

function fixtureExecutable(log: string) {
  return `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const { createInterface } = require("node:readline");
if (process.argv.includes("--version")) { console.log("codex-cli 0.160.1"); process.exit(0); }
const write = message => process.stdout.write(JSON.stringify(message) + "\\n");
const pending = new Map();
for (const event of ["SIGTERM", "SIGHUP"]) process.on(event, () => process.exit(0));
createInterface({input:process.stdin}).on("line", line => {
  const packet = JSON.parse(line);
  const { id, method, params = {} } = packet;
  const finishTool = pending.get(id);
  if (finishTool) {
    pending.delete(id);
    finishTool(packet.result?.success === true);
    return;
  }
  if (id === undefined) return;
  const result = value => write({id,result:value});
  switch (method) {
    case "initialize": case "config/batchWrite": return result({});
    case "account/read": return result({account:{type:"chatgpt",email:"test@example.com"}});
    case "account/rateLimits/read": return result({rateLimits:{limitId:"codex",primary:null,secondary:null},rateLimitsByLimitId:null});
    case "model/list": return result({data:[{model:"gpt-6-luna",displayName:"Test model"}]});
    case "plugin/list": return result({marketplaces:[]});
    case "config/read": return result({config:{mcp_servers:{}},layers:[]});
    case "thread/start": return result({thread:{id:randomUUID(),turns:[]}});
    case "thread/read": case "thread/resume": return result({thread:{id:params.threadId,turns:[]}});
    case "thread/turns/list": case "thread/items/list": return result({data:[],nextCursor:null});
    case "thread/unsubscribe": return result({status:"Unsubscribed"});
    case "thread/archive": return result({});
    case "turn/start": {
      const threadId = params.threadId, turnId = randomUUID();
      const input = params.input.map(item => item.text || "").join("\\n");
      const label = Array.from(input.matchAll(/VERIFY_(SEED|OWNER|PRIVATE|AFTER|DELEGATE|WORK|SYNTH|ROUTINE)/g)).at(-1)?.[1] || "OTHER";
      appendFileSync(${JSON.stringify(log)}, label + "\\n");
      result({turn:{id:turnId,status:"inProgress",items:[]}});
      setImmediate(() => {
        write({method:"turn/started",params:{threadId,turn:{id:turnId}}});
        const finish = (ok = true) => {
          write({method:"item/completed",params:{threadId,turnId,item:{id:randomUUID(),type:"agentMessage",phase:"final_answer",text:"Result " + (ok ? label : "FAILED")}}});
          write({method:"turn/completed",params:{threadId,turn:{id:turnId,status:"completed"}}});
        };
        const tool = args => {
          const callId = randomUUID();
          pending.set(callId,finish);
          write({id:callId,method:"item/tool/call",params:{threadId,turnId,namespace:"tommy",tool:"send_message",callId,arguments:args}});
        };
        if (label === "DELEGATE") {
          const recipient = /VERIFY_DELEGATE (agent-[a-zA-Z0-9-]+)/.exec(input)[1];
          tool({recipientAgentIds:[recipient],text:"VERIFY_WORK",expectsReply:true});
        } else if (label === "WORK") {
          const target = /Use recipientAgentIds \\["([^"]+)"\\], replyToMessageId "([^"]+)"/.exec(input);
          if (!target) return finish(false);
          tool({recipientAgentIds:[target[1]], text:"VERIFY_SYNTH",replyToMessageId:target[2],expectsReply:false});
        } else finish();
      });
      return;
    }
    default: return write({id,error:{code:-32601,message:"Unsupported fixture method " + method}});
  }
});
`;
}

const unused = () => Effect.die(new Error("The agent-host check has no browser."));
const browser: AgentBrowserHost = {
  shareTab: () => {},
  unshareThread: () => {},
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

function openHost(scratch: string) {
  const data = join(scratch, "state");
  const database = new TommyDatabase(data);
  const store = new AgentStore(data, join(scratch, "profile"), database);
  const mailbox = new MailboxStore(data, store.sharedRoot, database);
  const sidebar = new SidebarLayoutStore(join(data, "layout.json"));
  const service = new AgentService({
    store,
    mailbox,
    sidebarLayout: sidebar,
    browser,
    preferredProvider: "codex",
    offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
    memoryReviewInterval: () => 0,
    clientFactory: (provider) => {
      assert.equal(provider, "codex");
      return new CodexAppServerClient(join(scratch, "codex"), 5_000);
    },
  });
  const host = new TelegramAgentHost(service, sidebar, mailbox, database);
  const replies: TelegramAgentReply[] = [];
  const completions: AgentTurnCompletedEvent[] = [];
  const changed = new EventEmitter();
  service.on("event", (event) => {
    if (event.type === "turn-completed") completions.push(event);
    changed.emit("change");
  });
  const unsubscribe = host.onReply((reply) => {
    replies.push(reply);
    changed.emit("change");
  });
  function until(label: string, condition: () => boolean) {
    if (condition()) return Promise.resolve();
    return new Promise<void>((done, reject) => {
      const timer = setTimeout(() => {
        changed.off("change", check);
        reject(new Error(`Timed out waiting for ${label}`));
      }, 15_000);
      function check() {
        if (!condition()) return;
        clearTimeout(timer);
        changed.off("change", check);
        done();
      }
      changed.on("change", check);
    });
  }
  return {
    service,
    mailbox,
    host,
    replies,
    completions,
    until,
    async start() {
      await runCauseEffect(sidebar.initialize());
      await runCauseEffect(service.initialize());
    },
    async close() {
      unsubscribe();
      try {
        await runCauseEffect(service.stop());
      } finally {
        database.close();
      }
    },
  };
}

async function fixture(scratch: string) {
  const turns = join(scratch, "turns.log");
  await writeFile(turns, "");
  await writeFile(join(scratch, "codex"), fixtureExecutable(turns), { mode: 0o700 });
  const request = "VERIFY_OWNER";
  let current = openHost(scratch);
  try {
    await current.start();
    const agent = await runCauseEffect(current.host.ensureAgent(operationId, "Test agent", "VERIFY_SEED"));
    await current.until("the initial turn", () => current.completions.some((event) => event.agentId === agent));
    assert.equal(current.replies.length, 0);
    await runCauseEffect(current.host.submit(agent, telegramId, ownerId, 71, request));
    await current.until("the Telegram answer", () => current.replies.length === 1);
    const reply = current.replies[0];
    assert.ok(reply);
    assert.equal(reply.text, "Result OWNER");
    assert.equal(reply.agentId, agent);
    assert.equal(reply.telegramId, telegramId);
    assert.equal(reply.ownerId, ownerId);
    assert.equal(reply.image, null);
    assert.ok(current.host.ownsTurn(agent, reply.turnId, telegramId, ownerId));
    assert.ok(!current.host.ownsTurn(agent, reply.turnId, telegramId, ownerId + 1));
    await runCauseEffect(current.host.submit(agent, telegramId, ownerId, 71, request));
    const mark = current.completions.length;
    await runCauseEffect(current.service.sendMessage({ agentId: agent, text: "VERIFY_PRIVATE" }));
    await current.until("the private turn", () => current.completions.length > mark);
    const privateTurn = current.completions.at(-1);
    assert.ok(privateTurn && !current.host.ownsTurn(agent, privateTurn.turnId, telegramId, ownerId));
    assert.deepEqual(
      current.replies.map((item) => item.text),
      ["Result OWNER"],
    );
    await current.close();
    current = openHost(scratch);
    await current.start();
    assert.equal(await runCauseEffect(current.host.ensureAgent(operationId, "Test agent", "VERIFY_SEED")), agent);
    assert.ok(current.host.ownsTurn(agent, reply.turnId, telegramId, ownerId));
    await runCauseEffect(current.host.submit(agent, telegramId, ownerId, 71, request));
    await runCauseEffect(current.host.submit(agent, telegramId, ownerId, 72, "VERIFY_AFTER"));
    await current.until("the post-restart answer", () => current.replies.length > 0);
    assert.deepEqual(
      current.replies.map((item) => item.text),
      ["Result AFTER"],
    );
    const second = await runCauseEffect(current.host.ensureAgent(randomUUID(), "Peer", "Second agent setup"));
    await current.until("the peer setup turn", () => current.completions.some((event) => event.agentId === second));
    // Agents of a Telegram owner talk inside Tommy. The runtime shows these notices in each bot's chat.
    const notices: { from: string; to: string[]; text: string }[] = [];
    const stopNotices = current.mailbox.onAgentMessage((notice) =>
      notices.push({ from: notice.senderAgentId, to: notice.recipientAgentIds, text: notice.text }),
    );
    try {
      await runCauseEffect(current.host.submit(agent, telegramId, ownerId, 73, `VERIFY_DELEGATE ${second}`));
      await current.until("the owner's synthesis after an internal delegation", () =>
        current.replies.some((reply) => reply.text === "Result SYNTH"),
      );
      assert.ok(current.replies.every((reply) => reply.agentId === agent && reply.ownerId === ownerId));
      assert.ok(current.replies.every((reply) => reply.telegramId === telegramId));
      const work = current.completions.findLast((event) => event.agentId === second);
      assert.ok(work);
      // A delegated agent's browser request reaches the owner's chat. Its answer never goes there directly.
      assert.equal(current.host.tracedChat(second, work.turnId, ownerId), telegramId);
      assert.equal(current.host.tracedChat(second, work.turnId, ownerId + 1), null);
      assert.ok(!current.host.ownsTurn(second, work.turnId, telegramId, ownerId));
      assert.equal(current.host.tracedChat(agent, privateTurn.turnId, ownerId), null);
      assert.deepEqual(
        notices.map((notice) => [notice.from, notice.to, notice.text]),
        [
          [agent, [second], "VERIFY_WORK"],
          [second, [agent], "VERIFY_SYNTH"],
        ],
      );
    } finally {
      stopNotices();
    }
    // A scheduled routine's result goes to the agent's own chat, as it did in the app.
    current.host.setRoutineChat((id) => (id === agent ? { telegramId, ownerId } : null));
    const routine = current.service.createRoutine({
      agentId: agent,
      name: "Briefing",
      instruction: "VERIFY_ROUTINE",
      active: true,
      timezone: "UTC",
      schedule: { kind: "daily", time: "03:00" },
    });
    const beforeRoutine = current.replies.length;
    await runCauseEffect(current.service.testRoutine({ agentId: agent, routineId: routine.id }));
    await current.until("the routine result in the agent's chat", () =>
      current.replies.slice(beforeRoutine).some((reply) => reply.text === "Result ROUTINE"),
    );
    const routineReply = current.replies.at(-1);
    assert.ok(routineReply && routineReply.telegramId === telegramId && routineReply.agentId === agent);
    assert.ok(current.host.ownsTurn(agent, routineReply.turnId, telegramId, ownerId));
    assert.ok(!current.host.ownsTurn(agent, routineReply.turnId, telegramId + 1, ownerId));
    current.host.setRoutineChat(() => null);
    assert.ok(!current.host.ownsTurn(agent, routineReply.turnId, telegramId, ownerId));
    const starts = readFileSync(turns, "utf8").trim().split("\n");
    for (const label of ["SEED", "OWNER", "PRIVATE", "AFTER", "DELEGATE", "WORK", "SYNTH", "ROUTINE"]) {
      assert.equal(
        starts.filter((start) => start === label).length,
        1,
        `${label} must have exactly one provider turn.`,
      );
    }
  } finally {
    await current.close();
  }
}

if (process.argv[2] === "--isolated-host") {
  const scratch = process.argv[3];
  assert.ok(scratch);
  await fixture(scratch);
} else {
  const scratch = await mkdtemp(join(tmpdir(), "tommy-telegram-host-"));
  const profile = join(scratch, "profile");
  await mkdir(profile);
  let passed = false;
  try {
    // A new process receives its own empty profile and no inherited account credentials.
    execFileSync(process.execPath, [import.meta.path, "--isolated-host", scratch], {
      env: {
        PATH: process.env.PATH,
        HOME: profile,
        CODEX_HOME: join(profile, ".codex"),
        TOMMY_CODEX_PATH: join(scratch, "codex"),
      },
      stdio: "inherit",
      timeout: 90_000,
    });
    passed = true;
  } finally {
    await mkdir(dirname(artifact), { recursive: true });
    await writeFile(
      artifact,
      `${JSON.stringify(
        {
          passed,
          real: ["AgentService", "SQLite", "mailbox", "Codex stdio driver", "TelegramAgentHost"],
          fixtures: ["Local provider executable", "Telegram send and receipt delivery"],
          checks: [
            "owner result",
            "turn provenance",
            "local turn isolation",
            "live replay",
            "restart replay",
            "stable profile operation",
            "internal agent request and answer",
            "root agent relays the synthesis to the owner",
            "agent message notices for bot chats",
            "delegated browser requests trace to the owner's chat",
            "routine results go to the agent's own chat",
          ],
        },
        null,
        2,
      )}\n`,
    );
    await rm(scratch, { recursive: true, force: true });
  }
  process.stdout.write("Telegram agent host E2E passed.\n");
}
