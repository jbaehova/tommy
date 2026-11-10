// Checks the direct connection on a real host: a real `TeamApiServer` and team store on a temporary
// profile, with `DirectHostGateway` and real WebSockets on loopback. A client pairs with a one-time
// code, proves its key, reads the Team API, and is replaced and revoked. The reverse proxy that holds
// TLS is not in this check.
// Run: `bun scripts/direct-connection-e2e.ts`.
// Writes .tommy-build/direct-connection-e2e/report.json.
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createDirectPairingLink,
  DIRECT_CLOSE_DEVICE_REVOKED,
  DIRECT_CLOSE_REPLACED,
  DIRECT_CONNECT_PATH,
  DIRECT_DEVICE_QUERY,
  DIRECT_FILES_PATH,
  DIRECT_FILES_TOKEN_QUERY,
  DIRECT_PAIR_PATH,
  DIRECT_SESSION_EXPIRES_AT_SECONDS,
  DirectHello,
  DirectPairResponse,
  decodeDirectFrame,
  directConnectionBinding,
  directSessionId,
  encodeDirectFrame,
  parseDirectPairingLink,
} from "@tommy/contracts/direct-connection";
import { HOST_VOICE_ROUTES } from "@tommy/contracts/host-voice";
import { decodeHostDevicePairing, decodeHostDevices, type HostStatus } from "@tommy/contracts/ipc";
import { TEAM_API_ROUTES } from "@tommy/contracts/team-api-routes";
import { HOST_DEVICES_CAPABILITY, HOST_DEVICES_ROUTES } from "@tommy/contracts/team-protocol/host-devices-v1";
import type { TeamProtocolV2Json } from "@tommy/contracts/team-protocol/v2";
import { encodeTeamProtocolV2Frame, teamProtocolV2AuthenticationTranscript } from "@tommy/contracts/team-protocol/v2";
import { TEAM_LONG_CAPABILITY_LISTS_CAPABILITY } from "@tommy/contracts/team-protocol/v9";
import { createEd25519Identity } from "@tommy/team-client/ed25519";
import {
  createRemoteTeamPeer,
  type RemoteFileUpload,
  type RemoteTeamConnectionUpdate,
} from "@tommy/team-client/remote-peer";
import { plugin } from "bun";
import { Effect, Result, Schema } from "effect";
import WebSocket from "ws";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { SidebarLayoutStore } from "../src/backend/sidebar-layout-store";
import { TommyDatabase } from "../src/backend/tommy-database";
import type { TeamApiBrowser } from "../src/main/team-api/dependencies";

const OUT = resolve(import.meta.dirname, "../.tommy-build/direct-connection-e2e");
const STEP_DEADLINE_MS = 20_000;
const HOST_VERSION = "0.0.0-e2e";

// The main process imports Electron for its windows and IPC. No check here opens a window.
plugin({
  name: "direct-connection-electron-boundary",
  setup(build) {
    class Inert {}
    build.module("electron", () => ({
      loader: "object",
      exports: {
        app: { getPath: () => tmpdir(), getVersion: () => HOST_VERSION, isPackaged: false, on: () => undefined },
        BrowserWindow: Object.assign(class extends Inert {}, { getAllWindows: () => [] }),
        MessageChannelMain: class extends Inert {},
        Notification: Object.assign(class extends Inert {}, { isSupported: () => false }),
        clipboard: {},
        dialog: {},
        ipcMain: { handle: () => undefined, removeHandler: () => undefined, on: () => undefined },
        nativeImage: {},
        net: {},
        powerMonitor: { on: () => undefined },
        safeStorage: { isEncryptionAvailable: () => false },
        screen: {},
        session: {},
        shell: { openExternal: async () => undefined },
        systemPreferences: {},
        webContents: { getAllWebContents: () => [] },
      },
    }));
  },
});
const { TeamApiServer } = await import("../src/main/team-api-server");
const { TeamStore } = await import("../src/main/team-store");
const { DirectDeviceStore } = await import("../src/main/direct-device-store");
const { DirectHostGateway } = await import("../src/main/direct-host-gateway");
const { ServerMode } = await import("../src/main/server-mode");
const { DirectClientBridge } = await import("../src/main/direct-client-bridge");
const { FcmSender } = await import("../src/main/fcm-sender");
const { HostVoice } = await import("../src/main/host-voice");
const { DirectPairedServer, readPairingOrigin } = await import("../src/main/direct-paired-server");
const { TeamWebRtcClientTransport } = await import("../src/main/team-webrtc-client-transport");

const unused = () => Effect.die(new Error("Not used by this check."));
const agentBrowser: AgentBrowserHost = {
  shareTab: () => {},
  unshareThread: () => {},
  agentTab: () => null,
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};
const teamBrowser: TeamApiBrowser = {
  listTabs: () => [],
  getControlState: () => ({ sessions: [] }),
  open: unused,
  activate: unused,
  navigate: unused,
  reload: unused,
  stop: unused,
  takeUserControl: unused,
  releaseUserControl: () => {},
  releaseUserControlHeldBy: () => {},
  close: unused,
  capturePreview: unused,
  setVisible: unused,
  getDisplayState: () => ({ tabs: [], activeTabId: null }),
  loadUrl: unused,
  isPrivate: () => false,
  startView: unused,
  dispatchViewInput: unused,
  copyViewSelection: unused,
  importSignIn: unused,
};

