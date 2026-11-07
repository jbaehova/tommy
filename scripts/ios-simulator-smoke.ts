// Checks the iPhone app in an iOS simulator against a real host: a real `TeamApiServer` and team store
// on a temporary profile, with `DirectHostGateway` behind a local TLS proxy whose certificate the
// simulator trusts. The app pairs with a one-time code, shows the agents and a chat, and opens the dock
// pages, in light and dark appearance. Maestro drives the app; each step waits for text on screen.
// Run: `bun scripts/ios-simulator-smoke.ts <path to Tommy.app>`. Needs Xcode, `maestro` and `openssl`.
// Writes .tommy-build/ios-simulator-smoke/report.json and one screenshot for each step.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:tls";
import { plugin } from "bun";
import { Effect, Schema } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { SidebarLayoutStore } from "../src/backend/sidebar-layout-store";
import { TommyDatabase } from "../src/backend/tommy-database";
import type { TeamApiBrowser } from "../src/main/team-api/dependencies";

const OUT = resolve(import.meta.dirname, "../.tommy-build/ios-simulator-smoke");
const HOST_VERSION = "0.0.0-ios-smoke";
const BUNDLE_ID = "app.tommy.mobile";
const app = process.argv[2];
assert.ok(app, "Usage: bun scripts/ios-simulator-smoke.ts <path to Tommy.app>");

