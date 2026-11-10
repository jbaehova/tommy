// Drives the production transfer service, archive reader, skill library and installer on scratch
// files. The agent administration port uses a scratch roster; no provider, app or user DB starts.
// Run: bun scripts/instance-transfer-stream-e2e.ts
// Writes .tommy-build/instance-transfer-stream-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type AgentSummary, defaultProviderModel } from "@tommy/contracts/ipc";
import { sourceText } from "@tommy/i18n/source";
import { Effect, Schema } from "effect";
import { unzipSync, zipSync } from "fflate";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { type InstanceTransferOptions, InstanceTransferService } from "../src/main/instance-transfer-service";
import { LocalSkillLibrary } from "../src/main/local-skill-library";
import { SkillMarketplaceService } from "../src/main/skill-marketplace-service";

const output = resolve(".tommy-build/instance-transfer-stream-e2e");
const scratch = await mkdtemp(join(tmpdir(), "tommy-transfer-stream-"));
const report: { passed: boolean; checks: string[]; failure?: string } = { passed: false, checks: [] };
const record = (check: string) => report.checks.push(check);
const model = defaultProviderModel("codex");
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5S0AAAAASUVORK5CYII=",
  "base64",
);

function agent(id: string, workspacePath: string): AgentSummary {
  return {
    id,
    name: "Example agent",
    title: "Example role",
    description: "An example agent.",
    notifications: true,
    provider: "codex",
    model,
    reasoningEffort: "medium",
    threadId: null,
    workspacePath,
    preview: "",
    updatedAt: null,
    avatarSeed: "example-agent",
    avatarHue: null,
    avatarUrl: null,
  };
}

async function makeHost(folder: string, initial: AgentSummary[] = []) {
  const roster = [...initial];
  const sharedRoot = join(folder, "Shared");
  const avatars = new Map<string, string>();
  let createCount = 0;
  let failUpdate = false;
  await mkdir(sharedRoot, { recursive: true });
  const library = new LocalSkillLibrary(join(folder, "local-skills"), () => roster);
  const skills = new SkillMarketplaceService(
    () => roster,
    () => Effect.void,
    library,
  );
  const required = (id: string) => {
    const found = roster.find((candidate) => candidate.id === id);
    if (!found) throw new Error("The scratch agent is missing.");
    return found;
  };
  const options: InstanceTransferOptions = {
    appVersion: "1.0.0",
    sharedRoot,
    uploadDirectory: join(folder, "uploads"),
    timezone: () => "UTC",
    agents: {
      listAgents: () => roster,
      listRoutines: () => [],
      listMemories: () => [],
      getMemorySelection: () => ({ selections: [] }),
      setMemoryInclusion: () => undefined,
      resolveAvatar: (id) => {
        const path = avatars.get(id);
        return path ? { path, mimeType: "image/png" } : null;
      },
      listModels: () => [{ provider: "codex", id: model }],
      createAgentProfile: (input) =>
        Effect.tryPromise(async () => {
          const id = randomUUID();
          const created = { ...agent(id, join(folder, "agents", id)), ...input };
          await mkdir(created.workspacePath, { recursive: true });
          await writeFile(join(created.workspacePath, "README.md"), "Keep the host README.\n");
          roster.push(created);
          createCount += 1;
          return created;
        }),
      updateAgent: (input) =>
        Effect.try(() => {
          if (failUpdate) throw new Error("A scratch update failed.");
          const found = required(input.agentId);
          if (input.notifications !== undefined) found.notifications = input.notifications;
          return found;
        }),
      createRoutine: () => {
        throw new Error("This fixture has no routines.");
      },
      createMemory: () => {
        throw new Error("This fixture has no memories.");
      },
      memoryLimit: () => 100,
      initializeMemorySelection: () => {},
      setAvatar: (id, avatar) =>
        Effect.tryPromise(async () => {
          const found = required(id);
          if (avatar) {
            const path = join(folder, `${id}-avatar.png`);
            await writeFile(path, avatar.bytes);
            avatars.set(id, path);
          }
          return found;
        }),
      deleteAgent: (id) =>
        Effect.tryPromise(async () => {
          const found = required(id);
          await rm(found.workspacePath, { recursive: true, force: true });
          const path = avatars.get(id);
          if (path) await rm(path, { force: true });
          avatars.delete(id);
          roster.splice(roster.indexOf(found), 1);
        }),
    },
    skills: { library: () => library, installLocal: (input) => skills.installLocal(input) },
    settings: {
      mcpServers: () => [],
      saveMcpServer: () => Effect.void,
      providersOff: () => [],
      sidebar: () => ({
        revision: 0,
        sections: [],
        order: ["people", "unassigned"],
        agentAssignments: {},
        agentOrder: [],
      }),
      mutateSidebar: () =>
        Effect.succeed({
          revision: 0,
          sections: [],
          order: ["people", "unassigned"],
          agentAssignments: {},
          agentOrder: [],
        }),
      routineFlowLinks: () => Effect.succeed([]),
      connectRoutineFlow: () => Effect.void,
      signedInProviders: () => ["codex"],
    },
  };
  return {
    service: new InstanceTransferService(options),
    roster,
    skills,
    library,
    sharedRoot,
    avatars,
    createCount: () => createCount,
    failUpdate: (value: boolean) => {
      failUpdate = value;
    },
  };
}

