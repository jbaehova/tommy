// Drives the real host skill service, immutable library, installer and cursor store in a scratch
// profile. No provider, account, user database or running app is used.
// Run: bun scripts/skill-learning-e2e.ts
// Artifact: .tommy-build/skill-learning-e2e/report.json
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import type { AgentSummary } from "@tommy/contracts/ipc";
import { sourceText } from "@tommy/i18n/source";
import { Deferred, Effect } from "effect";
import { zipSync } from "fflate";
import { MemoryReviewCursors } from "../src/backend/agent/memory-review-store";
import type { LearnedSkillDraft } from "../src/backend/agent/skill-learning";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { LocalSkillLibrary } from "../src/main/local-skill-library";
import { SkillLearningService } from "../src/main/skill-learning-service";
import { SkillMarketplaceService } from "../src/main/skill-marketplace-service";

const OUT = resolve(import.meta.dirname, "../.tommy-build/skill-learning-e2e");
const report: { passed: boolean; checks: string[]; failure?: string } = { passed: false, checks: [] };
const scratch = await mkdtemp(join(tmpdir(), "tommy-skill-learning-"));
const workspace = join(scratch, "workspace");
const preferencePath = join(scratch, "skill-learning.json");
const reached = Effect.runSync(Deferred.make<void>());
const release = Effect.runSync(Deferred.make<void>());
let holdRefresh = false;
const agent: AgentSummary = {
  id: "agent-learning-e2e",
  name: "Example agent",
  title: "",
  description: "",
  notifications: false,
  provider: "codex",
  model: "example-model",
  reasoningEffort: "medium",
  threadId: null,
  workspacePath: workspace,
  preview: "",
  updatedAt: null,
  avatarSeed: "example",
  avatarHue: null,
  avatarUrl: null,
};
const libraryRoot = join(scratch, "library");
const library = new LocalSkillLibrary(libraryRoot, () => [agent]);
const skills = new SkillMarketplaceService(
  () => [agent],
  () =>
    holdRefresh ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void,
  library,
);
const redact = (text: string) => text.replaceAll("EXAMPLE_PRIVATE_TOKEN_123", "[REDACTED]");
const service = new SkillLearningService({ preferencePath, skills, redact });
const draft: LearnedSkillDraft = {
  action: "create",
  name: "작업 결과 검토",
  description: "Review repeatable work before delivery.",
  instructions: "1. Read the requested outcome.\n2. Check the result against it.\n3. Report the check.",
};

function checked(name: string): void {
  report.checks.push(name);
}