const root = await mkdtemp(join(tmpdir(), "direct-connection-e2e-"));
const userData = join(root, "user-data");
const database = new TommyDatabase(userData);
const agentStore = new AgentStore(userData, join(root, "home"), database);
const mailbox = new MailboxStore(userData, agentStore.sharedRoot, agentStore.database);
const sidebar = new SidebarLayoutStore(join(userData, "sidebar-layout.json"));
const team = new TeamStore(join(userData, "tommy-team-server-v2.json"));
await runCauseEffect(sidebar.initialize());
await runCauseEffect(agentStore.initialize());
await runCauseEffect(mailbox.initialize());
await runCauseEffect(team.initialize());
const identity = await runCauseEffect(team.configure("E2E Host", "owner-user", "owner-password-123"));
const agents = new AgentService({ store: agentStore, mailbox, browser: agentBrowser, sidebarLayout: sidebar });
// The fake OpenAI socket: each commit gets a turn, with a delta and the final text.
const openAiSent: { type?: unknown }[] = [];
const openAiKeys: string[] = [];
let voiceKey: string | null = null;
const hostVoice = new HostVoice({
  keys: {
    get: () => voiceKey,
    set: (key) =>
      Effect.sync(() => {
        voiceKey = key;
      }),
  },
  open: (apiKey, events) => {
    openAiKeys.push(apiKey);
    let turn = 0;
    const answer = (message: object) => queueMicrotask(() => events.onMessage(JSON.stringify(message)));
    queueMicrotask(events.onOpen);
    return {
      send(text) {
        const message = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(JSON.parse(text));
        openAiSent.push(message);
        if (message.type === "session.update") answer({ type: "session.updated" });
        if (message.type === "input_audio_buffer.commit") {
          turn += 1;
          const itemId = `item-${turn}`;
          answer({ type: "input_audio_buffer.committed", item_id: itemId });
          answer({ type: "conversation.item.input_audio_transcription.delta", item_id: itemId, delta: "hel" });
          answer({
            type: "conversation.item.input_audio_transcription.completed",
            item_id: itemId,
            transcript: `hello ${turn}`,
          });
        }
      },
      close() {},
    };
  },
});
const server = new TeamApiServer({
  admin: {
    devices: {
      list: () => devices.list(),
      createPairingCode: () => ({ ...devices.createPairingCode(), publicUrl: "https://tommy.example.com" }),
      revoke: (deviceId) => gateway.revokeDevice(deviceId),
    },
  },
  voice: hostVoice,
  store: team,
  agents,
  mailbox,
  browser: teamBrowser,
  sidebarLayout: sidebar,
  appVersion: HOST_VERSION,
});
const apiPort = await Effect.runPromise(server.start());
const devices = new DirectDeviceStore({ path: join(userData, "tommy-devices-v1.json") });
await Effect.runPromise(devices.load());
const ownerMemberId = team.getOwnerMemberId();
assert.ok(ownerMemberId, "The host has no owner.");
const gateway = new DirectHostGateway({
  store: team,
  appVersion: HOST_VERSION,
  transferDirectory: join(root, "transfers"),
  devices,
  owner: () => ({ membershipId: ownerMemberId, userId: ownerMemberId }),
  listen: { host: "127.0.0.1", port: 0 },
});
const port = await Effect.runPromise(gateway.start({ hostId: identity.serverId, localApiPort: apiPort }));
const httpBase = `http://127.0.0.1:${port}`;
const wsBase = `ws://127.0.0.1:${port}`;

// --- Client ---

const decodePaired = Schema.decodeUnknownSync(DirectPairResponse);
const RpcResult = Schema.Struct({ status: Schema.Number, body: Schema.Unknown });
type RpcResult = typeof RpcResult.Type;
const decodeRpcAnswer = Schema.decodeUnknownSync(
  Schema.Struct({
    result: Schema.optional(RpcResult),
    error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.optional(Schema.String) })),
  }),
);
const decodeAuthReady = Schema.decodeUnknownSync(Schema.Struct({ hostNonce: Schema.String, signature: Schema.String }));

interface PairedDevice extends DirectPairResponse {
  publicKey: string;
  privateKey: string;
}