try {
  const sourceWorkspace = join(scratch, "source", "workspace");
  const sourceAgent = agent("source-agent", sourceWorkspace);
  const source = await makeHost(join(scratch, "source"), [sourceAgent]);
  const sourceSkill = join(sourceWorkspace, ".agents", "skills", "example-guide");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(
    join(sourceSkill, "SKILL.md"),
    "---\nname: Example guide\ndescription: Follow a reusable example procedure.\n---\nCheck the input, then report the result.\n",
  );
  await writeFile(join(sourceSkill, "guide.txt"), "A second skill file.\n");
  await writeFile(join(sourceWorkspace, "README.md"), "An exported workspace README.\n");
  await writeFile(join(sourceWorkspace, "run.sh"), "#!/bin/sh\nprintf 'example'\n");
  await chmod(join(sourceWorkspace, "run.sh"), 0o700);
  await writeFile(join(sourceWorkspace, ".env"), "EXAMPLE_SECRET=do-not-transfer\n");
  await mkdir(join(source.sharedRoot, "linked"), { recursive: true });
  await mkdir(join(source.sharedRoot, "data"), { recursive: true });
  await writeFile(join(source.sharedRoot, "report.txt"), "An exported shared report.\n");
  await writeFile(join(source.sharedRoot, "new.txt"), "A new shared file.\n");
  await writeFile(join(source.sharedRoot, "linked", "outside.txt"), "Must stay inside Shared.\n");
  await writeFile(join(source.sharedRoot, "data", "shared.db"), "Must not transfer.\n");
  const sourceAvatar = join(scratch, "source", "avatar.png");
  await writeFile(sourceAvatar, image);
  source.avatars.set(sourceAgent.id, sourceAvatar);
  const archivePath = join(scratch, "transfer.zip");
  await runCauseEffect(
    source.service.exportTo(archivePath, { agentIds: [sourceAgent.id], includeFiles: true, includeSettings: false }),
  );
  const original = new Uint8Array(await readFile(archivePath));
  const archive = unzipSync(original);
  const manifest = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.Number, format: Schema.String }))(
    JSON.parse(new TextDecoder().decode(archive["tommy-transfer.json"])),
  );
  assert.equal(manifest.version, 1);
  assert.equal(manifest.format, "tommy-instance-transfer");
  assert.ok(!Object.keys(archive).some((name) => name.endsWith("/.env") || name === "shared/data/shared.db"));
  record("The existing v1 export keeps its fields and excludes secrets and Shared data.");

  const target = await makeHost(join(scratch, "target"));
  await writeFile(join(target.sharedRoot, "report.txt"), "Keep the host report.\n");
  const outside = join(scratch, "outside");
  await mkdir(outside);
  await symlink(outside, join(target.sharedRoot, "linked"));
  const preview = await runCauseEffect(target.service.stage(archivePath));
  assert.equal(preview.agents.length, 1);
  assert.equal(preview.agents[0]?.skillCount, 1);
  const result = await runCauseEffect(
    target.service.apply({
      token: preview.token,
      keys: preview.agents.map((entry) => entry.key),
      includeSettings: false,
    }),
  );
  assert.equal(result.skipped.length, 0);
  const imported = result.agents[0];
  assert.ok(imported);
  assert.equal(await readFile(join(imported.workspacePath, "README.md"), "utf8"), "Keep the host README.\n");
  assert.equal(
    await readFile(join(imported.workspacePath, "README (2).md"), "utf8"),
    "An exported workspace README.\n",
  );
  assert.ok(((await stat(join(imported.workspacePath, "run.sh"))).mode & 0o111) !== 0);
  assert.equal(await readFile(join(target.sharedRoot, "report.txt"), "utf8"), "Keep the host report.\n");
  assert.equal(await readFile(join(target.sharedRoot, "new.txt"), "utf8"), "A new shared file.\n");
  assert.deepEqual(await readdir(outside), []);
  assert.ok(result.warnings.length >= 2);
  const installed = await runCauseEffect(target.skills.listInstalled(imported.id));
  assert.equal(installed.filter((skill) => skill.name === "Example guide").length, 1);
  assert.deepEqual(await readFile(target.avatars.get(imported.id) ?? ""), image);
  assert.equal(
    await stat(join(imported.workspacePath, ".tommy", "import-skills", "example-guide")).then(
      () => true,
      () => false,
    ),
    false,
  );
  record(
    "Stage and Apply use the real library and installer, preserve conflicts and execute bits, and refuse Shared symlinks.",
  );

  const skippedPath = join(scratch, "with-skipped-folders.zip");
  await writeFile(
    skippedPath,
    zipSync({
      ...archive,
      "agents/0/files/.git/config": new TextEncoder().encode("A skipped git config."),
      "agents/0/files/node_modules/example/package.json": new TextEncoder().encode("{}"),
    }),
  );
  const skippedPreview = await runCauseEffect(target.service.stage(skippedPath));
  const skippedWarning = sourceText("error.import.transferUnsafeFilesSkipped", { number: 2 });
  assert.ok(skippedPreview.warnings.includes(skippedWarning));
  await runCauseEffect(target.service.discard(skippedPreview.token));
  record("A foreign archive reports the number of skipped .git and node_modules files before Apply.");

  const changed = await runCauseEffect(target.service.stage(archivePath));
  const changedFiles = { ...archive, "shared/new.txt": new TextEncoder().encode("Changed after staging.\n") };
  await writeFile(archivePath, zipSync(changedFiles));
  const beforeChange = target.createCount();
  await assert.rejects(
    runCauseEffect(
      target.service.apply({
        token: changed.token,
        keys: changed.agents.map((entry) => entry.key),
        includeSettings: false,
      }),
    ),
  );
  assert.equal(target.createCount(), beforeChange);
  await writeFile(archivePath, original);
  record("A changed compressed file fingerprint is refused before an agent is created.");

  const beforeFailure = target.roster.length;
  const beforeVersions = (await runCauseEffect(target.library.list())).map((skill) => [skill.id, skill.version]);
  const failPreview = await runCauseEffect(target.service.stage(archivePath));
  target.failUpdate(true);
  const failed = await runCauseEffect(
    target.service.apply({
      token: failPreview.token,
      keys: failPreview.agents.map((entry) => entry.key),
      includeSettings: false,
    }),
  );
  target.failUpdate(false);
  assert.equal(failed.agents.length, 0);
  assert.equal(failed.skipped.length, 1);
  assert.equal(target.roster.length, beforeFailure);
  assert.deepEqual(
    (await runCauseEffect(target.library.list())).map((skill) => [skill.id, skill.version]),
    beforeVersions,
  );
  record("A later agent failure removes its scratch workspace and withdraws only its published skill revision.");

  const remote = await makeHost(join(scratch, "remote"));
  const upload = await runCauseEffect(remote.service.stageUpload(() => Promise.resolve(original), "member-example"));
  await assert.rejects(
    runCauseEffect(
      remote.service.apply(
        { token: upload.token, keys: upload.agents.map((entry) => entry.key), includeSettings: false },
        "another-member",
      ),
    ),
  );
  assert.equal(remote.roster.length, 0);
  const uploaded = await runCauseEffect(
    remote.service.apply(
      { token: upload.token, keys: upload.agents.map((entry) => entry.key), includeSettings: false },
      "member-example",
    ),
  );
  assert.equal(uploaded.agents.length, 1);
  assert.deepEqual(await readdir(join(scratch, "remote", "uploads")), []);
  record("The existing remote upload remains owner-scoped and removes its temporary archive after Apply.");

  const discard = await runCauseEffect(remote.service.stageUpload(() => Promise.resolve(original), "member-example"));
  await runCauseEffect(remote.service.discard(discard.token, "member-example"));
  assert.deepEqual(await readdir(join(scratch, "remote", "uploads")), []);
  record("Discard removes only the staged remote file and creates no agent.");
  report.passed = true;
} catch (failure) {
  report.failure = failure instanceof Error ? failure.message : "The transfer check failed.";
  process.exitCode = 1;
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rm(scratch, { recursive: true, force: true });
}
