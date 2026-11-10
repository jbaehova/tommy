import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentSummary, MarketplaceSkillDetail } from "@tommy/contracts/ipc";
import { isDynamicRecord, isString } from "@tommy/contracts/runtime-values";
import { sourceText } from "@tommy/i18n/source";
import { createTommyLogger } from "@tommy/logging";
import { Effect, Result, Schema, Semaphore } from "effect";
import { parse as parseYaml } from "yaml";
import { writeJsonFileAtomically } from "../backend/atomic-json-file";
import { causeHelpers } from "../backend/effect-boundary";
import { isMissingFileError } from "../backend/file-errors";
import { MANAGED_SKILL_SLUGS } from "./managed-skill-service";
import { archiveDirectory, inspectArchive, normalizedFiles } from "./skill-package";

export interface LocalSkillPublication extends MarketplaceSkillDetail {
  replayed: boolean;
}

const logger = createTommyLogger("local-skill-library");

const LearningInstallationReceipt = Schema.Struct({
  version: Schema.Literal(1),
  operationId: Schema.String,
  agentId: Schema.String,
  skillId: Schema.String,
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
});
type LearningInstallation = Omit<typeof LearningInstallationReceipt.Type, "version">;
const decodeLearningInstallation = Schema.decodeUnknownSync(LearningInstallationReceipt);

/** Owns immutable local revisions. A revision exists only after its directory is published. */
export class LocalSkillLibrary {
  readonly #writes = Semaphore.makeUnsafe(1);
  constructor(
    readonly root: string,
    private readonly agents: () => AgentSummary[],
  ) {}