function newKeys(): { publicKey: string; privateKey: string } {
  return generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

async function pairRequest(code: string, publicKey: string): Promise<Response> {
  return fetch(`${httpBase}${DIRECT_PAIR_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, publicKey, name: "E2E device" }),
  });
}

async function pairDevice(): Promise<PairedDevice> {
  const keys = newKeys();
  const response = await pairRequest(devices.createPairingCode().code, keys.publicKey);
  assert.equal(response.status, 200);
  return { ...keys, ...decodePaired(await response.json()) };
}

/** One socket, with its messages in a queue, so that a step waits for the next frame of a kind. */
class Client {
  readonly frames: { kind: string; payload: string }[] = [];
  readonly #waiters = new Set<() => void>();
  closeCode: number | null = null;
  readonly opened: Promise<void>;
  readonly closed: Promise<number>;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const frame = decodeDirectFrame(data.toString());
      assert.ok(frame, "The host sent a frame with no kind.");
      this.frames.push(frame);
      this.#wake();
    });
    this.opened = new Promise((done, fail) => {
      socket.once("open", () => done());
      socket.once("unexpected-response", (_request, response) =>
        fail(new Error(`refused:${response.statusCode ?? 0}`)),
      );
      socket.on("error", fail);
    });
    this.closed = new Promise((done) => {
      socket.once("close", (code) => {
        this.closeCode = code;
        this.#wake();
        done(code);
      });
    });
    // `opened` reports a refusal. A step that does not wait for it has no use for the rejection.
    this.opened.catch(() => {});
  }

  #wake(): void {
    for (const wake of this.#waiters) wake();
  }

  async next(
    accepts: (frame: { kind: string; payload: string }) => boolean,
  ): Promise<{ kind: string; payload: string }> {
    for (;;) {
      const index = this.frames.findIndex(accepts);
      if (index >= 0) {
        const [frame] = this.frames.splice(index, 1);
        assert.ok(frame);
        return frame;
      }
      if (this.closeCode !== null) throw new Error(`The socket closed with ${this.closeCode}.`);
      await new Promise<void>((wake) => {
        const done = () => {
          this.#waiters.delete(done);
          wake();
        };
        this.#waiters.add(done);
      });
    }
  }

  send(kind: "rpc" | "events" | "ping", payload = ""): void {
    this.socket.send(encodeDirectFrame(kind, payload));
  }
}

function connect(deviceId: string): Client {
  return new Client(new WebSocket(`${wsBase}${DIRECT_CONNECT_PATH}?${DIRECT_DEVICE_QUERY}=${deviceId}`));
}

async function hello(client: Client) {
  await client.opened;
  const frame = await client.next((candidate) => candidate.kind === "hello");
  return Schema.decodeUnknownSync(DirectHello)(JSON.parse(frame.payload));
}

async function authenticate(client: Client, device: PairedDevice, signingKey = device.privateKey) {
  const { connectionId, filesToken } = await hello(client);
  const binding = directConnectionBinding(connectionId);
  const clientNonce = randomBytes(32).toString("base64url");
  const transcript = {
    hostId: device.hostId,
    sessionId: directSessionId(device.deviceId),
    ticket: device.deviceId,
    clientPublicKey: device.publicKey,
    clientNonce,
    clientFingerprint: binding.client,
    hostFingerprint: binding.host,
  };
  client.send(
    "rpc",
    encodeTeamProtocolV2Frame({
      version: 2,
      type: "auth-init",
      ticket: device.deviceId,
      clientPublicKey: device.publicKey,
      clientNonce,
      signature: sign(null, Buffer.from(teamProtocolV2AuthenticationTranscript(transcript)), signingKey).toString(
        "base64url",
      ),
    }),
  );
  const readyFrame = await client.next((frame) => frame.kind === "rpc" && frame.payload.includes("auth-ready"));
  const ready = decodeAuthReady(JSON.parse(readyFrame.payload));
  const hostProof = teamProtocolV2AuthenticationTranscript({ ...transcript, hostNonce: ready.hostNonce });
  const publicKeyOfHost = createPublicKey(identity.publicKey);
  assert.ok(
    verify(null, Buffer.from(hostProof), publicKeyOfHost, Buffer.from(ready.signature, "base64url")),
    "The host signature does not verify.",
  );
  client.send(
    "rpc",
    encodeTeamProtocolV2Frame({ version: 2, type: "auth-complete", clientNonce, hostNonce: ready.hostNonce }),
  );
  await client.next((frame) => frame.kind === "rpc" && frame.payload.includes("auth-confirmed"));
  return { connectionId, filesToken };
}

async function rpc(
  client: Client,
  path: string,
  request: { method: string; body: TeamProtocolV2Json; capabilities: string[] } = {
    method: "GET",
    body: null,
    capabilities: [],
  },
) {
  const requestId = randomBytes(12).toString("base64url");
  client.send(
    "rpc",
    encodeTeamProtocolV2Frame({
      version: 2,
      type: "request",
      requestId,
      operation: "http.request",
      payload: {
        method: request.method,
        path,
        body: request.body,
        capabilities: [TEAM_LONG_CAPABILITY_LISTS_CAPABILITY, ...request.capabilities],
      },
    }),
  );
  const frame = await client.next((candidate) => candidate.kind === "rpc" && candidate.payload.includes(requestId));
  return decodeRpcAnswer(JSON.parse(frame.payload));
}

/** The answer of a route that must succeed: the frame holds the HTTP status of the real Team API. */
async function read(client: Client, path: string): Promise<RpcResult> {
  const answer = await rpc(client, path);
  assert.equal(answer.error, undefined, JSON.stringify(answer.error));
  assert.ok(answer.result, `${path} has no result.`);
  assert.equal(answer.result.status, 200, `${path}: ${JSON.stringify(answer.result)}`);
  return answer.result;
}

// --- Checks ---

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}
const report: { passed: boolean; steps: Step[]; connectMs?: number[] } = { passed: false, steps: [] };

async function waitUntil(done: () => boolean): Promise<void> {
  while (!done()) await new Promise((resolved) => setTimeout(resolved, 5));
}

async function step(name: string, run: () => Promise<unknown>): Promise<void> {
  process.stdout.write(`- ${name}\n`);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const detail = await Promise.race([
      run(),
      new Promise((_done, fail) => {
        deadline = setTimeout(() => fail(new Error("The step passed its deadline.")), STEP_DEADLINE_MS);
      }),
    ]);
    report.steps.push({ name, passed: true, ...(detail === undefined ? {} : { detail }) });
  } catch (cause) {
    const error = cause instanceof Error ? cause.message || String(cause.cause ?? cause.name) : String(cause);
    process.stdout.write(`  failed: ${error}\n`);
    report.steps.push({ name, passed: false, error });
  } finally {
    clearTimeout(deadline);
  }
}

let device: PairedDevice | undefined;
const paired = (): PairedDevice => {
  assert.ok(device, "No device paired.");
  return device;
};

let secondDevice: PairedDevice | undefined;
const paired2 = (): PairedDevice => {
  assert.ok(secondDevice, "No second device paired.");
  return secondDevice;
};

await step("An unknown device gets no socket", async () => {
  await assert.rejects(connect("not-a-device").opened, /refused:401/);
});

await step("A path that the gateway does not serve gets no socket", async () => {
  const socket = new Client(new WebSocket(`${wsBase}/v1/events`));
  await assert.rejects(socket.opened, /refused:404/);
  assert.equal((await fetch(`${httpBase}/v1/compatibility`)).status, 404);
});

await step("A pairing code works once and only when it is right", async () => {
  const keys = newKeys();
  assert.equal((await pairRequest("WRONGCODE234", keys.publicKey)).status, 403, "No code is active.");
  const { code } = devices.createPairingCode();
  assert.equal((await pairRequest("WRONGCODE234", keys.publicKey)).status, 403);
  const accepted = await pairRequest(code.toLowerCase(), keys.publicKey);
  assert.equal(accepted.status, 200);
  assert.equal((await pairRequest(code, keys.publicKey)).status, 403, "A used code works again.");
  device = { ...keys, ...decodePaired(await accepted.json()) };
  assert.equal(device.hostId, identity.serverId);
  assert.equal(device.hostFingerprint, identity.fingerprint);
});

await step("Five wrong codes end a code", async () => {
  const keys = newKeys();
  const { code } = devices.createPairingCode();
  for (let attempt = 0; attempt < 5; attempt += 1) await pairRequest("WRONGCODE234", keys.publicKey);
  assert.equal((await pairRequest(code, keys.publicKey)).status, 403);
});

await step("A key that is not Ed25519 spends the code and pairs nothing", async () => {
  const { code } = devices.createPairingCode();
  const count = devices.list().length;
  assert.equal((await pairRequest(code, "not a key")).status, 400);
  assert.equal(devices.list().length, count);
  assert.equal((await pairRequest(code, newKeys().publicKey)).status, 403);
});

await step("A wrong signature closes the socket", async () => {
  const client = connect(paired().deviceId);
  await assert.rejects(authenticate(client, paired(), newKeys().privateKey), /closed/);
});

await step("A request before the authentication closes the socket", async () => {
  const client = connect(paired().deviceId);
  await hello(client);
  client.send(
    "rpc",
    encodeTeamProtocolV2Frame({
      version: 2,
      type: "request",
      requestId: randomBytes(12).toString("base64url"),
      operation: "http.request",
      payload: { method: "GET", path: TEAM_API_ROUTES.compatibility, body: null },
    }),
  );
  await client.closed;
  assert.ok(!client.frames.some((frame) => frame.kind === "rpc"), "The host answered before the authentication.");
});

await step("A device reads the real Team API through the connection", async () => {
  const client = connect(paired().deviceId);
  await authenticate(client, paired());
  const compatibility = await read(client, TEAM_API_ROUTES.compatibility);
  const agentList = await read(client, "/v1/agents");
  assert.ok(Array.isArray(agentList.body), "The agent list is not a list.");
  client.socket.close();
  await client.closed;
  return { compatibility: compatibility.body, agents: agentList.body.length };
});

await step("A ping gets a pong", async () => {
  const client = connect(paired().deviceId);
  await authenticate(client, paired());
  client.send("ping");
  await client.next((frame) => frame.kind === "pong");
  client.socket.close();
  await client.closed;
});

await step("The files socket needs the token of a live connection, once", async () => {
  const client = connect(paired().deviceId);
  const { filesToken } = await authenticate(client, paired());
  const filesUrl = (token: string) => `${wsBase}${DIRECT_FILES_PATH}?${DIRECT_FILES_TOKEN_QUERY}=${token}`;
  await assert.rejects(new Client(new WebSocket(filesUrl("wrong"))).opened, /refused:401/);
  const files = new Client(new WebSocket(filesUrl(filesToken)));
  await files.opened;
  await assert.rejects(new Client(new WebSocket(filesUrl(filesToken))).opened, /refused:401/);
  client.socket.close();
  await client.closed;
  assert.equal(await files.closed, 1000);
  await assert.rejects(new Client(new WebSocket(filesUrl(filesToken))).opened, /refused:401/);
});

await step("A newer connection of a device replaces the older one", async () => {
  const older = connect(paired().deviceId);
  await authenticate(older, paired());
  const newer = connect(paired().deviceId);
  await authenticate(newer, paired());
  assert.equal(await older.closed, DIRECT_CLOSE_REPLACED);
  await read(newer, "/v1/agents");
  newer.socket.close();
  await newer.closed;
});

await step("Connect time on loopback, from socket start to confirmed authentication", async () => {
  const times: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    const started = performance.now();
    const client = connect(paired().deviceId);
    await authenticate(client, paired());
    times.push(Math.round(performance.now() - started));
    client.socket.close();
    await client.closed;
  }
  report.connectMs = times;
  return { times };
});

await step("A second paired device connects at the same time", async () => {
  const second = await pairDevice();
  secondDevice = second;
  const first = connect(paired().deviceId);
  await authenticate(first, paired());
  const other = connect(second.deviceId);
  await authenticate(other, second);
  await read(first, "/v1/agents");
  await read(other, "/v1/agents");
  first.socket.close();
  await first.closed;
  other.socket.close();
  await other.closed;
});

await step("A revoke closes the device's connection and it cannot connect again", async () => {
  const client = connect(paired().deviceId);
  await authenticate(client, paired());
  await Effect.runPromise(gateway.revokeDevice(paired().deviceId));
  assert.equal(await client.closed, DIRECT_CLOSE_DEVICE_REVOKED);
  await assert.rejects(connect(paired().deviceId).opened, /refused:401/);
});

await step("The saved devices stay after a restart, and hold no private key", async () => {
  const reloaded = new DirectDeviceStore({ path: join(userData, "tommy-devices-v1.json") });
  await Effect.runPromise(reloaded.load());
  assert.equal(reloaded.list().length, devices.list().length);
  assert.equal(reloaded.get(paired().deviceId), null);
  assert.ok(!JSON.stringify(reloaded.list()).includes("PRIVATE KEY"));
});

await step("The app's client transport connects, reads, gets events and moves a file both ways", async () => {
  const keys = newKeys();
  const response = await pairRequest(devices.createPairingCode().code, keys.publicKey);
  const pairing = decodePaired(await response.json());
  const bridge = new DirectClientBridge();
  const transport = new TeamWebRtcClientTransport({
    bridge,
    deviceKeys: () => keys,
    listHosts: () => Effect.succeed([]),
    startSession: () =>
      Effect.succeed({
        sessionId: directSessionId(pairing.deviceId),
        hostId: pairing.hostId,
        expiresAt: DIRECT_SESSION_EXPIRES_AT_SECONDS * 1_000,
      }),
    issueTicket: () =>
      Effect.succeed({
        ticket: pairing.deviceId,
        expiresAt: DIRECT_SESSION_EXPIRES_AT_SECONDS * 1_000,
        signalUrl: `${wsBase}${DIRECT_CONNECT_PATH}?${DIRECT_DEVICE_QUERY}=${pairing.deviceId}`,
      }),
    endSession: () => Effect.void,
    getPrincipalId: () => "local-owner",
    transferDirectory: join(root, "client-transfers"),
  });
  const hostId = pairing.hostId;
  transport.pinHostKey(hostId, pairing.hostPublicKey);
  const started = performance.now();
  await Effect.runPromise(transport.connect(hostId));
  const connectMs = Math.round(performance.now() - started);
  const agentList = await Effect.runPromise(transport.request(hostId, "/v1/agents"));
  assert.ok(Array.isArray(agentList), "The agent list is not a list.");

  // An event comes on the events channel, from the real event socket of the Team API.
  const firstEvent = new Promise<void>((done) => transport.once("event", () => done()));
  await Effect.runPromise(transport.requestRuntimeSnapshot(hostId));
  await firstEvent;

  // Larger than one chunk, and larger than a WebSocket frame that hides a framing fault.
  const sent = Buffer.from(randomBytes(3 * 1024 * 1024 + 17).toString("base64url"));
  const uploaded = await Effect.runPromise(
    transport.requestResponse(hostId, `${TEAM_API_ROUTES.attachments}?name=e2e.txt&mime=text/plain`, {
      method: "POST",
      body: new Uint8Array(sent),
      contentType: "text/plain",
    }),
  );
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const attachmentId = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(uploaded.body).id;
  const downloaded = await Effect.runPromise(
    transport.requestResponse(hostId, TEAM_API_ROUTES.attachment(attachmentId)),
  );
  assert.equal(downloaded.status, 200);
  assert.ok(downloaded.file, "The download has no file.");
  assert.equal(
    createHash("sha256").update(downloaded.file.bytes).digest("hex"),
    createHash("sha256").update(sent).digest("hex"),
    "The downloaded bytes differ.",
  );

  // Chat keeps moving while a file moves.
  const large = Buffer.from(randomBytes(6 * 1024 * 1024).toString("base64url"));
  // A file went on its own socket, not on the connect socket that carries chat.
  assert.ok(
    gateway.connectedDevices().some((entry) => entry.deviceId === pairing.deviceId && entry.filesSocket),
    "The device has no files socket.",
  );
  const moving = Effect.runPromise(
    transport.requestResponse(hostId, `${TEAM_API_ROUTES.attachments}?name=large.txt&mime=text/plain`, {
      method: "POST",
      body: new Uint8Array(large),
      contentType: "text/plain",
    }),
  );
  const readStarted = performance.now();
  await Effect.runPromise(transport.request(hostId, "/v1/agents"));
  const readDuringFileMs = Math.round(performance.now() - readStarted);
  assert.equal((await moving).status, 201);

  // The connection comes back after the socket ends, with the same session.
  const disconnected = new Promise<void>((done) => transport.once("disconnected", () => done()));
  await Effect.runPromise(gateway.dropDeviceConnection(pairing.deviceId));
  await disconnected;
  const again = await Effect.runPromise(transport.request(hostId, "/v1/agents"));
  assert.ok(Array.isArray(again));
  await Effect.runPromise(transport.disconnect(hostId));
  await Effect.runPromise(gateway.revokeDevice(pairing.deviceId));
  return { connectMs, readDuringFileMs };
});

await step("The phone peer connects, reads, gets events, moves a file and ends with its device", async () => {
  const identity = await Effect.runPromise(
    createEd25519Identity((size) => crypto.getRandomValues(new Uint8Array(size))),
  );
  const response = await pairRequest(devices.createPairingCode().code, identity.publicKeyPem);
  const pairing = decodePaired(await response.json());
  const updates: RemoteTeamConnectionUpdate[] = [];
  const teamEvents: unknown[] = [];
  const peer = createRemoteTeamPeer({
    current: {
      getDevice: async () => ({
        sessionId: directSessionId(pairing.deviceId),
        ticket: pairing.deviceId,
        url: `${wsBase}${DIRECT_CONNECT_PATH}?${DIRECT_DEVICE_QUERY}=${pairing.deviceId}`,
        identity,
      }),
      onConnectionUpdate: async (update) => {
        updates.push(update);
      },
      onTeamEvent: async (_hostId, event) => {
        teamEvents.push(event);
      },
    },
  });
  const command = async (input: Parameters<typeof peer.execute>[0]) => {
    const result = await peer.execute(input);
    assert.ok(result.ok, result.error);
    return result;
  };
  const request = (method: string, path: string, body: TeamProtocolV2Json = {}, upload?: RemoteFileUpload) =>
    command({
      id: randomBytes(8).toString("hex"),
      type: "request",
      method,
      path,
      body,
      ...(upload ? { upload } : {}),
    });
  const started = performance.now();
  await command({ id: "connect", type: "connect", hostId: pairing.hostId, hostPublicKey: pairing.hostPublicKey });
  const connectMs = Math.round(performance.now() - started);
  assert.ok(
    updates.some((update) => update.state === "online"),
    "The peer did not go online.",
  );

  const support = await request("GET", TEAM_API_ROUTES.compatibility);
  assert.equal(support.status, 200);
  const agents = await request("GET", "/v1/agents");
  assert.equal(agents.status, 200);
  assert.ok(Array.isArray(agents.body), "The agent list is not a list.");
  assert.ok(
    gateway.connectedDevices().some((entry) => entry.deviceId === pairing.deviceId && entry.filesSocket),
    "The phone has no files socket.",
  );

  // A file goes up on the files socket, and the same bytes come back.
  const sent = Buffer.from(randomBytes(1024 * 1024 + 17).toString("base64url"));
  const uploaded = await request(
    "POST",
    `${TEAM_API_ROUTES.attachments}?name=phone.txt&mime=text/plain`,
    {},
    {
      name: "phone.txt",
      base64: sent.toString("base64"),
      mimeType: "text/plain",
    },
  );
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const attachmentId = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(uploaded.body).id;
  const downloaded = await request("GET", TEAM_API_ROUTES.attachment(attachmentId));
  assert.equal(downloaded.status, 200);
  const file = Schema.decodeUnknownSync(Schema.Struct({ base64: Schema.String }))(downloaded.body);
  assert.equal(
    createHash("sha256").update(Buffer.from(file.base64, "base64")).digest("hex"),
    createHash("sha256").update(sent).digest("hex"),
    "The downloaded bytes differ.",
  );

  // A socket that ends is an offline update. The recovery owner connects again, with the same device.
  const beforeDrop = updates.length;
  await Effect.runPromise(gateway.dropDeviceConnection(pairing.deviceId));
  await waitUntil(() => updates.slice(beforeDrop).some((update) => update.state === "offline"));
  await command({ id: "again", type: "connect", hostId: pairing.hostId, hostPublicKey: pairing.hostPublicKey });
  assert.equal((await request("GET", "/v1/agents")).status, 200);

  // A revoked device gets the code that makes the app ask for a new pairing.
  const beforeRevoke = updates.length;
  await Effect.runPromise(gateway.revokeDevice(pairing.deviceId));
  await waitUntil(() => updates.slice(beforeRevoke).some((update) => update.code === "session_revoked"));
  await peer.dispose();
  return { connectMs, events: teamEvents.length };
});

await step("The server signs for Google and sends a sealed data message to Firebase", async () => {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  let tokenRequests = 0;
  let answer: { status: number; body: unknown } = { status: 200, body: {} };
  const sent: { url: string; body: string; authorization: string | null }[] = [];
  const fakeFetch = async (url: string, init: RequestInit) => {
    if (url.startsWith("https://oauth2.googleapis.com/")) {
      tokenRequests += 1;
      const assertion = new URLSearchParams(String(init.body)).get("assertion") ?? "";
      const [header, claims, signature] = assertion.split(".");
      assert.ok(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${claims}`),
          keys.publicKey,
          Buffer.from(signature ?? "", "base64url"),
        ),
        "The assertion has a wrong signature.",
      );
      const decoded = JSON.parse(Buffer.from(claims ?? "", "base64url").toString());
      assert.equal(decoded.iss, "tommy@example.test");
      return Response.json({ access_token: "access", expires_in: 3600 });
    }
    sent.push({ url, body: String(init.body), authorization: new Headers(init.headers).get("authorization") });
    return Response.json(answer.body, { status: answer.status });
  };
  const path = join(root, "fcm-service-account.json");
  writeFileSync(
    path,
    JSON.stringify({
      project_id: "tommy-test",
      client_email: "tommy@example.test",
      private_key: keys.privateKey,
      private_key_id: "key-1",
    }),
  );
  assert.equal(await FcmSender.load(join(root, "no-such-file.json")), null, "A missing key must read as no sender.");
  const sender = await FcmSender.load(path, fakeFetch);
  assert.ok(sender, "The key did not load.");
  const push = { token: "phone-token", sessionId: "s", sealed: "sealed-bytes", sound: null, timestamp: 1 };
  assert.equal(await Effect.runPromise(sender.send(push)), "sent");
  assert.equal(await Effect.runPromise(sender.send(push)), "sent");
  assert.equal(tokenRequests, 1, "The access token must be kept.");
  assert.ok(sent[0]?.url.includes("/v1/projects/tommy-test/messages:send"));
  assert.equal(sent[0]?.authorization, "Bearer access");
  const message = JSON.parse(sent[0]?.body ?? "{}").message;
  assert.deepEqual(message.data, { sealed: "sealed-bytes" }, "The message must hold the sealed bytes only.");
  assert.equal(message.notification, undefined, "The message must hold no text for Firebase to show.");
  answer = { status: 404, body: { error: { details: [{ errorCode: "UNREGISTERED" }] } } };
  assert.equal(await Effect.runPromise(sender.send(push)), "gone");
  answer = { status: 500, body: {} };
  const failed = await Effect.runPromise(Effect.result(sender.send(push)));
  assert.ok(Result.isFailure(failed), "A server fault must be a failure that is sent again.");
  assert.ok(!JSON.stringify(failed).includes("phone-token"), "A failure must not hold the token of the phone.");
});

