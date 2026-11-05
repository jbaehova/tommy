#!/usr/bin/env bun
// Sends the context of a session on this computer to one agent on the Tommy host. The skill in
// ~/.agents/skills/tommy-handoff writes the summary and gives it to this command on standard input.
//
// This command is a separate paired device, so it does not replace the connection of the Mac app. The
// private key is in a file that a key in the macOS Keychain encrypts. To stop its access, revoke the
// device in Settings > Devices.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseDirectPairingLink } from "@tommy/contracts/direct-connection";
import { INPUT_LIMITS } from "@tommy/contracts/input-limits";
import { isDynamicRecord, isString } from "@tommy/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@tommy/contracts/team-api-routes";
import { redactText } from "@tommy/logging";
import { Effect } from "effect";
import { DirectClientBridge } from "../src/main/direct-client-bridge";
import { DirectPairedServer } from "../src/main/direct-paired-server";
import { TeamWebRtcClientTransport } from "../src/main/team-webrtc-client-transport";

const KEYCHAIN_SERVICE = "tommy-handoff";
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** A handoff can be long, and the host answers only after it stored the message. */
const REQUEST_TIMEOUT_MS = 60_000;

const USAGE = `Usage:
  tommy-handoff pair <tommy://pair link>
  tommy-handoff pair <address> <code>
  tommy-handoff agents [--json]
  tommy-handoff send --agent <id> --mode <work|record> [--source <text>] < summary
  tommy-handoff unpair`;

const HEADERS = {
  work: "[Context handoff] This summary comes from a session on the user's Mac. Treat it as the context of that session and continue from its next step. You run on another computer: paths in it are on the Mac, and you cannot read that session.",
  record:
    "[Context handoff: record only] This summary comes from a session on the user's Mac. Keep it as a record. Do not start the work or change anything. Answer with one short confirmation, and use it when the user asks about it later.",
} as const;
type HandoffMode = keyof typeof HEADERS;

