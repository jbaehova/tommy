// Starts a real loopback host with scratch data for a development client's UI checks.
// No provider is enabled, and no account, user profile or existing database is used.
// Run: bun scripts/ui-smoke-host.ts
// Read .tommy-build/dev-automation/ship/host-connection.json for the address and pairing code.
// Send `pair` on stdin to replace an expired code, or `stop` to close this host.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AGENT_PROVIDERS, type ConversationSnapshot, defaultProviderModel } from "@tommy/contracts/ipc";
import { redactText } from "@tommy/logging";
import { plugin } from "bun";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { SidebarLayoutStore } from "../src/backend/sidebar-layout-store";
import { StorageUsageScanner, StorageUsageService, type StorageUsageSources } from "../src/backend/storage-usage";
import { TommyDatabase } from "../src/backend/tommy-database";
import type { TeamApiBrowser } from "../src/main/team-api/dependencies";

const OUTPUT = resolve(import.meta.dirname, "../.tommy-build/dev-automation/ship/host-connection.json");
const VERSION = "0.0.0-ui-smoke";

// These services import Electron, but this host never creates a native window.
plugin({
  name: "ui-smoke-host-electron-boundary",
  setup(build) {
    class Inert {}
    build.module("electron", () => ({
      loader: "object",
      exports: {
        app: { getPath: () => tmpdir(), getVersion: () => VERSION, isPackaged: false, on: () => undefined },
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

const { DirectDeviceStore } = await import("../src/main/direct-device-store");
const { DirectHostGateway } = await import("../src/main/direct-host-gateway");
const { LocalSkillLibrary } = await import("../src/main/local-skill-library");
const { SkillLearningService } = await import("../src/main/skill-learning-service");
const { SkillMarketplaceService } = await import("../src/main/skill-marketplace-service");
const { TeamApiServer } = await import("../src/main/team-api-server");
const { TeamStore } = await import("../src/main/team-store");

const unused = () => Effect.die(new Error("Browser automation is not enabled on the UI smoke host."));
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

async function main(): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "tommy-ui-smoke-"));
  const userData = join(scratch, "user-data");
  const home = join(scratch, "home");
  // Pi watches its sign-in file even while disabled. Keep that watch in this fixture.
  process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
  const database = new TommyDatabase(userData);
  const store = new AgentStore(userData, home, database);
  const mailbox = new MailboxStore(userData, store.sharedRoot, database);
  const sidebar = new SidebarLayoutStore(join(userData, "sidebar-layout.json"));
  const team = new TeamStore(join(userData, "tommy-team-server-v2.json"));
  const devices = new DirectDeviceStore({ path: join(userData, "tommy-devices-v1.json") });
  const library = new LocalSkillLibrary(join(userData, "local-skills"), () => store.list());
  const skills = new SkillMarketplaceService(
    () => store.list(),
    () => Effect.void,
    library,
  );
  const learning = new SkillLearningService({
    preferencePath: join(userData, "skill-learning.json"),
    skills,
    redact: redactText,
  });
  const agents = new AgentService({
    store,
    mailbox,
    browser: agentBrowser,
    sidebarLayout: sidebar,
    offProviders: AGENT_PROVIDERS,
    memoryReviewInterval: () => 0,
    skillLearning: () => learning.get().mode,
    skillLearner: learning.learner(),
  });
  const sources: StorageUsageSources = {
    roots: {
      database: database.path,
      downloads: store.downloadsRoot,
      caches: [join(userData, "caches")],
      logs: [join(userData, "logs")],
      runtimes: null,
      data: userData,
    },
    database: () => database.connection,
    mailbox,
    agents: () => store.list(),
  };
  const storage = new StorageUsageService(new StorageUsageScanner(sources), sources);
  let gateway: InstanceType<typeof DirectHostGateway> | null = null;
  let server: InstanceType<typeof TeamApiServer> | null = null;
  let stopLearningListener: (() => void) | null = null;
  let stopRequested = false;
  let finish: () => void = () => {};
  const stopped = new Promise<void>((done) => {
    finish = done;
  });
  const stop = () => {
    stopRequested = true;
    finish();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await runCauseEffect(sidebar.initialize());
    await runCauseEffect(team.initialize());
    await runCauseEffect(learning.load());
    await runCauseEffect(agents.initialize());
    await runCauseEffect(devices.load());
    const identity = await runCauseEffect(team.configure("Example workspace", "Example owner", "example-password-123"));
    const ownerMemberId = team.getOwnerMemberId();
    assert.ok(ownerMemberId, "The scratch host needs an owner.");
    const created = await runCauseEffect(
      store.createAgent({
        name: "Review assistant",
        description: "A scratch workspace for UI verification.",
        avatarSeed: "example-review",
        avatarHue: null,
      }),
    );
    const agent = await runCauseEffect(
      store.updateAgent({
        agentId: created.id,
        provider: "codex",
        model: defaultProviderModel("codex"),
        computerUse: false,
        notifications: false,
      }),
    );
    const threadId = store.ensureThreadIdNow(agent.id);
    const source = join(agent.workspacePath, "review-checklist.txt");
    await writeFile(source, "Review the result. Record checks and remaining limits.\n", { mode: 0o600 });
    const handle = await open(source, "r");
    const attachments = await runCauseEffect(
      mailbox.stageGeneratedAttachments({
        sources: [{ path: source, handle }],
        ownerAgentId: agent.id,
        ownerThreadId: threadId,
      }),
    ).finally(() => handle.close());
    const now = new Date().toISOString();
    const snapshot: ConversationSnapshot = {
      agentId: agent.id,
      threadId,
      activeTurnId: null,
      revision: 0,
      messages: [
        {
          id: "ui-smoke-request",
          author: "user",
          text: "Prepare a review checklist.",
          createdAt: now,
          status: "completed",
          senderMember: { id: ownerMemberId, name: "Example owner" },
        },
        {
          id: "ui-smoke-answer",
          author: "assistant",
          text: "The checklist is ready. It contains the result, checks and remaining limits.",
          createdAt: now,
          status: "completed",
          attachments,
        },
      ],
    };
    mailbox.persistGeneratedAttachmentsWithConversation(
      snapshot,
      "ui-smoke.seeded",
      {},
      attachments.map(({ id }) => id),
    );
    await runCauseEffect(store.updatePreview(agent.id, "The review checklist is ready."));
    agents.createRoutine({
      agentId: agent.id,
      name: "Review checklist",
      instruction: "Read the checklist and report the result.",
      active: false,
      timezone: "UTC",
      schedule: { kind: "daily", time: "09:00" },
      runIn: "thread",
    });
    await runCauseEffect(
      learning.learner().save(
        agent.id,
        {
          action: "create",
          name: "Review checklist",
          description: "Check repeatable work before delivery.",
          instructions: "1. Read the requested outcome.\n2. Check the result.\n3. Report the remaining limits.",
        },
        "suggestion:ui-smoke:review-checklist",
      ),
    );
    server = new TeamApiServer({
      store: team,
      agents,
      mailbox,
      browser: teamBrowser,
      channels: agents.channels,
      sidebarLayout: sidebar,
      storage,
      messageDeletion: agents,
      skillLearning: {
        snapshot: () => learning.snapshot(),
        set: (input) => learning.set(input),
        save: (input) => agents.saveSkillSuggestion(input).pipe(Effect.map((saved) => ({ saved }))),
        restore: (input) => learning.restore(input),
        listLocalSkills: () => learning.listLocalSkills(),
        readLocalSkill: (input) => learning.readLocalSkill(input),
      },
      admin: {
        skills,
        sessionSettings: agents,
        devices: {
          list: () => devices.list(),
          createPairingCode: () => ({ ...devices.createPairingCode(), publicUrl: null }),
          revoke: (deviceId) => gateway?.revokeDevice(deviceId) ?? Effect.void,
        },
      },
      appVersion: VERSION,
    });
    const localApiPort = await runCauseEffect(server.start());
    gateway = new DirectHostGateway({
      store: team,
      appVersion: VERSION,
      transferDirectory: join(scratch, "transfers"),
      devices,
      owner: () => ({ membershipId: ownerMemberId, userId: ownerMemberId }),
      listen: { host: "127.0.0.1", port: 0 },
    });
    const port = await runCauseEffect(gateway.start({ hostId: identity.serverId, localApiPort }));
    stopLearningListener = learning.onChange(() => Effect.runFork(agents.skillLearningChanged()));
    agents.on("event", () => storage.invalidate());
    const writeConnection = async () => {
      if (stopRequested) return;
      const pairing = devices.createPairingCode();
      await mkdir(dirname(OUTPUT), { recursive: true, mode: 0o700 });
      await writeFile(
        OUTPUT,
        `${JSON.stringify({ ready: true, pid: process.pid, address: `http://127.0.0.1:${port}`, ...pairing, agentId: agent.id, scratch }, null, 2)}\n`,
        { mode: 0o600 },
      );
      await chmod(OUTPUT, 0o600);
    };
    await writeConnection();
    process.stdout.write("Scratch host is ready. Pairing details are in the private connection artifact.\n");
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      input += chunk;
      for (;;) {
        const newline = input.indexOf("\n");
        if (newline < 0) break;
        const command = input.slice(0, newline).trim();
        input = input.slice(newline + 1);
        if (command === "stop") stop();
        if (command === "pair") void writeConnection().catch(stop);
      }
    });
    await stopped;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    stopLearningListener?.();
    if (gateway) await runCauseEffect(gateway.stop());
    if (server) await runCauseEffect(server.stop());
    await runCauseEffect(storage.dispose());
    await runCauseEffect(agents.stop());
    database.close();
    await rm(scratch, { recursive: true, force: true });
    await writeFile(OUTPUT, `${JSON.stringify({ ready: false, pid: process.pid })}\n`, { mode: 0o600 });
    await chmod(OUTPUT, 0o600);
    process.stdin.pause();
  }
}

void main().catch(() => {
  process.stderr.write("The scratch UI host failed. No user profile was used.\n");
  process.exitCode = 1;
});