  list(limit?: number, summaries = false): Effect.Effect<MarketplaceSkillDetail[], LocalSkillFailure> {
    return Effect.gen({ self: this }, function* (): Effect.fn.Return<MarketplaceSkillDetail[], LocalSkillFailure> {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
        return yield* new LocalSkillFailure({ cause: new Error("Invalid local skill list limit.") });
      yield* localIO(() => mkdir(this.root, { recursive: true, mode: 0o700 }));
      const entries = yield* localIO(() => readdir(this.root, { withFileTypes: true }));
      const published = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^local-skill-[\da-f-]{36}$/u.test(entry.name)) continue;
        const revisions = yield* localIO(() => readdir(join(this.root, entry.name)));
        if (revisions.some((name) => /^[1-9]\d*$/u.test(name))) published.push(entry.name);
      }
      const selected = limit === undefined ? published : published.sort().slice(0, limit);
      const results = yield* Effect.forEach(
        selected,
        (id) =>
          this.get(id).pipe(
            Effect.map((detail) => (summaries ? { ...detail, instructions: "", files: [], iconUrl: null } : detail)),
          ),
        { concurrency: limit === undefined ? "unbounded" : 1 },
      );
      return results.sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  private directory(id: string): string {
    if (!/^local-skill-[\da-f-]{36}$/u.test(id)) throw new Error("Invalid local skill ID.");
    return join(this.root, id);
  }

  private revision(id: string, requested?: number): Effect.Effect<number, LocalSkillFailure> {
    return Effect.gen({ self: this }, function* (): Effect.fn.Return<number, LocalSkillFailure> {
      if (requested !== undefined) {
        if (!Number.isSafeInteger(requested) || requested < 1)
          return yield* new LocalSkillFailure({ cause: new Error("Invalid skill revision.") });
        return requested;
      }
      const entries = yield* localIO(() => readdir(this.directory(id), { withFileTypes: true }));
      const revisions = entries
        .filter((entry) => entry.isDirectory() && /^[1-9]\d*$/u.test(entry.name))
        .map((entry) => Number(entry.name));
      if (!revisions.length)
        return yield* new LocalSkillFailure({ cause: new Error(sourceText("error.skill.localNoRevisions")) });
      return Math.max(...revisions);
    });
  }

  bundle(id: string, revision: number): Effect.Effect<Uint8Array, LocalSkillFailure> {
    return Effect.gen({ self: this }, function* (): Effect.fn.Return<Uint8Array, LocalSkillFailure> {
      const directory = yield* localSync(() => this.directory(id));
      const path = join(directory, String(yield* this.revision(id, revision)), "bundle.zip");
      yield* rejectLinks(this.root, path);
      return new Uint8Array(yield* localIO(() => readFile(path)));
    });
  }

  get(id: string, requested?: number): Effect.Effect<MarketplaceSkillDetail, LocalSkillFailure> {
    return Effect.gen({ self: this }, function* (): Effect.fn.Return<MarketplaceSkillDetail, LocalSkillFailure> {
      const revision = yield* this.revision(id, requested);
      const bytes = yield* this.bundle(id, revision);
      const info = yield* localSync(() => inspectArchive(bytes));
      const files = yield* localSync(() => normalizedFiles(bytes));
      const text = new TextDecoder().decode(files["SKILL.md"]);
      const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
      const metadata = yield* localSync(() => parseYaml(match?.[1] ?? ""));
      const example =
        isDynamicRecord(metadata) && isString(metadata["example-prompt"]) ? metadata["example-prompt"].trim() : "";
      const icon = files["assets/icon.png"];
      const iconUrl =
        icon && icon.byteLength <= 512 * 1024 && Buffer.from(icon.subarray(0, 8)).toString("hex") === "89504e470d0a1a0a"
          ? `data:image/png;base64,${Buffer.from(icon).toString("base64")}`
          : null;
      return {
        ...info,
        id,
        version: revision,
        versionId: String(revision),
        category: "other",
        creatorName: "Local",
        installs: 0,
        featured: false,
        iconUrl,
        updatedAt: (yield* localIO(() => stat(join(this.directory(id), String(revision))))).mtime.toISOString(),
        bundleSha256: createHash("sha256").update(bytes).digest("hex"),
        instructions: text.slice(match?.[0].length ?? 0).trim(),
        ...(example && example.length <= 1000 ? { examplePrompt: example } : {}),
      };
    });
  }

  create(agentId: string, sourcePath: string): Effect.Effect<MarketplaceSkillDetail, LocalSkillFailure> {
    return this.serialize(
      Effect.gen({ self: this }, function* () {
        const bytes = yield* this.sourceEffect(agentId, sourcePath);
        const info = yield* localSync(() => inspectArchive(bytes));
        if ((yield* this.list()).some((skill) => skill.slug === info.slug))
          return yield* new LocalSkillFailure({ cause: new Error(sourceText("error.skill.localNameTaken")) });
        const id = `local-skill-${randomUUID()}`;
        yield* this.publishEffect(id, 1, bytes);
        return yield* this.get(id, 1);
      }),
    );
  }

  revise(
    agentId: string,
    id: string,
    expectedRevision: number,
    sourcePath: string,
  ): Effect.Effect<MarketplaceSkillDetail, LocalSkillFailure> {
    return this.serialize(
      Effect.gen({ self: this }, function* () {
        const current = yield* this.get(id);
        if (current.version !== expectedRevision)
          return yield* new LocalSkillFailure({
            cause: new Error(sourceText("error.skill.localRevisionChanged")),
          });
        const bytes = yield* this.sourceEffect(agentId, sourcePath);
        if ((yield* localSync(() => inspectArchive(bytes))).slug !== current.slug)
          return yield* new LocalSkillFailure({ cause: new Error(sourceText("error.skill.localKeepName")) });
        yield* this.publishEffect(id, expectedRevision + 1, bytes);
        return yield* this.get(id, expectedRevision + 1);
      }),
    );
  }

  /** A host-built learned bundle. The receipt is published atomically with its immutable revision. */
  readonly createFromBundle = Effect.fn("LocalSkillLibrary.createFromBundle")(function* (
    this: LocalSkillLibrary,
    bytes: Uint8Array,
    operationId?: string,
    permitted?: () => boolean,
  ): Effect.fn.Return<LocalSkillPublication, LocalSkillFailure> {
    return yield* this.serialize(
      Effect.gen({ self: this }, function* () {
        const repeated = operationId ? yield* this.findOperation(operationId) : null;
        if (repeated) return { ...repeated, replayed: true };
        const info = yield* localSync(() => inspectArchive(bytes));
        if (MANAGED_SKILL_SLUGS.has(info.slug))
          return yield* new LocalSkillFailure({
            cause: new Error(sourceText("error.skill.managedSlug", { slug: info.slug })),
          });
        if ((yield* this.list()).some((skill) => skill.slug === info.slug))
          return yield* new LocalSkillFailure({ cause: new Error(sourceText("error.skill.localNameTaken")) });
        const id = `local-skill-${randomUUID()}`;
        yield* this.publishEffect(id, 1, bytes, operationId, permitted);
        return { ...(yield* this.get(id, 1)), replayed: false };
      }),
    );
  });

  /** expectedRevision prevents a learned edit from replacing a concurrent manual edit. */
  readonly reviseFromBundle = Effect.fn("LocalSkillLibrary.reviseFromBundle")(function* (
    this: LocalSkillLibrary,
    id: string,
    expectedRevision: number,
    bytes: Uint8Array,
    operationId?: string,
    permitted?: () => boolean,
  ): Effect.fn.Return<LocalSkillPublication, LocalSkillFailure> {
    return yield* this.serialize(
      Effect.gen({ self: this }, function* () {
        const repeated = operationId ? yield* this.findOperation(operationId) : null;
        if (repeated) return { ...repeated, replayed: true };
        const current = yield* this.get(id);
        if (current.version !== expectedRevision)
          return yield* new LocalSkillFailure({ cause: new Error(sourceText("error.skill.localRevisionChanged")) });
        if ((yield* localSync(() => inspectArchive(bytes))).slug !== current.slug)
          return yield* new LocalSkillFailure({ cause: new Error(sourceText("error.skill.localKeepName")) });
        yield* this.publishEffect(id, expectedRevision + 1, bytes, operationId, permitted);
        return { ...(yield* this.get(id, expectedRevision + 1)), replayed: false };
      }),
    );
  });

  /** Restoring makes a new revision; every previous revision remains readable. */
  readonly restoreRevision = Effect.fn("LocalSkillLibrary.restoreRevision")(function* (
    this: LocalSkillLibrary,
    id: string,
    revision: number,
    expectedRevision: number,
    operationId: string,
  ) {
    const bytes = yield* this.bundle(id, revision);
    return yield* this.reviseFromBundle(id, expectedRevision, bytes, operationId);
  });

  /** Publication and installation have separate receipts; an old Save must not undo a manual install. */
  readonly learningInstallationComplete = Effect.fn("LocalSkillLibrary.learningInstallationComplete")(function* (
    this: LocalSkillLibrary,
    input: LearningInstallation,
  ) {
    const path = this.learningInstallationPath(input);
    const read = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        yield* rejectLinks(this.root, path);
        const size = yield* localIO(() => stat(path));
        if (size.size > 4_096)
          return yield* new LocalSkillFailure({ cause: new Error("Invalid learned skill installation receipt.") });
        return yield* localIO(() => readFile(path, "utf8"));
      }),
    );
    if (Result.isFailure(read)) {
      if (isMissingFileError(read.failure.cause)) return false;
      return yield* read.failure;
    }
    const receipt = yield* localSync(() => decodeLearningInstallation(JSON.parse(read.success)));
    if (
      receipt.operationId !== input.operationId ||
      receipt.agentId !== input.agentId ||
      receipt.skillId !== input.skillId ||
      receipt.revision !== input.revision
    )
      return yield* new LocalSkillFailure({ cause: new Error("Invalid learned skill installation receipt.") });
    return true;
  });

  readonly recordLearningInstallation = Effect.fn("LocalSkillLibrary.recordLearningInstallation")(function* (
    this: LocalSkillLibrary,
    input: LearningInstallation,
  ) {
    return yield* this.serialize(
      Effect.gen({ self: this }, function* () {
        const path = this.learningInstallationPath(input);
        yield* localIO(() => mkdir(join(this.root, ".learning-installations"), { recursive: true, mode: 0o700 }));
        yield* rejectLinks(this.root, join(this.root, ".learning-installations"));
        yield* writeJsonFileAtomically(path, { version: 1, ...input }).pipe(
          Effect.mapError(({ cause }) => new LocalSkillFailure({ cause })),
        );
      }),
    );
  });

  private learningInstallationPath(input: LearningInstallation): string {
    const key = createHash("sha256")
      .update(JSON.stringify([input.agentId, input.operationId]))
      .digest("hex");
    return join(this.root, ".learning-installations", `${key}.json`);
  }

  /** Finds a committed operation after restart, including a save whose install must be retried. */
  private findOperation(operationId: string): Effect.Effect<MarketplaceSkillDetail | null, LocalSkillFailure> {
    return Effect.gen({ self: this }, function* () {
      yield* localIO(() => mkdir(this.root, { recursive: true, mode: 0o700 }));
      yield* rejectLinks(this.root, this.root);
      const entries = yield* localIO(() => readdir(this.root, { withFileTypes: true }));
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^local-skill-[\da-f-]{36}$/u.test(entry.name)) continue;
        const directory = this.directory(entry.name);
        yield* rejectLinks(this.root, directory);
        for (const revision of yield* localIO(() => readdir(directory, { withFileTypes: true }))) {
          if (!revision.isDirectory() || !/^[1-9]\d*$/u.test(revision.name)) continue;
          const receipt = join(directory, revision.name, "learning-operation.json");
          const read = yield* Effect.result(
            Effect.gen({ self: this }, function* () {
              yield* rejectLinks(this.root, receipt);
              const text = yield* localIO(() => readFile(receipt, "utf8"));
              const value = yield* localSync(() => JSON.parse(text));
              if (!isDynamicRecord(value) || !isString(value.operationId))
                return yield* new LocalSkillFailure({ cause: new Error("Invalid skill learning receipt.") });
              return value.operationId;
            }),
          );
          if (Result.isFailure(read)) {
            if (!isMissingFileError(read.failure.cause))
              logger.warn("A damaged skill learning receipt was skipped.", {
                skillId: entry.name,
                revision: revision.name,
              });
            continue;
          }
          if (read.success === operationId) return yield* this.get(entry.name, Number(revision.name));
        }
      }
      return null;
    });
  }

  /** Removes a revision a failed import published. A skill left with no revision is removed too. */
  withdraw(id: string, revision: number): Effect.Effect<void, LocalSkillFailure> {
    return this.serialize(
      Effect.gen({ self: this }, function* () {
        const directory = yield* localSync(() => this.directory(id));
        const path = join(directory, String(yield* this.revision(id, revision)));
        yield* rejectLinks(this.root, path);
        yield* localIO(() => rm(path, { recursive: true, force: true }));
        if (!(yield* localIO(() => readdir(directory))).some((name) => /^[1-9]\d*$/u.test(name)))
          yield* localIO(() => rm(directory, { recursive: true, force: true }));
      }),
    );
  }

  private sourceEffect(agentId: string, sourcePath: string): Effect.Effect<Uint8Array, LocalSkillFailure> {
    return Effect.gen({ self: this }, function* (): Effect.fn.Return<Uint8Array, LocalSkillFailure> {
      const agent = this.agents().find((item) => item.id === agentId);
      if (!agent) return yield* new LocalSkillFailure({ cause: new Error(sourceText("error.skill.chooseLocalAgent")) });
      if (
        !sourcePath ||
        isAbsolute(sourcePath) ||
        sourcePath.includes("\\") ||
        sourcePath.split("/").some((part) => part === ".." || !part)
      )
        return yield* new LocalSkillFailure({ cause: new Error(sourceText("error.skill.localRelativeFolder")) });
      const root = yield* localIO(() => realpath(agent.workspacePath));
      const path = resolve(root, sourcePath);
      if (!path.startsWith(`${root}${sep}`))
        return yield* new LocalSkillFailure({ cause: new Error(sourceText("error.skill.localSourceOutside")) });
      yield* rejectLinks(root, path);
      if (!(yield* localIO(() => lstat(path))).isDirectory())
        return yield* new LocalSkillFailure({ cause: new Error(sourceText("error.skill.localSourceNotFolder")) });
      if (!(yield* localIO(() => lstat(join(path, "SKILL.md")))).isFile())
        return yield* new LocalSkillFailure({ cause: new Error(sourceText("error.skill.localMissingSkillFile")) });
      const bytes = yield* archiveDirectory(path).pipe(
        Effect.mapError(({ cause }) => new LocalSkillFailure({ cause })),
      );
      yield* localSync(() => inspectArchive(bytes));
      return bytes;
    });
  }

  private publishEffect(
    id: string,
    revision: number,
    bytes: Uint8Array,
    operationId?: string,
    permitted?: () => boolean,
  ): Effect.Effect<void, LocalSkillFailure> {
    return Effect.gen({ self: this }, function* (): Effect.fn.Return<void, LocalSkillFailure> {
      yield* localIO(() => mkdir(this.root, { recursive: true, mode: 0o700 }));
      const directory = yield* localSync(() => this.directory(id));
      yield* localIO(() => mkdir(directory, { recursive: true, mode: 0o700 }));
      yield* rejectLinks(this.root, directory);
      const stage = join(directory, `.stage-${randomUUID()}`);
      yield* localIO(() => mkdir(stage, { mode: 0o700 }));
      yield* Effect.gen({ self: this }, function* () {
        yield* localIO(() => writeFile(join(stage, "bundle.zip"), bytes, { mode: 0o600, flag: "wx" }));
        if (operationId !== undefined)
          yield* localIO(() =>
            writeFile(join(stage, "learning-operation.json"), JSON.stringify({ operationId }), {
              mode: 0o600,
              flag: "wx",
            }),
          );
        if (permitted && !permitted())
          return yield* new LocalSkillFailure({ cause: new Error(sourceText("error.skill.learningStopped")) });
        yield* localIO(() => rename(stage, join(directory, String(revision))));
      }).pipe(
        Effect.ensuring(
          Effect.gen({ self: this }, function* () {
            yield* localIO(() => rm(stage, { recursive: true, force: true }));
          }).pipe(Effect.orDie),
        ),
      );
    });
  }

  private serialize<A>(operation: Effect.Effect<A, LocalSkillFailure>): Effect.Effect<A, LocalSkillFailure> {
    return this.#writes.withPermit(Effect.uninterruptible(operation));
  }
}

const rejectLinks = Effect.fn("LocalSkill.rejectLinks")(function* (root: string, path: string) {
  let current = root;
  if ((yield* localIO(() => lstat(root))).isSymbolicLink())
    return yield* new LocalSkillFailure({ cause: new Error(sourceText("error.skill.pathSymlink")) });
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((yield* localIO(() => lstat(current))).isSymbolicLink())
      return yield* new LocalSkillFailure({ cause: new Error(sourceText("error.skill.pathSymlink")) });
  }
});

export class LocalSkillFailure extends Schema.TaggedError<LocalSkillFailure>()("LocalSkillFailure", {
  cause: Schema.Defect(),
}) {}

const { io: localIO, sync: localSync } = causeHelpers(LocalSkillFailure);