await step("The Mac pairing saves the device, survives a restart and connects with the saved key", async () => {
  const path = join(root, "paired-server.bin");
  // Not plain text in the file, as the operating-system storage is not.
  const cipher = {
    encrypt: (value: string) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0x5a)),
    decrypt: (value: Buffer) => Buffer.from(value.map((byte) => byte ^ 0x5a)).toString("utf8"),
  };
  const paired = new DirectPairedServer({ path, allowLoopbackHttp: true, deviceName: () => "e2e-mac", ...cipher });
  const failure = async (input: { address: string; code: string }) =>
    Effect.runPromise(paired.pair(input).pipe(Effect.flip)).then((error) => String(error.cause));

  assert.match(await failure({ address: "http://tommy.example.com", code: "X" }), /HTTPS address/);
  assert.match(await failure({ address: "https://user:secret@tommy.example.com", code: "X" }), /HTTPS address/);
  assert.match(await failure({ address: httpBase, code: "WRONG" }), /wrong or expired/);
  assert.match(await failure({ address: "http://127.0.0.1:1", code: "X" }), /reach the server/);
  assert.equal(paired.paired, false);
  assert.equal(readPairingOrigin("tommy.example.com/x", false), "https://tommy.example.com");
  assert.equal(readPairingOrigin("http://127.0.0.1:9", false), null);

  // The spaces and the lower case of a code that a person typed.
  const code = devices.createPairingCode().code;
  const spaced = `${code.slice(0, 4).toLowerCase()} ${code.slice(4)}`;
  const { hostId } = await Effect.runPromise(paired.pair({ address: httpBase, code: spaced }));
  assert.equal(hostId, identity.serverId);
  assert.equal((await readFile(path)).includes("PRIVATE KEY"), false, "The file holds a readable private key.");

  const restarted = new DirectPairedServer({ path, allowLoopbackHttp: true, ...cipher });
  await Effect.runPromise(restarted.load());
  assert.equal(restarted.paired, true);
  const source = restarted.transportSource;
  const transport = new TeamWebRtcClientTransport({
    bridge: new DirectClientBridge(),
    ...source,
    getPrincipalId: () => "local-owner",
    transferDirectory: join(root, "paired-transfers"),
  });
  const [host] = await Effect.runPromise(source.listHosts());
  assert.ok(host?.devicePublicKey, "The host list holds no host key.");
  assert.equal(host.hostId, identity.serverId);
  transport.pinHostKey(host.hostId, host.devicePublicKey);
  await Effect.runPromise(transport.connect(host.hostId));
  assert.ok(Array.isArray(await Effect.runPromise(transport.request(host.hostId, "/v1/agents"))));
  await Effect.runPromise(transport.disconnect(host.hostId));

  // A forgotten pairing leaves no key and no server.
  await Effect.runPromise(restarted.forget());
  assert.equal(restarted.paired, false);
  assert.deepEqual(await Effect.runPromise(source.listHosts()), []);
  await assert.rejects(readFile(path));
  await Effect.runPromise(paired.load());
  assert.equal(paired.paired, false);
});

