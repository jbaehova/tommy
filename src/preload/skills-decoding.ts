import {
  INSTALLED_SKILL_ORIGINS,
  type InstalledSkill,
  isAvatarHue,
  isAvatarSeed,
  isRoutineSchedule,
  isSkillCategory,
  isSkillNote,
  type MarketplaceAgentDetail,
  type MarketplaceAgentPage,
  type MarketplaceAgentSummary,
  type MarketplaceSkillDetail,
  type MarketplaceSkillPage,
  SKILL_DESCRIPTION_MAX_LENGTH,
  type SkillPackagePreview,
  type SkillSubmission,
} from "@tommy/contracts/ipc";
import {
  decodeRecord,
  nullableString,
  requiredBoolean,
  requiredNumber,
  requiredString,
} from "@tommy/contracts/ipc-decoding";
import { isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "@tommy/contracts/runtime-values";

function decodeSkillSummary(value: unknown) {
  const item = decodeRecord(value, "marketplace skill");
  if (!isSkillCategory(item.category)) throw new Error("Invalid skill category.");
  return {
    id: requiredString(item, "id"),
    slug: requiredString(item, "slug"),
    name: requiredString(item, "name"),
    description: requiredString(item, "description"),
    category: item.category,
    creatorName: requiredString(item, "creatorName"),
    creatorAvatarUrl: item.creatorAvatarUrl === undefined ? null : nullableString(item, "creatorAvatarUrl"),
    version: requiredNumber(item, "version"),
    installs: requiredNumber(item, "installs"),
    featured: requiredBoolean(item, "featured"),
    ...(isBoolean(item.verified) ? { verified: item.verified } : {}),
    iconUrl: nullableString(item, "iconUrl"),
    updatedAt: requiredString(item, "updatedAt"),
  };
}

export function decodeSkillPage(value: unknown): MarketplaceSkillPage {
  const page = decodeRecord(value, "marketplace page");
  if (!Array.isArray(page.skills)) throw new Error("Invalid marketplace skills.");
  return { skills: page.skills.map(decodeSkillSummary), nextCursor: nullableString(page, "nextCursor") };
}

export function decodeSkillDetails(value: unknown): MarketplaceSkillDetail[] {
  if (!Array.isArray(value)) throw new Error("Invalid local skill list.");
  return value.map(decodeSkillDetail);
}

export function decodeSkillDetail(value: unknown): MarketplaceSkillDetail {
  const item = decodeRecord(value, "skill detail");
  const summary = decodeSkillSummary(item);
  if (!Array.isArray(item.files) || !item.files.every(isString)) throw new Error("Invalid skill files.");
  return {
    ...summary,
    versionId: requiredString(item, "versionId"),
    bundleSha256: requiredString(item, "bundleSha256"),
    files: item.files,
    instructions: requiredString(item, "instructions"),
    ...(isString(item.examplePrompt) && item.examplePrompt.trim().length <= 1000
      ? { examplePrompt: item.examplePrompt.trim() }
      : {}),
  };
}

export function decodeSubmission(value: unknown): SkillSubmission {
  const item = decodeRecord(value, "skill submission");
  const status = item.status;
  if (!isSkillCategory(item.category) || !isOneOf(["pending", "approved", "rejected"], status)) {
    throw new Error("Invalid skill submission state.");
  }
  return {
    showCreatorAvatar: item.showCreatorAvatar === undefined ? false : requiredBoolean(item, "showCreatorAvatar"),
    id: requiredString(item, "id"),
    skillId: requiredString(item, "skillId"),
    slug: requiredString(item, "slug"),
    name: requiredString(item, "name"),
    description: requiredString(item, "description"),
    category: item.category,
    version: requiredNumber(item, "version"),
    status,
    rejectionNote: nullableString(item, "rejectionNote"),
    iconUrl: nullableString(item, "iconUrl"),
    createdAt: requiredString(item, "createdAt"),
  };
}

export function decodeSubmissions(value: unknown): SkillSubmission[] {
  if (!Array.isArray(value)) throw new Error("Invalid skill submissions.");
  return value.map(decodeSubmission);
}

export function decodeSkillPreview(value: unknown): SkillPackagePreview | null {
  if (value === null) return null;
  const item = decodeRecord(value, "skill package preview");
  if (!Array.isArray(item.files) || !item.files.every(isString)) throw new Error("Invalid skill package files.");
  return {
    draftId: requiredString(item, "draftId"),
    name: requiredString(item, "name"),
    description: requiredString(item, "description"),
    slug: requiredString(item, "slug"),
    files: item.files,
    size: requiredNumber(item, "size"),
  };
}

export function decodeInstalledSkill(value: unknown): InstalledSkill {
  const item = decodeRecord(value, "installed skill");
  const state = item.state;
  if (!isOneOf(["installed", "update-available", "modified", "needs-repair"], state)) {
    throw new Error("Invalid installed skill state.");
  }
  const description = optionalSkillDescription(item.description);
  return {
    skillId: requiredString(item, "skillId"),
    slug: requiredString(item, "slug"),
    name: requiredString(item, "name"),
    installedVersion: requiredNumber(item, "installedVersion"),
    availableVersion: requiredNumber(item, "availableVersion"),
    state,
    ...(item.enabled === false ? { enabled: false } : item.enabled === true ? { enabled: true } : {}),
    ...(isOneOf(INSTALLED_SKILL_ORIGINS, item.origin) ? { origin: item.origin } : {}),
    ...(description ? { description } : {}),
    ...(isSkillNote(item.location) ? { location: item.location } : {}),
    ...(isSkillNote(item.problem) ? { problem: item.problem } : {}),
  };
}

function optionalSkillDescription(value: unknown): string | undefined {
  if (!isString(value)) return undefined;
  const description = value.trim();
  return description && description.length <= SKILL_DESCRIPTION_MAX_LENGTH ? description : undefined;
}

export function decodeInstalledSkillsFromMain(value: unknown): InstalledSkill[] {
  if (!Array.isArray(value)) throw new Error("Invalid installed skills.");
  return value.map(decodeInstalledSkill);
}

function decodeMarketplaceAgentSummary(value: unknown): MarketplaceAgentSummary {
  const item = decodeRecord(value, "marketplace agent");
  if (!isAvatarSeed(item.avatarSeed) || (item.avatarHue !== null && !isAvatarHue(item.avatarHue)))
    throw new Error("Invalid marketplace agent avatar.");
  if (item.category !== undefined && !isSkillCategory(item.category)) throw new Error("Invalid agent category.");
  return {
    category: item.category ?? "other",
    id: requiredString(item, "id"),
    name: requiredString(item, "name"),
    title: requiredString(item, "title"),
    description: requiredString(item, "description"),
    creatorName: requiredString(item, "creatorName"),
    creatorAvatarUrl: item.creatorAvatarUrl === undefined ? null : nullableString(item, "creatorAvatarUrl"),
    version: requiredNumber(item, "version"),
    installs: requiredNumber(item, "installs"),
    featured: requiredBoolean(item, "featured"),
    ...(isBoolean(item.verified) ? { verified: item.verified } : {}),
    avatarSeed: item.avatarSeed,
    avatarHue: item.avatarHue,
    avatarUrl: nullableString(item, "avatarUrl"),
    skillCount: requiredNumber(item, "skillCount"),
    routineCount: requiredNumber(item, "routineCount"),
    activeRoutineCount: requiredNumber(item, "activeRoutineCount"),
    updatedAt: requiredString(item, "updatedAt"),
  };
}

export function decodeMarketplaceAgentPage(value: unknown): MarketplaceAgentPage {
  const page = decodeRecord(value, "marketplace agent page");
  if (!Array.isArray(page.agents)) throw new Error("Invalid marketplace agents.");
  return {
    agents: page.agents.map(decodeMarketplaceAgentSummary),
    nextCursor: nullableString(page, "nextCursor"),
  };
}

export function decodeMarketplaceAgentDetail(value: unknown): MarketplaceAgentDetail {
  const item = decodeRecord(value, "marketplace agent detail");
  const summary = decodeMarketplaceAgentSummary(item);
  if (
    !Array.isArray(item.skills) ||
    !item.skills.every((skill) => {
      if (!isDynamicRecord(skill)) return false;
      return [skill.skillId, skill.versionId, skill.slug, skill.name].every(isString) && isNumber(skill.version);
    })
  )
    throw new Error("Invalid marketplace agent skills.");
  if (
    !Array.isArray(item.routines) ||
    !item.routines.every(
      (routine) =>
        isDynamicRecord(routine) &&
        isString(routine.name) &&
        isString(routine.instruction) &&
        isBoolean(routine.active) &&
        isRoutineSchedule(routine.schedule),
    )
  )
    throw new Error("Invalid marketplace agent routines.");
  return {
    ...summary,
    versionId: requiredString(item, "versionId"),
    ...(isBoolean(item.pending) ? { pending: item.pending } : {}),
    skills: item.skills,
    routines: item.routines,
  };
}