try {
  await mkdir(workspace, { recursive: true });
  await runCauseEffect(service.load());
  assert.equal(service.get().mode, "ask");
  checked("A new profile defaults to Ask first.");

  const [first, duplicate] = await Promise.all([
    runCauseEffect(service.learner().save(agent.id, draft, "suggestion:example:message-1")),
    runCauseEffect(service.learner().save(agent.id, draft, "suggestion:example:message-1")),
  ]);
  assert.equal(first.skillId, duplicate.skillId);
  assert.equal(first.revision, 1);
  assert.equal(duplicate.revision, 1);
  assert.equal((await runCauseEffect(library.list())).length, 1);
  checked("Concurrent Save calls publish and install one revision, including a Korean skill name.");

  const restartedLibrary = new LocalSkillLibrary(libraryRoot, () => [agent]);
  const restartedSkills = new SkillMarketplaceService(
    () => [agent],
    () => Effect.void,
    restartedLibrary,
  );
  const restarted = new SkillLearningService({ preferencePath, skills: restartedSkills, redact });
  await runCauseEffect(restarted.load());
  const repeated = await runCauseEffect(restarted.learner().save(agent.id, draft, "suggestion:example:message-1"));
  assert.equal(repeated.skillId, first.skillId);
  assert.equal(repeated.revision, 1);
  checked("A Save receipt survives service and library restart.");

  const update: LearnedSkillDraft = {
    action: "update",
    skillId: first.skillId,
    expectedRevision: 1,
    description: "Review work and report its limits.",
    instructions: "1. Check the result.\n2. State unverified limits.",
  };
  const firstDetail = await runCauseEffect(library.get(first.skillId));
  const installedFile = join(workspace, ".agents", "skills", firstDetail.slug, "SKILL.md");
  const installedBytes = await readFile(installedFile);
  await writeFile(installedFile, "A manual edit that the installer must preserve.\n");
  await assert.rejects(runCauseEffect(service.learner().save(agent.id, update, "suggestion:example:message-2")));
  assert.equal((await runCauseEffect(library.get(first.skillId))).version, 2);
  assert.equal(
    (await runCauseEffect(skills.listInstalled(agent.id))).find((skill) => skill.skillId === first.skillId)
      ?.installedVersion,
    1,
  );
  await writeFile(installedFile, installedBytes);
  const retryLibrary = new LocalSkillLibrary(libraryRoot, () => [agent]);
  const retrySkills = new SkillMarketplaceService(
    () => [agent],
    () => Effect.void,
    retryLibrary,
  );
  const retryService = new SkillLearningService({ preferencePath, skills: retrySkills, redact });
  await runCauseEffect(retryService.load());
  const second = await runCauseEffect(retryService.learner().save(agent.id, update, "suggestion:example:message-2"));
  assert.equal(second.revision, 2);
  assert.equal(
    (await runCauseEffect(retrySkills.listInstalled(agent.id))).find((skill) => skill.skillId === first.skillId)
      ?.installedVersion,
    2,
  );
  checked("A published update whose real installer failed retries after restart and installs its revision once.");

  await runCauseEffect(retrySkills.installLocal({ agentId: agent.id, skillId: first.skillId, revision: 1 }));
  const manualLibrary = new LocalSkillLibrary(libraryRoot, () => [agent]);
  const manualSkills = new SkillMarketplaceService(
    () => [agent],
    () => Effect.void,
    manualLibrary,
  );
  const manualService = new SkillLearningService({ preferencePath, skills: manualSkills, redact });
  await runCauseEffect(manualService.load());
  await runCauseEffect(manualService.learner().save(agent.id, update, "suggestion:example:message-2"));
  assert.equal(
    (await runCauseEffect(manualSkills.listInstalled(agent.id))).find((skill) => skill.skillId === first.skillId)
      ?.installedVersion,
    1,
  );
  checked("A completed Save receipt preserves a later explicit install of an older revision across restart.");
  await assert.rejects(
    runCauseEffect(
      service.learner().save(
        agent.id,
        {
          action: "update",
          skillId: first.skillId,
          expectedRevision: 1,
          description: "A stale edit.",
          instructions: "Do not replace a concurrent revision.",
        },
        "suggestion:example:stale",
      ),
    ),
  );
  assert.equal((await runCauseEffect(library.get(first.skillId, 1))).instructions, draft.instructions);
  checked("expectedRevision rejects a stale edit and leaves every previous revision intact.");

  const restoreInput = {
    agentId: agent.id,
    skillId: first.skillId,
    revision: 1,
    expectedRevision: 2,
    requestId: "restore-example",
  };
  const restored = await runCauseEffect(service.restore(restoreInput));
  assert.equal(restored.revision, 3);
  assert.equal((await runCauseEffect(library.get(first.skillId))).instructions, draft.instructions);
  assert.equal((await runCauseEffect(service.restore(restoreInput))).revision, 3);
  checked("Restore publishes old content as a new revision and a repeated restore is idempotent.");

  await runCauseEffect(restarted.learner().save(agent.id, draft, "suggestion:example:message-1"));
  assert.equal(
    (await runCauseEffect(restartedSkills.listInstalled(agent.id))).find((skill) => skill.skillId === first.skillId)
      ?.installedVersion,
    3,
  );
  checked("An old Save replay does not replace a later installed revision.");

  await runCauseEffect(service.set({ mode: "automatic" }));
  await runCauseEffect(skills.installLocal({ agentId: agent.id, skillId: first.skillId, revision: 1 }));
  const automaticUpdate: LearnedSkillDraft = { ...update, expectedRevision: 3 };
  await assert.rejects(runCauseEffect(service.learner().save(agent.id, automaticUpdate, "review:example:manual-old")));
  assert.equal((await runCauseEffect(library.get(first.skillId))).version, 3);
  assert.equal(
    (await runCauseEffect(skills.listInstalled(agent.id))).find((skill) => skill.skillId === first.skillId)
      ?.installedVersion,
    1,
  );
  checked(
    "A new automatic review preserves an explicitly installed old revision and leaves approval to the review card.",
  );
  await runCauseEffect(skills.uninstall({ agentId: agent.id, skillId: first.skillId }));
  await assert.rejects(
    runCauseEffect(service.learner().save(agent.id, automaticUpdate, "review:example:manual-remove")),
  );
  assert.equal((await runCauseEffect(library.get(first.skillId))).version, 3);
  assert.ok(!(await runCauseEffect(skills.listInstalled(agent.id))).some((skill) => skill.skillId === first.skillId));
  checked("An automatic update cannot reinstall a skill the person removed while the writer ran.");
  await runCauseEffect(skills.installLocal({ agentId: agent.id, skillId: first.skillId, revision: 3 }));

  const damagedReceipt = join(libraryRoot, first.skillId, "1", "learning-operation.json");
  const originalReceipt = await readFile(damagedReceipt);
  await writeFile(damagedReceipt, "{ damaged receipt");
  const restoredAgain = await runCauseEffect(
    service.restore({ ...restoreInput, expectedRevision: 3, requestId: "restore-after-damaged-receipt" }),
  );
  assert.equal(restoredAgain.revision, 4);
  assert.equal((await runCauseEffect(library.get(first.skillId))).instructions, draft.instructions);
  await writeFile(damagedReceipt, originalReceipt);
  checked("An unrelated damaged publication receipt cannot block a new revision restore.");

  // Synthetic identities must differ from the allowed placeholders to exercise their refusal.
  const syntheticHome = posix.join("/Users", "example-person", "project", "file");
  for (const { instructions, message } of [
    { instructions: "Use EXAMPLE_PRIVATE_TOKEN_123.", message: sourceText("error.skill.learningSecret") },
    { instructions: "Contact private@example.org.", message: sourceText("error.skill.learningPersonal") },
    { instructions: `Read ${syntheticHome}.`, message: sourceText("error.skill.learningPersonal") },
  ]) {
    await assert.rejects(
      runCauseEffect(service.learner().save(agent.id, { ...draft, instructions }, `rejected:${instructions.length}`)),
      { message },
    );
  }
  assert.equal((await runCauseEffect(library.list())).length, 1);
  checked("Secrets and personal identifiers are rejected before publication.");
  const placeholderInstructions = "Read /Users/user/project/file and contact user@example.com.";
  const placeholderRevision = await runCauseEffect(
    service.learner().save(
      agent.id,
      {
        action: "update",
        skillId: first.skillId,
        expectedRevision: restoredAgain.revision,
        description: draft.description,
        instructions: placeholderInstructions,
      },
      "suggestion:allowed-placeholders",
    ),
  );
  assert.equal(placeholderRevision.revision, restoredAgain.revision + 1);
  assert.equal((await runCauseEffect(library.get(first.skillId))).instructions, placeholderInstructions);
  checked("Example home and email placeholders remain valid learned content.");

  await runCauseEffect(service.set({ mode: "automatic" }));
  holdRefresh = true;
  const committed = runCauseEffect(
    service.learner().save(agent.id, { ...draft, name: "Queued skill one" }, "queue:one"),
  );
  await Promise.race([
    Effect.runPromise(Deferred.await(reached).pipe(Effect.timeout("10 seconds"))),
    committed.then(() => {
      throw new Error("The installer did not reach its refresh boundary.");
    }),
  ]);
  const cancelled = runCauseEffect(
    service.learner().save(agent.id, { ...draft, name: "Queued skill two" }, "queue:two"),
  );
  const rejectedQueued = assert.rejects(cancelled);
  await runCauseEffect(service.set({ mode: "off" }));
  assert.equal(service.get().mode, "off");
  await Effect.runPromise(Deferred.succeed(release, undefined));
  await committed;
  await rejectedQueued;
  assert.equal((await runCauseEffect(library.list())).length, 2);
  checked("Off cancels a queued writer without waiting for an already committed installation.");

  const offRestart = new SkillLearningService({ preferencePath, skills: restartedSkills, redact });
  await runCauseEffect(offRestart.load());
  assert.equal(offRestart.get().mode, "off");
  await assert.rejects(
    runCauseEffect(offRestart.learner().save(agent.id, { ...draft, name: "Disabled skill" }, "off:save")),
  );
  checked("Off survives restart and refuses a new Save.");

  const archive = zipSync({
    "SKILL.md": new TextEncoder().encode(
      "---\nname: Guarded example\ndescription: Guard a staged publication.\n---\nKeep the current revision.\n",
    ),
  });
  await assert.rejects(runCauseEffect(library.createFromBundle(archive, "guarded:save", () => false)));
  assert.equal((await runCauseEffect(library.list())).length, 2);
  checked("A cancellation at the publication boundary leaves no published staged revision.");

  const cursorPath = join(scratch, "memory-review-cursors.json");
  const cursors = new MemoryReviewCursors(cursorPath);
  await Effect.runPromise(cursors.set(agent.id, null, "message-own"));
  await Effect.runPromise(cursors.set(agent.id, "side-thread", "message-side"));
  await Effect.runPromise(cursors.set("other-agent", null, "message-other"));
  const loadedCursors = new MemoryReviewCursors(cursorPath);
  await Effect.runPromise(loadedCursors.load());
  assert.equal(loadedCursors.get(agent.id, null), "message-own");
  assert.equal(loadedCursors.get(agent.id, "side-thread"), "message-side");
  await Effect.runPromise(loadedCursors.set(agent.id, "side-thread", null));
  await Effect.runPromise(loadedCursors.forgetAgent(agent.id));
  const removedCursors = new MemoryReviewCursors(cursorPath);
  await Effect.runPromise(removedCursors.load());
  assert.equal(removedCursors.get(agent.id, null), null);
  assert.equal(removedCursors.get(agent.id, "side-thread"), null);
  assert.equal(removedCursors.get("other-agent", null), "message-other");
  checked("Conversation cursors survive restart and deletion preserves other agents' cursors.");

  const remoteBundle = (instructions: string) =>
    zipSync({
      "SKILL.md": new TextEncoder().encode(
        `---\nname: Remote preview example\ndescription: A remote skill preview.\n---\n${instructions}\n`,
      ),
    });
  const remoteSkill = await runCauseEffect(
    library.createFromBundle(remoteBundle("Keep EXAMPLE_PRIVATE_TOKEN_123 on the host.")),
  );
  const remoteList = await runCauseEffect(service.listLocalSkills());
  assert.ok(remoteList.length <= 200);
  assert.ok(
    remoteList.every((skill) => skill.instructions === "" && skill.files.length === 0 && skill.iconUrl === null),
  );
  const preview = await runCauseEffect(service.readLocalSkill({ skillId: remoteSkill.id, revision: 1 }));
  assert.equal(preview.version, 1);
  assert.ok(preview.instructions.includes("[REDACTED]"));
  assert.ok(!JSON.stringify(preview).includes("EXAMPLE_PRIVATE_TOKEN_123"));
  const largeText = "Long instructions. ".repeat(5_000);
  await runCauseEffect(library.reviseFromBundle(remoteSkill.id, 1, remoteBundle(largeText)));
  await assert.rejects(runCauseEffect(service.readLocalSkill({ skillId: remoteSkill.id })));
  assert.equal((await runCauseEffect(library.get(remoteSkill.id))).instructions, largeText.trim());
  assert.equal((await runCauseEffect(service.readLocalSkill({ skillId: remoteSkill.id, revision: 1 }))).version, 1);
  checked(
    "Remote previews fetch exact revisions, redact known secrets and refuse oversized content without changing the local skill.",
  );

  assert.ok(!(await readFile(preferencePath, "utf8")).includes("EXAMPLE_PRIVATE_TOKEN_123"));
  report.passed = true;
} catch (failure) {
  report.failure = failure instanceof Error ? failure.message : "The host skill-learning check failed.";
  process.exitCode = 1;
} finally {
  await Effect.runPromise(Deferred.succeed(release, undefined));
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rm(scratch, { recursive: true, force: true });
}
