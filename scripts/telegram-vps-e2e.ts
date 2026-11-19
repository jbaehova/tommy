// Run: bun scripts/telegram-vps-e2e.ts
// Exercise the VPS through its HTTP entry with a private directory. Telegram HTTP and the agent
// runner are stand-ins. The report contains check names and counts only.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDynamicRecord } from "@tommy/contracts/runtime-values";
import { Effect, Schema } from "effect";
import { TelegramApi } from "../src/main/telegram-api";
import { TelegramDirectory } from "../src/main/telegram-directory";
import { TelegramVps } from "../src/main/telegram-vps";
import type { WorkflowConnectorFetch } from "../src/main/workflow-connector-http";

const reportPath = resolve(import.meta.dirname, "../.tommy-build/telegram-vps-e2e.json");
const publicOrigin = "https://tommy.example.com";
const manager = { id: 41001, is_bot: true, first_name: "Manager", username: "example_manager_bot" };
const planner = { id: 41002, is_bot: true, first_name: "Planner", username: "example_planner_bot" };
const builder = { id: 41003, is_bot: true, first_name: "Builder", username: "example_builder_bot" };
const helper = { id: 41004, is_bot: true, first_name: "Helper Agent", username: "example_helper_bot" };
const writer = { id: 41005, is_bot: true, first_name: "Writer", username: "example_writer_bot" };
const analyst = { id: 41006, is_bot: true, first_name: "Analyst", username: "example_analyst_bot" };
const owner = { id: 51001, is_bot: false, first_name: "Owner", language_code: "en" };
const stranger = { id: 51002, is_bot: false, first_name: "Other" };
const accounts = [manager, planner, builder, helper, writer, analyst];
const tokens = new Map(
  accounts.map((account) => [account.id, `${account.id}:${randomBytes(30).toString("base64url")}`]),
);
const webhooks = new Map<number, string>();
const wire: { from: number; to: number | string; text: string }[] = [];
const checks: string[] = [];
let phase = "setup";
let updateId = 100;
let ready = true;
let pendingManagerUpdates = 0;

function check(name: string, ok: boolean) {
  assert.ok(ok, name);
  checks.push(name);
}

function tokenFor(id: number) {
  const token = tokens.get(id);
  assert.ok(token, "Unknown test account");
  return token;
}

type Account = (typeof accounts)[number];
type Sender = Pick<Account, "id" | "is_bot" | "first_name">;

/** Match the Bot API route and use only the in-memory response. Never make an outbound request. */
const telegramHttp: WorkflowConnectorFetch = async (url, init) => {
  const target = new URL(url);
  assert.ok(
    target.origin === "https://api.telegram.org" && init.method === "POST",
    "Unexpected Telegram API origin or method",
  );
  const account = accounts.find((candidate) => target.pathname.startsWith(`/bot${tokenFor(candidate.id)}/`));
  assert.ok(account, "Unknown outgoing Telegram identity");
  const method = target.pathname.split("/").at(-1);
  const body =
    typeof init.body === "string" ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(init.body) : null;
  assert.ok(isDynamicRecord(body), "Expected a JSON request");
  switch (method) {
    case "getMe":
      return Response.json({ ok: true, result: { ...account, can_manage_bots: account.id === manager.id } });
    case "getManagedBotToken":
      assert.ok(
        account.id === manager.id && typeof body.user_id === "number",
        "Only the manager can request agent tokens",
      );
      return Response.json({ ok: true, result: tokenFor(body.user_id) });
    case "setWebhook":
      assert.ok(
        body.url === `${publicOrigin}/tommy/telegram/update/${account.id}` &&
          typeof body.secret_token === "string" &&
          body.secret_token.length > 0,
        "Webhook registration did not bind a private credential to this bot",
      );
      webhooks.set(account.id, body.secret_token);
      return Response.json({ ok: true, result: true });
    case "setMyCommands":
      return Response.json({ ok: true, result: true });
    case "getWebhookInfo":
      return Response.json({
        ok: true,
        result: {
          url: `${publicOrigin}/tommy/telegram/update/${account.id}`,
          allowed_updates: ["message", "managed_bot"],
          pending_update_count: pendingManagerUpdates,
        },
      });
    case "sendMessage":
      assert.ok(
        (typeof body.chat_id === "string" || typeof body.chat_id === "number") && typeof body.text === "string",
        "Missing Telegram recipient or message",
      );
      wire.push({ from: account.id, to: body.chat_id, text: body.text });
      return Response.json({ ok: true, result: { message_id: wire.length } });
    default:
      throw new Error("Unexpected Telegram API call");
  }
};