// The main process imports Electron for its windows and IPC. No check here opens a window.
plugin({
  name: "ios-smoke-electron-boundary",
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

const unused = () => Effect.die(new Error("Not used by this check."));
const agentBrowser: AgentBrowserHost = {
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

/** The agents of the host, with a short chat each. The reply has the Markdown that a chat shows most. */
const AGENTS = [
  {
    name: "Research",
    description: "Finds sources and sums them up.",
    question: "아이폰에서 잘 보이는지 확인해 줘.",
    answer: [
      "The iPhone app connected. Here is what I checked:",
      "",
      "- The **chat** list and the dock",
      "- Hangul: 한국어 문장도 잘 보여요.",
      "- `inline code` and a block:",
      "",
      "```ts",
      'const greeting = "Hello from Tommy";',
      "```",
    ].join("\n"),
  },
  { name: "Writer", description: "Drafts posts and replies.", question: "Draft a short note.", answer: "Done." },
] as const;

const root = await mkdtemp(join(tmpdir(), "ios-simulator-smoke-"));
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
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
const identity = await runCauseEffect(team.configure("Smoke Host", "owner-user", "owner-password-123"));
// The chats are written before the service loads them, so no provider runs a turn.
const started = Date.now() - 10 * 60_000;
for (const [index, input] of AGENTS.entries()) {
  const agent = await runCauseEffect(
    agentStore.createAgent({
      name: input.name,
      description: input.description,
      avatarSeed: input.name.toLowerCase(),
      avatarHue: null,
    }),
  );
  const threadId = agentStore.ensureThreadIdNow(agent.id);
  const turnId = randomUUID();
  const at = (offset: number) => new Date(started + index * 60_000 + offset).toISOString();
  for (const message of [
    { id: randomUUID(), author: "user" as const, text: input.question, createdAt: at(0), status: "completed" as const },
    {
      id: randomUUID(),
      turnId,
      author: "assistant" as const,
      text: input.answer,
      createdAt: at(5_000),
      status: "completed" as const,
    },
  ]) {
    database.appendConversationMessage({
      agentId: agent.id,
      threadId,
      activeTurnId: null,
      message,
      eventType: "message.created",
    });
  }
}
const agents = new AgentService({ store: agentStore, mailbox, browser: agentBrowser, sidebarLayout: sidebar });
await runCauseEffect(agents.initialize());
const devices = new DirectDeviceStore({ path: join(userData, "tommy-devices-v1.json") });
await Effect.runPromise(devices.load());
const server = new TeamApiServer({
  store: team,
  agents,
  mailbox,
  browser: teamBrowser,
  sidebarLayout: sidebar,
  appVersion: HOST_VERSION,
});
const apiPort = await Effect.runPromise(server.start());
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
const gatewayPort = await Effect.runPromise(gateway.start({ hostId: identity.serverId, localApiPort: apiPort }));

// --- TLS, as the reverse proxy of a real server holds it ---

const certificates = join(root, "certificates");
mkdirSync(certificates);
const openssl = (args: string[]) => execFileSync("openssl", args, { cwd: certificates, stdio: "pipe" });
openssl(
  ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=Tommy Smoke CA"]
    .concat(["-keyout", "ca.key", "-out", "ca.pem", "-addext", "basicConstraints=critical,CA:TRUE"])
    .concat(["-addext", "keyUsage=critical,keyCertSign,cRLSign"]),
);
openssl([
  "req",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-subj",
  "/CN=localhost",
  "-keyout",
  "server.key",
  "-out",
  "server.csr",
]);
writeFileSync(
  join(certificates, "server.ext"),
  "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n",
);
openssl(
  ["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2"].concat([
    "-extfile",
    "server.ext",
    "-out",
    "server.pem",
  ]),
);
const proxy = createServer(
  { key: readFileSync(join(certificates, "server.key")), cert: readFileSync(join(certificates, "server.pem")) },
  (socket) => {
    const upstream = connect(gatewayPort, "127.0.0.1");
    socket.pipe(upstream).pipe(socket);
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    socket.on("error", close);
    upstream.on("error", close);
  },
);
const tlsPort = await new Promise<number>((done) =>
  proxy.listen(0, "127.0.0.1", () => {
    const address = proxy.address();
    done(typeof address === "object" && address ? address.port : 0);
  }),
);
const serverAddress = `https://localhost:${tlsPort}`;
// The certificate holds for the address that the app types, before a simulator starts.
const probe = await fetch(serverAddress, { tls: { ca: readFileSync(join(certificates, "ca.pem"), "utf8") } });
assert.equal(probe.status, 404, "The host does not answer over TLS.");

// --- Simulator ---

const Devices = Schema.Struct({
  devices: Schema.Record(
    Schema.String,
    Schema.Array(Schema.Struct({ udid: Schema.String, name: Schema.String, isAvailable: Schema.Boolean })),
  ),
});
const simctl = (...args: string[]) => execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8" });
const listed = Schema.decodeUnknownSync(Devices)(JSON.parse(simctl("list", "devices", "available", "--json")));
const runtimes = Object.keys(listed.devices)
  .filter((runtime) => runtime.includes("iOS"))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const runtime = runtimes.at(-1);
assert.ok(runtime, "No iOS simulator runtime is installed.");
const phones = (listed.devices[runtime] ?? []).filter(
  (device) => device.isAvailable && /^iPhone \d+/u.test(device.name),
);
const phone = phones.find((device) => / Pro$/u.test(device.name)) ?? phones[0];
assert.ok(phone, `No iPhone simulator for ${runtime}.`);
const device = phone.udid;
spawnSync("xcrun", ["simctl", "boot", device], { stdio: "inherit" });
simctl("bootstatus", device, "-b");
simctl("keychain", device, "add-root-cert", join(certificates, "ca.pem"));
simctl("install", device, resolve(app));
simctl("privacy", device, "grant", "notifications", BUNDLE_ID);
// The status bar of each screenshot is the same.
simctl("status_bar", device, "override", "--time", "9:41", "--batteryState", "charged", "--batteryLevel", "100");

const steps: { name: string; passed: boolean; detail?: string }[] = [];

/** Runs one Maestro flow. Its screenshots go to the output folder. */
function flow(name: string, commands: string): void {
  const file = join(root, `${name}.yaml`);
  writeFileSync(file, `appId: ${BUNDLE_ID}\n---\n${commands.trim()}\n`);
  const result = spawnSync(
    "maestro",
    ["--device", device, "test", file, "--test-output-dir", join(OUT, `maestro-${name}`), "--format", "noop"],
    { cwd: OUT, encoding: "utf8", env: { ...process.env, MAESTRO_CLI_NO_ANALYTICS: "1" } },
  );
  const passed = result.status === 0;
  steps.push({ name, passed, ...(passed ? {} : { detail: `${result.stdout}\n${result.stderr}`.slice(-4_000) }) });
  if (!passed) process.stderr.write(`Flow ${name} failed:\n${result.stdout}\n${result.stderr}\n`);
}

const waitFor = (text: string) => `- extendedWaitUntil:\n    visible: "${text}"\n    timeout: 60000`;

try {
  simctl("ui", device, "appearance", "light");
  flow(
    "pair",
    `
- launchApp:
    clearState: true
${waitFor("Connect to your server")}
- takeScreenshot: light-01-pair
- tapOn: "Server address"
- inputText: "${serverAddress}"
- tapOn: "Pairing code"
- inputText: "${devices.createPairingCode().code}"
- takeScreenshot: light-02-pair-filled
- tapOn: "Connect"
${waitFor(AGENTS[0].name)}
- takeScreenshot: light-03-agents
- tapOn: "${AGENTS[0].name}"
${waitFor("Hangul.*")}
- takeScreenshot: light-04-chat
- tapOn: "Message ${AGENTS[0].name}.*"
- inputText: "Hello"
- takeScreenshot: light-05-composer
- hideKeyboard
- swipe:
    start: 2%, 50%
    end: 80%, 50%
    duration: 400
${waitFor("Agents")}
- tapOn: "Threads"
- takeScreenshot: light-06-threads
- tapOn: "Routines"
- takeScreenshot: light-07-routines
- tapOn: "Settings"
${waitFor("Settings")}
- takeScreenshot: light-08-settings
`,
  );
  simctl("ui", device, "appearance", "dark");
  flow(
    "dark",
    `
- launchApp:
    stopApp: true
${waitFor(AGENTS[0].name)}
- takeScreenshot: dark-01-agents
- tapOn: "${AGENTS[0].name}"
${waitFor("Hangul.*")}
- takeScreenshot: dark-02-chat
- swipe:
    start: 2%, 50%
    end: 80%, 50%
    duration: 400
- tapOn: "Settings"
${waitFor("Settings")}
- takeScreenshot: dark-03-settings
`,
  );
} finally {
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ device: phone.name, runtime, steps }, null, 2)}\n`);
  proxy.close();
  await Effect.runPromise(gateway.stop()).catch(() => undefined);
  await Effect.runPromise(server.stop()).catch(() => undefined);
}
const failed = steps.filter((step) => !step.passed);
process.stdout.write(
  `${steps.length - failed.length} of ${steps.length} flows passed on ${phone.name} (${runtime}).\n`,
);
process.exit(failed.length ? 1 : 0);