await step("tommy-handoff pairs, lists the agents, sends a redacted summary and forgets its key", async () => {
  const stateDirectory = join(root, "tommy-handoff");
  const handoff = async (args: string[], stdin = "") => {
    const child = Bun.spawn(["bun", resolve(import.meta.dirname, "tommy-handoff.ts"), ...args], {
      cwd: resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        TOMMY_HANDOFF_STATE_DIR: stateDirectory,
        TOMMY_HANDOFF_ALLOW_LOOPBACK: "1",
        TOMMY_HANDOFF_TEST_KEY: "07".repeat(32),
      },
      stdin: new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  };
  const passed = async (args: string[], stdin?: string) => {
    const result = await handoff(args, stdin);
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout;
  };

  const agent = await runCauseEffect(
    agentStore.createAgent({
      name: "Handoff target",
      description: "",
      avatarSeed: "handoff",
      avatarHue: null,
    }),
  );
  // A real send starts the provider of this computer. The route, codec and connection stay real.
  const sent: { text: string; clientMessageId?: string; timezone?: string }[] = [];
  const realSendMessage = agents.sendMessage;
  Object.defineProperty(agents, "sendMessage", {
    value: (input: { text: string; clientMessageId?: string }, _sender: unknown, timezone?: string) =>
      Effect.sync(() => {
        sent.push({ ...input, ...(timezone ? { timezone } : {}) });
        return { messageId: "handoff-message", deliveries: [] };
      }),
  });
  try {
    await passed(["pair", httpBase, devices.createPairingCode().code]);
    assert.equal((await readFile(join(stateDirectory, "pairing.enc"))).includes("PRIVATE KEY"), false);
    assert.ok(devices.list().some(({ name }) => name.startsWith("T3 handoff")));

    const listed = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })))(
      JSON.parse(await passed(["agents", "--json"])),
    );
    assert.ok(listed.some(({ id, name }) => id === agent.id && name === "Handoff target"));

    const secret = "abcdefghijklmnop1234567890";
    const summary = `## Goal\nFinish the work.\npassword=${secret}\n`;
    const send = ["send", "--agent", agent.id, "--mode", "record", "--source", "E2E"];
    const answer = await passed(send, summary);
    assert.match(answer, /mode: record, redactions: 1/);
    const [message] = sent;
    assert.ok(message);
    assert.match(message.text, /^\[Context handoff: record only\]/);
    assert.match(message.text, /Source: E2E\n/);
    assert.match(message.text, /## Goal\nFinish the work\./);
    assert.equal(message.text.includes(secret), false, "The secret reached the host.");
    assert.ok(message.timezone);

    await passed(send, summary);
    assert.equal(sent[1]?.clientMessageId, message.clientMessageId, "A repeated send has a new message ID.");
    await passed(["send", "--agent", agent.id, "--mode", "work"], summary);
    assert.match(sent[2]?.text ?? "", /^\[Context handoff\] .*continue from its next step/);

    assert.equal(sent.length, 3);
    assert.equal((await handoff(["send", "--agent", agent.id, "--mode", "other"], summary)).exitCode, 1);
    assert.equal((await handoff(["send", "--agent", agent.id, "--mode", "work"], " \n")).exitCode, 1);
    assert.equal(sent.length, 3, "An invalid command reached the host.");

    await passed(["unpair"]);
    await assert.rejects(readFile(join(stateDirectory, "pairing.enc")));
    assert.equal((await handoff(["agents"])).exitCode, 1);
  } finally {
    Object.defineProperty(agents, "sendMessage", { value: realSendMessage });
  }
});