const stateDirectory = () => process.env.TOMMY_HANDOFF_STATE_DIR ?? join(homedir(), ".config", "tommy-handoff");

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** `security -i` reads its command on standard input, so that the key is not in a process list. */
async function storeKeychainKey(key: string): Promise<void> {
  const child = Bun.spawn(["security", "-i"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  child.stdin.write(`add-generic-password -U -a ${KEYCHAIN_SERVICE} -s ${KEYCHAIN_SERVICE} -w ${key}\n`);
  await child.stdin.end();
  await child.exited;
  // `security -i` exits with 0 when a command in it fails, so only a read proves the write.
  if ((await readKeychainKey()) !== key) fail("The Keychain did not store the key.");
}

async function readKeychainKey(): Promise<string | null> {
  const child = Bun.spawn(["security", "find-generic-password", "-a", KEYCHAIN_SERVICE, "-s", KEYCHAIN_SERVICE, "-w"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const value = (await new Response(child.stdout).text()).trim();
  return (await child.exited) === 0 && value ? value : null;
}

/** A test uses `TOMMY_HANDOFF_TEST_KEY`, because a headless check cannot open the Keychain. */
async function cipherKey(create: boolean): Promise<Buffer> {
  const testKey = process.env.TOMMY_HANDOFF_TEST_KEY;
  if (testKey) return Buffer.from(testKey, "hex");
  const stored = await readKeychainKey();
  if (stored) return Buffer.from(stored, "hex");
  if (!create) fail("This computer is not paired. Run: tommy-handoff pair <link>");
  const key = randomBytes(32).toString("hex");
  await storeKeychainKey(key);
  return Buffer.from(key, "hex");
}

function pairedServer(key: Buffer): DirectPairedServer {
  return new DirectPairedServer({
    path: join(stateDirectory(), "pairing.enc"),
    allowLoopbackHttp: process.env.TOMMY_HANDOFF_ALLOW_LOOPBACK === "1",
    deviceName: () => `T3 handoff (${hostname()})`,
    encrypt: (value) => {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decrypt: (value) => {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, IV_BYTES));
      decipher.setAuthTag(value.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([decipher.update(value.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
    },
  });
}

/** Opens one connection, runs `work`, and closes the connection. */
async function withHost<T>(
  work: (request: (path: string, init?: { method: string; body: object }) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const server = pairedServer(await cipherKey(false));
  await Effect.runPromise(server.load());
  if (!server.paired) fail("This computer is not paired. Run: tommy-handoff pair <link>");
  const source = server.transportSource;
  const [host] = await Effect.runPromise(source.listHosts());
  if (!host?.devicePublicKey) fail("The pairing holds no host key. Pair again.");
  const transferDirectory = await mkdtemp(join(tmpdir(), "tommy-handoff-"));
  const transport = new TeamWebRtcClientTransport({
    bridge: new DirectClientBridge(),
    ...source,
    getPrincipalId: () => "local-owner",
    transferDirectory,
  });
  transport.pinHostKey(host.hostId, host.devicePublicKey);
  try {
    await Effect.runPromise(transport.connect(host.hostId));
    return await work((path, init) =>
      Effect.runPromise(transport.request(host.hostId, path, { ...init, timeoutMs: REQUEST_TIMEOUT_MS })),
    );
  } finally {
    await Effect.runPromise(Effect.ignore(transport.stop()));
    await rm(transferDirectory, { recursive: true, force: true });
  }
}

function agentsOf(value: unknown): { id: string; name: string; provider: string | null }[] {
  if (!Array.isArray(value)) fail("The host sent an invalid agent list.");
  return value.flatMap((agent) =>
    isDynamicRecord(agent) && isString(agent.id) && isString(agent.name)
      ? [{ id: agent.id, name: agent.name, provider: isString(agent.provider) ? agent.provider : null }]
      : [],
  );
}

async function pair(args: string[]): Promise<void> {
  const [first, second] = args;
  if (!first) fail(USAGE);
  const link = parseDirectPairingLink(first);
  const address = link?.url ?? first;
  const code = link?.code ?? second;
  if (!code) fail(USAGE);
  const server = pairedServer(await cipherKey(true));
  const { hostId } = await Effect.runPromise(server.pair({ address, code }));
  process.stdout.write(`Paired with host ${hostId}.\n`);
}

async function listAgents(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
  const agents = await withHost(async (request) => agentsOf(await request(TEAM_API_ROUTES.agents.all)));
  if (values.json) {
    process.stdout.write(`${JSON.stringify(agents, null, 2)}\n`);
    return;
  }
  for (const agent of agents) process.stdout.write(`${agent.id}\t${agent.name}\t${agent.provider ?? ""}\n`);
}

function isHandoffMode(value: string | undefined): value is HandoffMode {
  return value === "work" || value === "record";
}

async function send(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { agent: { type: "string" }, mode: { type: "string" }, source: { type: "string" } },
  });
  const { agent: agentId, mode, source } = values;
  if (!agentId || !isHandoffMode(mode)) fail(USAGE);
  const summary = (await Bun.stdin.text()).trim();
  if (!summary) fail("The summary on standard input is empty.");
  const sourceLine = source ? `Source: ${source}\n` : "";
  const text = redactText(`${HEADERS[mode]}\n${sourceLine}\n${summary}`);
  if (text.length > INPUT_LIMITS.messageText)
    fail(`The summary has ${text.length} characters, and the limit is ${INPUT_LIMITS.messageText}. Make it shorter.`);
  // The same text gets the same ID, so that a repeated command does not make a second message.
  const clientMessageId = createHash("sha256").update(text).digest("hex").slice(0, 32);
  await withHost((request) =>
    request(TEAM_API_ROUTES.agent.messages(agentId), {
      method: "POST",
      body: {
        text,
        attachmentDraftIds: [],
        replyToMessageId: null,
        clientMessageId,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    }),
  );
  const redactions = text.split("[redacted]").length - 1;
  process.stdout.write(
    `Sent ${text.length} characters to agent ${agentId} (mode: ${mode}, redactions: ${redactions}).\n`,
  );
}

async function unpair(): Promise<void> {
  const server = pairedServer(await cipherKey(false));
  await Effect.runPromise(server.forget());
  process.stdout.write("The key is removed from this computer. Revoke the device in Settings > Devices.\n");
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (args: string[]) => Promise<void>> = {
  pair,
  agents: listAgents,
  send,
  unpair,
};
const run = command ? commands[command] : undefined;
if (!run) fail(USAGE);
try {
  await run(rest);
  // A closed connection can leave a timer of the transport, and this command has nothing more to do.
  process.exit(0);
} catch (cause) {
  // An error of a connection can hold its address and device ID, so only its redacted text goes out.
  fail(`The handoff failed: ${redactText(cause instanceof Error ? cause.message : String(cause))}`);
}