const agentIds = new Map<string, string>();
const rootAgentId = randomUUID();
const helperAgentId = randomUUID();
agentIds.set("root", rootAgentId);
agentIds.set("helper", helperAgentId);
const fixedAgents: string[] = [rootAgentId, helperAgentId];
const submissions: { agentId: string; telegramId: number; ownerId: number; updateId: number; text: string }[] = [];
const roles = new Map<string, string>();
const spareNames = new Map<string, string>();
const deletedAgents: string[] = [];
const agents = {
  remove: (agentId: string) =>
    Effect.sync(() => {
      deletedAgents.push(agentId);
      spareNames.delete(agentId);
    }),
  describe: (_operationId: string, agentId: string, description: string) =>
    Effect.sync(() => {
      roles.set(agentId, description);
      return undefined;
    }),
  ensureAgent: (operationId: string, _name: string, _initialMessage: string, description?: string) =>
    Effect.sync(() => {
      const id = agentIds.get(operationId) ?? randomUUID();
      agentIds.set(operationId, id);
      if (description) roles.set(id, description);
      return id;
    }),
  submit: (agentId: string, telegramId: number, ownerId: number, updateId: number, text: string) =>
    Effect.sync(() => {
      submissions.push({ agentId, telegramId, ownerId, updateId, text });
      return undefined;
    }),
  isAvailable: (agentId: string) => [...agentIds.values()].includes(agentId) || spareNames.has(agentId),
  choices: () => [
    { id: rootAgentId, name: "Root Agent" },
    { id: helperAgentId, name: "Helper Agent" },
    ...[...spareNames].map(([id, name]) => ({ id, name })),
  ],
};

const profile = await mkdtemp(join(tmpdir(), "tommy-telegram-vps-"));
function openHost() {
  const directory = new TelegramDirectory(join(profile, "telegram.json"), manager.id, owner.id);
  const service = new TelegramVps({
    settings: { token: tokenFor(manager.id), managerId: manager.id, ownerId: owner.id, publicOrigin },
    api: new TelegramApi(telegramHttp),
    directory,
    agents,
    ready: () => ready,
  });
  return { directory, service };
}

let host = openHost();
const server = createServer((req, res) => {
  void Effect.runPromise(host.service.handle(req, res))
    .then((handled) => {
      if (!handled) res.writeHead(404).end();
    })
    .catch(() => res.writeHead(500).end());
});
let origin = "";

/** Telegram's view of a private conversation: the receiving bot sees the peer as chat.id. */
function message(from: Sender, text: string, chatId = from.id, chatType = "private") {
  const id = ++updateId;
  return { update_id: id, message: { message_id: id, from, chat: { id: chatId, type: chatType }, text } };
}

function managed(bot: Account, user: Sender = owner) {
  return { update_id: ++updateId, managed_bot: { bot, user } };
}

