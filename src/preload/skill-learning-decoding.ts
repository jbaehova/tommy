import type {
  HostSkillLearning,
  RestoreLearnedSkillResult,
  SaveSkillSuggestionResult,
} from "@tommy/contracts/ipc-skill-learning";
import { LEARNED_SKILL_READ_LIMITS } from "@tommy/contracts/ipc-skill-learning";
import { isSkillCategory, type MarketplaceSkillDetail } from "@tommy/contracts/ipc-skills";
import { isDynamicRecord, isString } from "@tommy/contracts/runtime-values";

export function decodeSkillLearningFromMain(value: unknown): HostSkillLearning {
  if (
    !isDynamicRecord(value) ||
    typeof value.mode !== "string" ||
    !value.mode ||
    value.mode.length > 32 ||
    !Array.isArray(value.choices) ||
    value.choices.length > 16 ||
    !value.choices.every(isString) ||
    value.choices.some((choice) => !choice || choice.length > 32)
  )
    throw new Error("Invalid skill learning setting from main.");
  return { mode: value.mode, choices: [...value.choices] };
}

export function decodeSavedSkillSuggestionFromMain(value: unknown): SaveSkillSuggestionResult {
  if (!isDynamicRecord(value) || typeof value.saved !== "boolean")
    throw new Error("Invalid skill suggestion result from main.");
  return { saved: value.saved };
}

export function decodeRestoredLearnedSkillFromMain(value: unknown): RestoreLearnedSkillResult {
  if (
    !isDynamicRecord(value) ||
    value.action !== "revised" ||
    typeof value.skillId !== "string" ||
    !/^local-skill-[\da-f-]{36}$/u.test(value.skillId) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.skillName !== "string" ||
    !value.skillName.trim() ||
    value.skillName.length > 200
  )
    throw new Error("Invalid restored skill from main.");
  return { action: value.action, skillId: value.skillId, revision: value.revision, skillName: value.skillName };
}

export function decodeLearnedSkillFromMain(value: unknown): MarketplaceSkillDetail {
  if (
    !isDynamicRecord(value) ||
    !isString(value.id) ||
    !/^local-skill-[\da-f-]{36}$/u.test(value.id) ||
    !(isString(value.slug) && value.slug.length <= 128) ||
    !(isString(value.name) && value.name.length <= 200) ||
    !(isString(value.description) && value.description.length <= 1_024) ||
    !isSkillCategory(value.category) ||
    !(isString(value.creatorName) && value.creatorName.length <= 256) ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.installs !== "number" ||
    !Number.isSafeInteger(value.installs) ||
    value.installs < 0 ||
    typeof value.featured !== "boolean" ||
    !(isString(value.updatedAt) && value.updatedAt.length <= 160) ||
    !(isString(value.versionId) && value.versionId.length <= 128) ||
    !isString(value.bundleSha256) ||
    !/^[a-f0-9]{64}$/u.test(value.bundleSha256) ||
    !Array.isArray(value.files) ||
    value.files.length > LEARNED_SKILL_READ_LIMITS.files ||
    !value.files.every(isString) ||
    value.files.some((file) => file.length > LEARNED_SKILL_READ_LIMITS.fileName) ||
    !isString(value.instructions) ||
    value.instructions.length > LEARNED_SKILL_READ_LIMITS.instructions ||
    !(
      value.iconUrl === null ||
      (isString(value.iconUrl) &&
        value.iconUrl.length <= LEARNED_SKILL_READ_LIMITS.icon &&
        value.iconUrl.startsWith("data:image/png;base64,"))
    ) ||
    (value.examplePrompt !== undefined && (!isString(value.examplePrompt) || value.examplePrompt.length > 1_000))
  )
    throw new Error("Invalid learned skill preview from main.");
  return {
    id: value.id,
    slug: value.slug,
    name: value.name,
    description: value.description,
    category: value.category,
    creatorName: value.creatorName,
    version: value.version,
    installs: value.installs,
    featured: value.featured,
    iconUrl: value.iconUrl,
    updatedAt: value.updatedAt,
    versionId: value.versionId,
    bundleSha256: value.bundleSha256,
    files: value.files,
    instructions: value.instructions,
    ...(value.examplePrompt === undefined ? {} : { examplePrompt: value.examplePrompt }),
  };
}
export function decodeLearnedSkillsFromMain(value: unknown): MarketplaceSkillDetail[] {
  if (!Array.isArray(value) || value.length > LEARNED_SKILL_READ_LIMITS.list)
    throw new Error("Invalid learned skill list from main.");
  return value.map(decodeLearnedSkillFromMain);
}
