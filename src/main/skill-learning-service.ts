import type { LocalSkillRevisionInput, SkillConversationEvent } from "@tommy/contracts/ipc";
import {
  DEFAULT_SKILL_LEARNING_MODE,
  decodeLearnedSkillDetail,
  decodeLearnedSkillDetails,
  hostSkillLearning,
  isSkillLearningMode,
  LEARNED_SKILL_READ_LIMITS,
  type RestoreLearnedSkillInput,
  type SkillLearningMode,
  type SkillLearningPreference,
} from "@tommy/contracts/ipc-skill-learning";
import { type DynamicRecord, isDynamicRecord } from "@tommy/contracts/runtime-values";
import { sourceText } from "@tommy/i18n/source";
import { Effect, Result, Semaphore } from "effect";
import { zipSync } from "fflate";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { type LearnedSkillDraft, type SkillLearner, SkillLearningFailed } from "../backend/agent/skill-learning";
import type { LocalSkillPublication } from "./local-skill-library";
import { PreferenceStore } from "./preference-file";
import type { SkillMarketplaceService } from "./skill-marketplace-service";
import { normalizedFiles } from "./skill-package";

const FRONTMATTER = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

export interface SkillLearningServiceOptions {
  preferencePath: string;
  skills: SkillMarketplaceService;
  redact(text: string): string;
}

/** Owns the preference and host-only library writes. No provider can choose a path or execute a learned file. */
export class SkillLearningService {
  readonly #options: SkillLearningServiceOptions;
  readonly #preference: PreferenceStore<SkillLearningPreference>;
  readonly #writes = Semaphore.makeUnsafe(1);
  readonly #settingsWrites = Semaphore.makeUnsafe(1);
  #pendingMode: SkillLearningMode | null = null;
  readonly #listeners = new Set<(preference: SkillLearningPreference) => void>();
  #generation = 0;