async function post(
  to: Account,
  body: ReturnType<typeof managed> | ReturnType<typeof message>,
  secret = webhooks.get(to.id),
) {
  assert.ok(secret, "Missing registered webhook");
  const response = await fetch(`${origin}/tommy/telegram/update/${to.id}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  await response.arrayBuffer();
  return response.status;
}

async function restartHost() {
  host.service.close();
  host = openHost();
  await Effect.runPromise(host.service.start());
  await Effect.runPromise(host.service.checkManager());
}

async function register(bot: Account) {
  const creation = managed(bot);
  assert.equal(await post(manager, creation), 200);
  assert.equal(await post(manager, creation), 200);
  check(
    `${bot.first_name} received one binding`,
    host.directory.list().filter((entry) => entry.id === bot.id).length === 1 &&
      host.directory.get(bot.id)?.ownerConfirmed === true,
  );
  check(
    `${bot.first_name} registered a distinct webhook credential`,
    webhooks.has(bot.id) && webhooks.get(bot.id) !== webhooks.get(manager.id),
  );
  const before = submissions.length;
  await post(bot, message(owner, "Hello right after creation"));
  check(
    `${bot.first_name} chats right after creation with its own new agent`,
    submissions.length === before + 1 &&
      submissions[before]?.telegramId === bot.id &&
      submissions[before]?.agentId === host.directory.get(bot.id)?.agentId &&
      !fixedAgents.includes(submissions[before]?.agentId ?? ""),
  );
  submissions.splice(before);
  await post(bot, message({ ...stranger, is_bot: true }, "Peer request"));
  await post(bot, message(manager, "Manager request"));
  check(`${bot.first_name} ignores messages from bots`, submissions.length === before);
}

let passed = false;
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  await Effect.runPromise(host.service.start());
  check("Manager webhook installed", webhooks.has(manager.id));
  phase = "creation and activation";
  await register(planner);
  await register(builder);
  const plannerId = host.directory.get(planner.id)?.agentId;
  const builderId = host.directory.get(builder.id)?.agentId;
  check(
    "Managed identities have distinct persistent agents",
    Boolean(plannerId && builderId && plannerId !== builderId),
  );

  phase = "private owner routing";
  const ownerTurn = message(owner, "Prepare a short outline");
  const invalid = await post(planner, ownerTurn, "invalid_example_webhook_secret");
  const crossBot = await post(planner, ownerTurn, webhooks.get(builder.id));
  check("Webhook credentials are required and scoped to one bot", invalid === 403 && crossBot === 403);
  await post(planner, message(stranger, "Untrusted user"));
  await post(planner, message(owner, "Group request", -31001, "group"));
  await post(planner, message(owner, "Different chat", stranger.id));
  check("Wrong secrets, other people and other chats cannot submit work", submissions.length === 0);
  ready = false;
  const starting = await post(planner, ownerTurn);
  check(
    "A server that is starting asks Telegram to retry the owner turn",
    starting === 503 && submissions.length === 0,
  );
  ready = true;
  const duplicates = await Promise.all([post(planner, ownerTurn), post(planner, ownerTurn)]);
  assert.ok(duplicates.every((status) => status === 200));
  const first = submissions[0];
  check(
    "Concurrent duplicate delivery reaches the selected agent once",
    submissions.length === 1 &&
      first?.ownerId === owner.id &&
      first.telegramId === planner.id &&
      first.agentId === plannerId &&
      first.updateId === ownerTurn.update_id &&
      first.text === ownerTurn.message.text,
  );

  phase = "messages from bots";
  await post(builder, message(planner, "Check the status page"));
  await post(manager, message(builder, "Check the status page"));
  check("A bot cannot start a turn for another agent", submissions.length === 1);

  phase = "restart and transfer";
  pendingManagerUpdates = 1;
  await restartHost();
  const delayed = await post(builder, message(owner, "Work while ownership changes are queued"));
  check(
    "A restored host waits for ownership updates before accepting work",
    delayed === 503 && submissions.length === 1,
  );
  check("The manager still accepts updates during recovery", (await post(manager, message(owner, "/agents"))) === 200);
  pendingManagerUpdates = 0;
  await Effect.runPromise(host.service.checkManager());
  check(
    "The same two agents are available after a server restart",
    host.directory.get(planner.id)?.agentId === plannerId &&
      host.directory.get(builder.id)?.agentId === builderId &&
      host.directory.get(planner.id)?.ownerConfirmed === true &&
      host.directory.get(builder.id)?.ownerConfirmed === true,
  );
  await post(planner, ownerTurn);
  check("Old updates cannot submit twice after restart", submissions.length === 1);
  await post(builder, message(owner, "Prepare an example"));
  check("The second bot uses its own agent", submissions.length === 2 && submissions[1]?.agentId === builderId);
  const transfer = managed(planner, stranger);
  await post(manager, transfer);
  await post(planner, message(owner, "Removed access"));
  await post(planner, message(stranger, "Transferred bot"));
  check(
    "Transferring ownership disconnects the existing binding",
    !host.directory.get(planner.id) && submissions.length === 2,
  );
  await restartHost();
  const removed = await post(planner, message(owner, "Removed access after restart"));
  check(
    "Revoked ownership stays revoked after restart",
    removed === 404 && !host.directory.get(planner.id) && submissions.length === 2,
  );

  phase = "manager chat";
  const before = submissions.length;
  const pickOffset = wire.length;
  await post(manager, message(owner, "Hello before a choice"));
  check(
    "The manager asks for an agent before the owner chooses one",
    submissions.length === before &&
      wire.slice(pickOffset).some((item) => item.from === manager.id && item.to === owner.id),
  );
  await post(manager, message(owner, "/root root agent"));
  check("The owner chooses the root agent", host.directory.managerAgent()?.agentId === rootAgentId);
  await post(manager, message(stranger, "Not the owner"));
  await post(manager, message(owner, "Group text", -31002, "group"));
  check("Other people and groups cannot use the manager chat", submissions.length === before);
  const chat = message(owner, "Hello from the manager chat");
  await Promise.all([post(manager, chat), post(manager, chat)]);
  const managerTurn = submissions.at(-1);
  check(
    "A manager chat message reaches the chosen agent once",
    submissions.length === before + 1 &&
      managerTurn?.agentId === rootAgentId &&
      managerTurn.telegramId === manager.id &&
      managerTurn.ownerId === owner.id &&
      managerTurn.text === chat.message.text,
  );
  await post(manager, message(owner, "/agents"));
  check("Manager commands do not start a turn", submissions.length === before + 1);
  await restartHost();
  await post(manager, message(owner, "Hello after restart"));
  check(
    "The manager chat agent stays chosen after a restart",
    submissions.length === before + 2 && submissions.at(-1)?.agentId === rootAgentId,
  );

  phase = "agent bots";
  const connectOffset = wire.length;
  await post(manager, message(owner, "/connect"));
  const offer = wire.slice(connectOffset).find((item) => item.from === manager.id && item.to === owner.id);
  check("The manager offers a bot for each agent without one", Boolean(offer));
  const created = managed(helper);
  await post(manager, created);
  check(
    "A bot named like an existing agent connects to that agent",
    host.directory.get(helper.id)?.agentId === helperAgentId &&
      !agentIds.has(host.directory.get(helper.id)?.operationId ?? ""),
  );
  const helperTurn = message(owner, "Hello helper");
  await post(helper, helperTurn);
  check(
    "The existing agent answers in its own chat at once",
    submissions.at(-1)?.agentId === helperAgentId && submissions.at(-1)?.telegramId === helper.id,
  );

  phase = "new agent role";
  await post(manager, message(owner, "/new"));
  const askOffset = wire.length;
  await post(manager, managed(writer));
  const writerId = host.directory.get(writer.id)?.agentId ?? "";
  check(
    "A new agent without a role makes the manager ask for one",
    wire.slice(askOffset).some((item) => item.from === manager.id && item.text.includes("What does Writer do")),
  );
  const answered = submissions.length;
  await post(manager, message(owner, "Writes release notes"));
  check(
    "The answer becomes the role and reaches the new agent in its own chat",
    roles.get(writerId) === "Writes release notes" &&
      submissions.length === answered + 1 &&
      submissions.at(-1)?.agentId === writerId &&
      submissions.at(-1)?.telegramId === writer.id &&
      Boolean(submissions.at(-1)?.text.includes("Writes release notes")),
  );
  await post(manager, message(owner, "Back to the root agent"));
  check("The next message goes to the root agent again", submissions.at(-1)?.agentId === rootAgentId);
  await post(manager, message(owner, "/new Summarizes stock news"));
  const givenOffset = wire.length;
  await post(manager, managed(analyst));
  const analystId = host.directory.get(analyst.id)?.agentId ?? "";
  check(
    "A role given with /new is saved at creation without a question",
    roles.get(analystId) === "Summarizes stock news" &&
      !wire.slice(givenOffset).some((item) => item.text.includes("What does Analyst do")),
  );

  phase = "delete an agent without a chat";
  const lastCode = (offset: number) =>
    [
      ...wire
        .slice(offset)
        .map((item) => item.text)
        .join("\n")
        .matchAll(/\/delete Spare Agent ([0-9a-f]{6})/g),
    ].at(-1)?.[1];
  await post(manager, message(owner, "/delete root agent"));
  check("The root agent cannot be deleted from the manager chat", deletedAgents.length === 0);
  const hasChatOffset = wire.length;
  await post(manager, message(owner, "/delete helper agent"));
  check(
    "An agent with a chat is deleted from its own chat",
    deletedAgents.length === 0 && wire.slice(hasChatOffset).some((item) => item.text.includes("@example_helper_bot")),
  );
  const spareId = randomUUID();
  spareNames.set(spareId, "Spare Agent");
  const deleteOffset = wire.length;
  await post(manager, message(owner, "/delete spare agent"));
  check(
    "Deleting an agent without a chat asks for a code first",
    Boolean(lastCode(deleteOffset)) && deletedAgents.length === 0,
  );
  await post(manager, message(owner, "/delete Spare Agent 000000"));
  check("A wrong code does not delete the agent", deletedAgents.length === 0);
  await post(manager, message(owner, "/delete spare agent"));
  await post(manager, message(owner, `/delete Spare Agent ${lastCode(deleteOffset)}`));
  check("The code deletes the agent without a chat", deletedAgents.length === 1 && deletedAgents[0] === spareId);
  passed = true;
} finally {
  host.service.close();
  server.closeAllConnections();
  await new Promise<void>((success) => server.close(() => success()));
  await rm(profile, { recursive: true, force: true });
  await mkdir(resolve(import.meta.dirname, "../.tommy-build"), { recursive: true });
  await writeFile(
    reportPath,
    `${JSON.stringify({ passed, phase, checks, submittedTurns: submissions.length }, null, 2)}\n`,
  );
}
process.stdout.write(`Passed ${checks.length} Telegram VPS checks.\n`);