await step("Dictation goes through the host with a key that a client cannot read", async () => {
  const keys = newKeys();
  const response = await pairRequest(devices.createPairingCode().code, keys.publicKey);
  const pairing = decodePaired(await response.json());
  const transport = new TeamWebRtcClientTransport({
    bridge: new DirectClientBridge(),
    deviceKeys: () => keys,
    listHosts: () => Effect.succeed([]),
    startSession: () =>
      Effect.succeed({
        sessionId: directSessionId(pairing.deviceId),
        hostId: pairing.hostId,
        expiresAt: DIRECT_SESSION_EXPIRES_AT_SECONDS * 1_000,
      }),
    issueTicket: () =>
      Effect.succeed({
        ticket: pairing.deviceId,
        expiresAt: DIRECT_SESSION_EXPIRES_AT_SECONDS * 1_000,
        signalUrl: `${wsBase}${DIRECT_CONNECT_PATH}?${DIRECT_DEVICE_QUERY}=${pairing.deviceId}`,
      }),
    endSession: () => Effect.void,
    getPrincipalId: () => "local-owner",
    transferDirectory: join(root, "voice-transfers"),
  });
  transport.pinHostKey(pairing.hostId, pairing.hostPublicKey);
  await Effect.runPromise(transport.connect(pairing.hostId));
  const post = async (path: string, body: unknown) =>
    Effect.runPromise(
      transport.requestResponse(pairing.hostId, path, {
        method: "POST",
        body,
      }),
    );
  // No key: a clear refusal, and no socket opens.
  assert.deepEqual((await post(HOST_VOICE_ROUTES.status, {})).body, { keySaved: false });
  await assert.rejects(post(HOST_VOICE_ROUTES.start, {}));
  assert.equal(openAiKeys.length, 0);

  const secret = "sk-e2e-secret-key";
  const saved = await post(HOST_VOICE_ROUTES.setKey, { key: secret });
  assert.deepEqual(saved.body, { keySaved: true });
  assert.equal(JSON.stringify((await post(HOST_VOICE_ROUTES.status, {})).body).includes(secret), false);

  const started = await post(HOST_VOICE_ROUTES.start, {});
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const { streamId } = Schema.decodeUnknownSync(Schema.Struct({ streamId: Schema.String }))(started.body);
  assert.deepEqual(openAiKeys, [secret]);
  const update = openAiSent.find((message) => message.type === "session.update");
  assert.match(JSON.stringify(update), /gpt-live-transcribe/);
  assert.match(JSON.stringify(update), /"turn_detection":null/);
  assert.match(JSON.stringify(update), /"rate":24000/);

  // Half a second of speech, then a pause that ends the turn.
  const speech = Buffer.alloc(16_000);
  for (let offset = 0; offset < speech.length; offset += 2)
    speech.writeInt16LE(offset % 40 < 20 ? 8_000 : -8_000, offset);
  const quiet = Buffer.alloc(32_000);
  await post(HOST_VOICE_ROUTES.append, { streamId, audio: speech.toString("base64") });
  const afterPause = await post(HOST_VOICE_ROUTES.append, { streamId, audio: quiet.toString("base64") });
  assert.equal(afterPause.status, 200);
  await new Promise((done) => setTimeout(done, 10));
  const appended = openAiSent.filter((message) => message.type === "input_audio_buffer.append");
  assert.equal(appended.length, 2);
  // 16 kHz becomes 24 kHz: half as much again.
  const first = Schema.decodeUnknownSync(Schema.Struct({ type: Schema.String, audio: Schema.String }))(appended[0]);
  assert.equal(Buffer.from(first.audio, "base64").length, 24_000);
  assert.equal(openAiSent.filter((message) => message.type === "input_audio_buffer.commit").length, 1);

  // A second turn that Stop ends.
  await post(HOST_VOICE_ROUTES.append, { streamId, audio: speech.toString("base64") });
  const finished = await post(HOST_VOICE_ROUTES.finish, { streamId });
  assert.deepEqual(finished.body, { text: "hello 1 hello 2" });
  await assert.rejects(post(HOST_VOICE_ROUTES.append, { streamId, audio: "" }));

  await post(HOST_VOICE_ROUTES.setKey, { key: null });
  assert.deepEqual((await post(HOST_VOICE_ROUTES.status, {})).body, { keySaved: false });
  await Effect.runPromise(transport.disconnect(pairing.hostId));
  await Effect.runPromise(gateway.revokeDevice(pairing.deviceId));
});