  constructor(options: SkillLearningServiceOptions) {
    this.#options = options;
    this.#preference = new PreferenceStore({
      path: options.preferencePath,
      defaultValue: { mode: DEFAULT_SKILL_LEARNING_MODE },
      decode: (value) =>
        isDynamicRecord(value) && value.version === 1 && isSkillLearningMode(value.mode) ? { mode: value.mode } : null,
    });
  }

  readonly load = Effect.fn("SkillLearningService.load")(function* (this: SkillLearningService) {
    yield* this.#preference.load().pipe(Effect.mapError((cause) => new SkillLearningFailed({ cause })));
  });

  get(): SkillLearningPreference {
    return { mode: this.#pendingMode ?? this.#preference.get().mode };
  }
  snapshot() {
    return hostSkillLearning(this.get());
  }
  onChange(listener: (preference: SkillLearningPreference) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Publish Off before waiting for disk or a writer, so no pending generation starts a new write. */
  readonly set = Effect.fn("SkillLearningService.set")(function* (
    this: SkillLearningService,
    preference: SkillLearningPreference,
  ) {
    if (!isSkillLearningMode(preference.mode))
      return yield* new SkillLearningFailed({ cause: new Error("Invalid skill learning mode.") });
    return yield* this.#settingsWrites.withPermit(
      Effect.gen({ self: this }, function* () {
        const before = this.get();
        if (before.mode === preference.mode) return hostSkillLearning(before);
        this.#generation += 1;
        this.#pendingMode = preference.mode;
        for (const listener of this.#listeners) listener({ ...preference });
        const written = yield* Effect.result(this.#preference.set(preference));
        this.#pendingMode = null;
        if (Result.isFailure(written)) {
          this.#generation += 1;
          for (const listener of this.#listeners) listener(before);
          return yield* new SkillLearningFailed({ cause: written.failure });
        }
        return hostSkillLearning(this.get());
      }),
    );
  });

  /** A bounded host library list. Revision contents are fetched only after a person opens one. */
  readonly listLocalSkills = Effect.fn("SkillLearningService.listLocalSkills")(function* (this: SkillLearningService) {
    const skills = yield* this.#options.skills
      .requireLocalLibrary()
      .list(LEARNED_SKILL_READ_LIMITS.list, true)
      .pipe(Effect.mapError((cause) => new SkillLearningFailed({ cause })));
    return yield* Effect.try({
      try: () =>
        decodeLearnedSkillDetails(
          skills.map((skill) => ({
            ...skill,
            name: this.#options.redact(skill.name),
            description: this.#options.redact(skill.description),
            instructions: "",
            files: [],
            iconUrl: null,
            ...(skill.examplePrompt === undefined ? {} : { examplePrompt: this.#options.redact(skill.examplePrompt) }),
          })),
        ),
      catch: (cause) => new SkillLearningFailed({ cause }),
    });
  });

  /** A selected immutable revision, projected and redacted before it leaves this host. */
  readonly readLocalSkill = Effect.fn("SkillLearningService.readLocalSkill")(function* (
    this: SkillLearningService,
    input: LocalSkillRevisionInput,
  ) {
    const skill = yield* this.#options.skills
      .requireLocalLibrary()
      .get(input.skillId, input.revision)
      .pipe(Effect.mapError((cause) => new SkillLearningFailed({ cause })));
    return yield* Effect.try({
      try: () =>
        decodeLearnedSkillDetail({
          ...skill,
          name: this.#options.redact(skill.name),
          description: this.#options.redact(skill.description),
          instructions: this.#options.redact(skill.instructions),
          files: skill.files.map((file) => this.#options.redact(file)),
          ...(skill.examplePrompt === undefined ? {} : { examplePrompt: this.#options.redact(skill.examplePrompt) }),
        }),
      catch: (cause) => new SkillLearningFailed({ cause }),
    });
  });

  /** Adapter consumed by MemoryReview. Its receipt makes Save idempotent after restart. */
  learner(): SkillLearner {
    return {
      read: (skillId) =>
        this.#options.skills
          .requireLocalLibrary()
          .get(skillId)
          .pipe(
            Effect.map((detail) => ({
              description: detail.description,
              instructions: detail.instructions,
              revision: detail.version,
            })),
            Effect.mapError((cause) => new SkillLearningFailed({ cause })),
          ),
      save: (agentId, draft, operationId) => this.#save(agentId, draft, operationId),
    };
  }

  readonly #save = Effect.fn("SkillLearningService.save")(function* (
    this: SkillLearningService,
    agentId: string,
    draft: LearnedSkillDraft,
    operationId: string,
  ) {
    const generation = this.#generation;
    return yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        if (this.get().mode === "off" || generation !== this.#generation)
          return yield* new SkillLearningFailed({ cause: new Error(sourceText("error.skill.learningStopped")) });
        yield* Effect.try({
          try: () => assertLearnedText(draft, this.#options.redact),
          catch: (cause) => new SkillLearningFailed({ cause }),
        });
        const library = this.#options.skills.requireLocalLibrary();
        // A review may ask again, but it must not replace an older revision the person installed.
        // The host makes review operation IDs; explicit Save uses the suggestion prefix instead.
        if (draft.action === "update" && operationId.startsWith("review:")) {
          const installed = yield* this.#options.skills
            .listInstalled(agentId)
            .pipe(Effect.mapError((cause) => new SkillLearningFailed({ cause })));
          const current = installed.find((skill) => skill.skillId === draft.skillId);
          if (!current || current.installedVersion !== draft.expectedRevision)
            return yield* new SkillLearningFailed({ cause: new Error(sourceText("error.skill.localRevisionChanged")) });
        }
        const bytes = yield* Effect.try({
          try: () => (draft.action === "create" ? newBundle(draft) : null),
          catch: (cause) => new SkillLearningFailed({ cause }),
        });
        const content = bytes ?? (draft.action === "update" ? yield* revisedBundle(library, draft) : null);
        if (!content) return yield* new SkillLearningFailed({ cause: new Error("No learned skill content.") });
        // A mode change while reading the old bundle still cancels this save before publication.
        if (this.get().mode === "off" || generation !== this.#generation)
          return yield* new SkillLearningFailed({ cause: new Error(sourceText("error.skill.learningStopped")) });
        const saved = yield* (
          draft.action === "create"
            ? library.createFromBundle(
                content,
                operationId,
                () => this.get().mode !== "off" && generation === this.#generation,
              )
            : library.reviseFromBundle(
                draft.skillId,
                draft.expectedRevision,
                content,
                operationId,
                () => this.get().mode !== "off" && generation === this.#generation,
              )
        ).pipe(Effect.mapError((cause) => new SkillLearningFailed({ cause })));
        // A committed revision is retained if install fails. The same operation retries installation,
        // never a second publication, so a failed UI request cannot lose a manual revision.
        if (this.get().mode === "off" || generation !== this.#generation)
          return yield* new SkillLearningFailed({ cause: new Error(sourceText("error.skill.learningStopped")) });
        yield* this.#install(agentId, saved, operationId);
        const event: SkillConversationEvent = {
          action: draft.action === "create" ? "created" : "revised",
          skillId: saved.id,
          revision: saved.version,
          skillName: saved.name,
        };
        return event;
      }),
    );
  });

  /** A user-requested restore publishes the selected old bundle as a new immutable revision. */
  readonly restore = Effect.fn("SkillLearningService.restore")(function* (
    this: SkillLearningService,
    input: RestoreLearnedSkillInput,
  ) {
    return yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        const operationId = `restore:${input.agentId}:${input.skillId}:${input.requestId}`;
        const saved = yield* this.#options.skills
          .requireLocalLibrary()
          .restoreRevision(input.skillId, input.revision, input.expectedRevision, operationId)
          .pipe(Effect.mapError((cause) => new SkillLearningFailed({ cause })));
        yield* this.#install(input.agentId, saved, operationId);
        return { action: "revised" as const, skillId: saved.id, revision: saved.version, skillName: saved.name };
      }),
    );
  });

  /** A repeated request must not reinstall an old revision over a later manual choice. */
  readonly #install = Effect.fn("SkillLearningService.install")(function* (
    this: SkillLearningService,
    agentId: string,
    saved: LocalSkillPublication,
    operationId: string,
  ) {
    const library = this.#options.skills.requireLocalLibrary();
    const receipt = { agentId, operationId, skillId: saved.id, revision: saved.version };
    if (
      yield* library
        .learningInstallationComplete(receipt)
        .pipe(Effect.mapError((cause) => new SkillLearningFailed({ cause })))
    )
      return;
    if (saved.replayed) {
      const latest = yield* library.get(saved.id).pipe(Effect.mapError((cause) => new SkillLearningFailed({ cause })));
      if (latest.version > saved.version) return;
      const installed = yield* this.#options.skills
        .listInstalled(agentId)
        .pipe(Effect.mapError((cause) => new SkillLearningFailed({ cause })));
      const current = installed.find((skill) => skill.skillId === saved.id);
      if (current && current.installedVersion > saved.version) return;
    }
    yield* this.#options.skills
      .installLocal({ agentId, skillId: saved.id, revision: saved.version })
      .pipe(Effect.mapError((cause) => new SkillLearningFailed({ cause })));
    yield* library
      .recordLearningInstallation(receipt)
      .pipe(Effect.mapError((cause) => new SkillLearningFailed({ cause })));
  });
}

/** Refuse secrets and installation-specific identifiers instead of publishing redaction markers. */
function assertLearnedText(draft: LearnedSkillDraft, redact: (text: string) => string): void {
  const values = [draft.description, draft.instructions, ...(draft.action === "create" ? [draft.name] : [])];
  for (const text of values) {
    if (redact(text) !== text || /\[REDACTED\]/iu.test(text)) throw new Error(sourceText("error.skill.learningSecret"));
    if (
      /\b[\w.+-]+@(?!example\.com\b)[\w.-]+\.[a-z]{2,}\b/iu.test(text) ||
      /\/(?:Users|home)\/(?!user(?:\/|\b)|<)[^/\s`]+/u.test(text)
    )
      throw new Error(sourceText("error.skill.learningPersonal"));
  }
}

function newBundle(draft: Extract<LearnedSkillDraft, { action: "create" }>): Uint8Array {
  return zipSync(
    { "SKILL.md": markdown({ name: draft.name, description: draft.description }, draft.instructions) },
    { level: 6 },
  );
}

function revisedBundle(
  library: ReturnType<SkillMarketplaceService["requireLocalLibrary"]>,
  draft: Extract<LearnedSkillDraft, { action: "update" }>,
) {
  return Effect.gen(function* () {
    const bytes = yield* library
      .bundle(draft.skillId, draft.expectedRevision)
      .pipe(Effect.mapError((cause) => new SkillLearningFailed({ cause })));
    return yield* Effect.try({
      try: () => {
        const files = normalizedFiles(bytes);
        const source = new TextDecoder("utf-8", { fatal: true }).decode(files["SKILL.md"]);
        const metadata = parseYaml(source.match(FRONTMATTER)?.[1] ?? "");
        if (!isDynamicRecord(metadata)) throw new Error("The skill has no frontmatter to preserve.");
        return zipSync(
          { ...files, "SKILL.md": markdown({ ...metadata, description: draft.description }, draft.instructions) },
          { level: 6 },
        );
      },
      catch: (cause) => new SkillLearningFailed({ cause }),
    });
  });
}

function markdown(metadata: DynamicRecord, instructions: string): Uint8Array {
  return new TextEncoder().encode(`---\n${stringifyYaml(metadata)}---\n\n${instructions.trim()}\n`);
}
