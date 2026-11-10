import { isBoundedString, isIdentifier } from "./ipc-bounded-values";
import type { ConversationMessage } from "./ipc-conversation-messages";
import { isSkillCategory, type LocalSkillRevisionInput, type MarketplaceSkillDetail } from "./ipc-skills";
import { isBoolean, isDynamicRecord, isOneOf, isString } from "./runtime-values";
import type { SkillConversationEvent } from "./skill-conversation-events";

/** A host-owned preference. Ask first is the initial Tommy default. */
export const SKILL_LEARNING_MODES = ["automatic", "ask", "off"] as const;
export type SkillLearningMode = (typeof SKILL_LEARNING_MODES)[number];
export const DEFAULT_SKILL_LEARNING_MODE: SkillLearningMode = "ask";
export interface SkillLearningPreference {
  mode: SkillLearningMode;
}
export interface HostSkillLearning {
  mode: string;
  choices: string[];
}
export function isSkillLearningMode(value: unknown): value is SkillLearningMode {
  return isOneOf(SKILL_LEARNING_MODES, value);
}
export function hostSkillLearning({ mode }: SkillLearningPreference): HostSkillLearning {
  return { mode, choices: [...SKILL_LEARNING_MODES] };
}
export function decodeHostSkillLearning(value: unknown): HostSkillLearning {
  if (
    !isDynamicRecord(value) ||
    !isBoundedString(value.mode, 32) ||
    !Array.isArray(value.choices) ||
    value.choices.length > 16 ||
    !value.choices.every((choice) => isBoundedString(choice, 32))
  )
    throw new Error("Invalid skill learning setting.");
  return { mode: value.mode, choices: [...value.choices] };
}
export function parseSkillLearningPreference(value: unknown): SkillLearningPreference {
  if (!isDynamicRecord(value) || !isSkillLearningMode(value.mode)) throw new Error("Invalid skill learning setting.");
  return { mode: value.mode };
}

export const SKILL_SUGGESTION_ITEM_TYPE_PREFIX = "skill-suggestion:";
export const SKILL_SUGGESTION_NAME_CHARACTERS = 200;
const LOCAL_SKILL_ID = /^local-skill-[\da-f-]{36}$/u;
export type SkillSuggestionTarget = { action: "create" } | { action: "update"; skillId: string };
export interface ConversationSkillSuggestion {
  name: string;
}
/** Additive metadata is sent only with skill-learning-v1; old clients show the question text. */
export type SkillLearningMessage = ConversationMessage & { skillSuggestion?: ConversationSkillSuggestion };
export type SkillSuggestionEvent = SkillSuggestionTarget & { skillName: string; question: string };
export function isLocalLibrarySkill(skillId: string): boolean {
  return LOCAL_SKILL_ID.test(skillId);
}
export function isConversationSkillSuggestion(value: unknown): value is ConversationSkillSuggestion {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.name, SKILL_SUGGESTION_NAME_CHARACTERS) &&
    value.name.trim().length > 0
  );
}
export function skillSuggestionItemType(target: SkillSuggestionTarget): string {
  return target.action === "create"
    ? `${SKILL_SUGGESTION_ITEM_TYPE_PREFIX}create`
    : `${SKILL_SUGGESTION_ITEM_TYPE_PREFIX}update:${target.skillId}`;
}
export function skillSuggestionTarget(message: ConversationMessage): SkillSuggestionTarget | null {
  if (message.author !== "system" || message.source !== "system") return null;
  const rest = message.itemType?.startsWith(SKILL_SUGGESTION_ITEM_TYPE_PREFIX)
    ? message.itemType.slice(SKILL_SUGGESTION_ITEM_TYPE_PREFIX.length)
    : null;
  if (rest === "create") return { action: "create" };
  const skillId = rest?.startsWith("update:") ? rest.slice("update:".length) : null;
  return skillId && isIdentifier(skillId) && isLocalLibrarySkill(skillId) ? { action: "update", skillId } : null;
}
export function skillSuggestionEvent(message: SkillLearningMessage): SkillSuggestionEvent | null {
  if (message.status !== "completed") return null;
  const target = skillSuggestionTarget(message);
  const skillName = message.skillSuggestion?.name.trim();
  const question = message.text.trim();
  return target && skillName && question ? { ...target, skillName, question } : null;
}
export interface SaveSkillSuggestionInput {
  agentId: string;
  messageId: string;
  threadId?: string;
}
export interface SaveSkillSuggestionResult {
  saved: boolean;
}
export function parseSaveSkillSuggestion(value: unknown): SaveSkillSuggestionInput {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.agentId) ||
    !isIdentifier(value.messageId) ||
    (value.threadId !== undefined && !isIdentifier(value.threadId))
  )
    throw new Error("Invalid skill suggestion.");
  return {
    agentId: value.agentId,
    messageId: value.messageId,
    ...(value.threadId === undefined ? {} : { threadId: value.threadId }),
  };
}
export function decodeSaveSkillSuggestionResult(value: unknown): SaveSkillSuggestionResult {
  if (!isDynamicRecord(value) || !isBoolean(value.saved)) throw new Error("Invalid skill suggestion result.");
  return { saved: value.saved };
}
export interface RestoreLearnedSkillInput {
  agentId: string;
  skillId: string;
  revision: number;
  expectedRevision: number;
  requestId: string;
}
export type RestoreLearnedSkillResult = SkillConversationEvent;
export function parseRestoreLearnedSkill(value: unknown): RestoreLearnedSkillInput {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.agentId) ||
    !isIdentifier(value.requestId) ||
    !isString(value.skillId) ||
    !isLocalLibrarySkill(value.skillId) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.expectedRevision !== "number" ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 1
  )
    throw new Error("Invalid skill revision restore.");
  return {
    agentId: value.agentId,
    skillId: value.skillId,
    revision: value.revision,
    expectedRevision: value.expectedRevision,
    requestId: value.requestId,
  };
}
export function decodeRestoreLearnedSkillResult(value: unknown): RestoreLearnedSkillResult {
  if (
    !isDynamicRecord(value) ||
    value.action !== "revised" ||
    !isString(value.skillId) ||
    !isLocalLibrarySkill(value.skillId) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !isBoundedString(value.skillName, SKILL_SUGGESTION_NAME_CHARACTERS) ||
    !value.skillName.trim()
  )
    throw new Error("Invalid skill revision restore result.");
  return { action: value.action, skillId: value.skillId, revision: value.revision, skillName: value.skillName };
}