await step("The control socket makes a code and lists and removes devices", async () => {
  const socketDirectory = await mkdtemp(join(tmpdir(), "direct-control-"));
  const socketPath = join(socketDirectory, "control.sock");
  const status: HostStatus = {
    phase: "online",
    configured: true,
    enabledOnLaunch: true,
    serverId: identity.serverId,
    serverName: identity.serverName,
    apiUrl: "https://tommy.example.com",
    logoUrl: null,
    apiOnline: true,
    message: null,
  };
  const control = new ServerMode({
    environment: { controlSocketPath: socketPath },
    version: HOST_VERSION,
    host: {
      getStatus: () => status,
      configure: unused,
      start: () => Effect.succeed(status),
      updateIdentity: unused,
      createPairingCode: () => ({ ...devices.createPairingCode(), publicUrl: "https://tommy.example.com" }),
      listDirectDevices: () => devices.list(),
      revokeDirectDevice: (deviceId) => gateway.revokeDevice(deviceId),
    },
    memory: null,
    onError: () => {},
    uid: process.getuid?.() ?? 0,
  });
  await chmod(socketDirectory, 0o700);
  await Effect.runPromise(control.listen());
  const ask = async (method: string, path: string, body = ""): Promise<Record<string, string>> => {
    const response = await fetch(`http://localhost${path}`, {
      unix: socketPath,
      method,
      ...(method === "POST" ? { body, headers: { "content-type": "application/x-www-form-urlencoded" } } : {}),
    });
    const entries = (await response.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]);
    return { http: String(response.status), ...Object.fromEntries(entries) };
  };
  const pairing = await ask("POST", "/v1/pair");
  assert.equal(pairing.http, "200");
  assert.equal(pairing.url, "https://tommy.example.com");
  const code = pairing.code;
  assert.ok(code);
  const keys = newKeys();
  const pairedResponse = await pairRequest(code, keys.publicKey);
  assert.equal(pairedResponse.status, 200, "The code of the control socket does not pair.");
  const pairedDevice = decodePaired(await pairedResponse.json());
  const listed = await ask("GET", "/v1/devices");
  assert.ok(Object.values(listed).some((line) => line.startsWith(`${pairedDevice.deviceId} `)));
  assert.equal((await ask("POST", "/v1/devices/revoke", "id=not-a-device")).http, "404");
  assert.equal((await ask("POST", "/v1/devices/revoke", `id=${pairedDevice.deviceId}`)).http, "200");
  assert.equal(devices.get(pairedDevice.deviceId), null);
  for (const removedRoute of ["/v1/login/start", "/v1/login/claim", "/v1/mobile-connect", "/v1/logout"])
    assert.equal((await ask("POST", removedRoute)).http, "404");
  await Effect.runPromise(control.close());
  await rm(socketDirectory, { recursive: true, force: true });
});