/** Bounds of the new host-owned revision preview. Local package APIs keep their existing limits. */
export const LEARNED_SKILL_READ_LIMITS = {
  list: 200,
  files: 1_000,
  fileName: 512,
  instructions: 65_536,
  icon: 716_800,
} as const;

export function parseLearnedSkillRevision(value: unknown): LocalSkillRevisionInput {
  if (
    !isDynamicRecord(value) ||
    !isString(value.skillId) ||
    !isLocalLibrarySkill(value.skillId) ||
    (value.revision !== undefined &&
      (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1))
  )
    throw new Error("Invalid learned skill revision.");
  return { skillId: value.skillId, ...(value.revision === undefined ? {} : { revision: value.revision }) };
}

/** A remote preview contains only the declared package fields, never host paths or credentials. */
export function decodeLearnedSkillDetail(value: unknown): MarketplaceSkillDetail {
  if (
    !isDynamicRecord(value) ||
    !isString(value.id) ||
    !isLocalLibrarySkill(value.id) ||
    !isBoundedString(value.slug, 128) ||
    !isBoundedString(value.name, 200) ||
    !isBoundedString(value.description, 1_024) ||
    !isSkillCategory(value.category) ||
    !isBoundedString(value.creatorName, 256) ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.installs !== "number" ||
    !Number.isSafeInteger(value.installs) ||
    value.installs < 0 ||
    typeof value.featured !== "boolean" ||
    !isBoundedString(value.updatedAt, 160) ||
    !isBoundedString(value.versionId, 128) ||
    !isString(value.bundleSha256) ||
    !/^[a-f0-9]{64}$/u.test(value.bundleSha256) ||
    !Array.isArray(value.files) ||
    value.files.length > LEARNED_SKILL_READ_LIMITS.files ||
    !value.files.every((file) => isBoundedString(file, LEARNED_SKILL_READ_LIMITS.fileName)) ||
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
    throw new Error("Invalid learned skill preview.");
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
export function decodeLearnedSkillDetails(value: unknown): MarketplaceSkillDetail[] {
  if (!Array.isArray(value) || value.length > LEARNED_SKILL_READ_LIMITS.list)
    throw new Error("Invalid learned skill list.");
  return value.map(decodeLearnedSkillDetail);
}