await step("The pairing link holds the address and the code, and needs HTTPS", async () => {
  const link = createDirectPairingLink({ url: "https://tommy.example.com", code: "ABC234" });
  assert.deepEqual(parseDirectPairingLink(link), { url: "https://tommy.example.com", code: "ABC234" });
  assert.equal(parseDirectPairingLink(createDirectPairingLink({ url: "http://tommy.example.com", code: "A" })), null);
  assert.equal(parseDirectPairingLink("https://example.com/pair?url=https://a.example&code=A"), null);
});

await step("A paired device shows a code that pairs another device, and manages the devices", async () => {
  const client = connect(paired2().deviceId);
  await authenticate(client, paired2());
  const call = (path: string, body: TeamProtocolV2Json = {}, capabilities = [HOST_DEVICES_CAPABILITY]) =>
    rpc(client, path, { method: "POST", body, capabilities });
  const succeeds = async (path: string, body?: TeamProtocolV2Json) => {
    const answer = await call(path, body);
    assert.ok(answer.result, `${path} has no result: ${JSON.stringify(answer.error)}.`);
    assert.equal(answer.result.status, 200);
    return answer.result.body;
  };
  const refusedWith = async (text: string, path: string, body?: TeamProtocolV2Json, capabilities?: string[]) => {
    const answer = await call(path, body, capabilities);
    assert.equal(answer.result, undefined, `${path} was not refused.`);
    assert.ok(answer.error?.message?.includes(text), JSON.stringify(answer.error));
  };

  const listed = decodeHostDevices(await succeeds(HOST_DEVICES_ROUTES.list));
  assert.equal(listed.devices.find((entry) => entry.current)?.id, paired2().deviceId, "The list marks the caller.");
  assert.equal(listed.devices.filter((entry) => entry.current).length, 1);

  const pairing = decodeHostDevicePairing(await succeeds(HOST_DEVICES_ROUTES.pair));
  assert.deepEqual(parseDirectPairingLink(pairing.link), { url: "https://tommy.example.com", code: pairing.code });
  assert.ok(pairing.expiresAt > Date.now());
  const accepted = await pairRequest(pairing.code, newKeys().publicKey);
  assert.equal(accepted.status, 200, "The code from a paired device does not pair.");
  const added = decodePaired(await accepted.json());
  assert.equal((await pairRequest(pairing.code, newKeys().publicKey)).status, 403, "A used code works again.");
  const withAdded = decodeHostDevices(await succeeds(HOST_DEVICES_ROUTES.list));
  assert.ok(withAdded.devices.some((entry) => entry.id === added.deviceId && !entry.current));

  await refusedWith("cannot remove itself", HOST_DEVICES_ROUTES.revoke, { deviceId: paired2().deviceId });
  assert.ok(devices.get(paired2().deviceId), "A device removed itself.");
  await refusedWith("not connected", HOST_DEVICES_ROUTES.revoke, { deviceId: "not-a-device" });
  const removed = decodeHostDevices(await succeeds(HOST_DEVICES_ROUTES.revoke, { deviceId: added.deviceId }));
  assert.ok(!removed.devices.some((entry) => entry.id === added.deviceId));
  assert.equal(devices.get(added.deviceId), null);

  // A client that did not ask for the capability gets no code.
  const before = decodeHostDevicePairing(await succeeds(HOST_DEVICES_ROUTES.pair));
  await refusedWith("Update the server", HOST_DEVICES_ROUTES.pair, {}, []);
  const stillWorks = await pairRequest(before.code, newKeys().publicKey);
  assert.equal(stillWorks.status, 200, "The refused request replaced the code.");
  const extra = decodePaired(await stillWorks.json());
  await succeeds(HOST_DEVICES_ROUTES.revoke, { deviceId: extra.deviceId });
});

// `--hold`: keeps this host up with a new code, so that a dev app can pair with it. SIGTERM ends it.
if (process.argv.includes("--hold")) {
  const held = devices.createPairingCode();
  process.stdout.write(`HOLD ${JSON.stringify({ address: httpBase, code: held.code })}\n`);
  await new Promise<void>((done) => process.once("SIGTERM", () => done()));
}

await step("The gateway stops with no operation left, after each kind of close", async () => {
  // A close from inside a peer operation (the wrong signature above) must not leave it waiting for itself.
  const failing = connect(paired2().deviceId);
  await assert.rejects(authenticate(failing, paired2(), newKeys().privateKey), /closed/);
  const open = connect(paired2().deviceId);
  await authenticate(open, paired2());
  await Effect.runPromise(gateway.stop());
  assert.equal(await open.closed, 1001);
  await assert.rejects(connect(paired2().deviceId).opened);
});

report.passed = report.steps.every((entry) => entry.passed);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

await Effect.runPromise(server.stop());
await runCauseEffect(agents.stop());
database.close();
await rm(root, { recursive: true, force: true });
process.stdout.write(`${report.passed ? "passed" : "failed"}: ${join(OUT, "report.json")}\n`);
process.exit(report.passed ? 0 : 1);
