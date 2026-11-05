export const SKILL_CATEGORIES = [
  "coding",
  "design",
  "data-analytics",
  "documents",
  "productivity",
  "research",
  "automation",
  "other",
] as const;

export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export type SkillReviewStatus = "pending" | "approved" | "rejected";
export type InstalledSkillState = "installed" | "update-available" | "modified" | "needs-repair";

export interface MarketplaceSkillSummary {
  creatorAvatarUrl?: string | null;
  id: string;
  slug: string;
  name: string;
  description: string;
  category: SkillCategory;
  creatorName: string;
  version: number;
  installs: number;
  featured: boolean;
  /** Tommy checked the skill beyond the listing review. Absent from a Worker that has no such flag. */
  verified?: boolean;
  iconUrl: string | null;
  updatedAt: string;
}

/** The orders of a catalog page. No order is the default one: featured first, then the latest update. */
export type MarketplaceSkillSort = "installs" | "updated" | "name";

export interface MarketplaceSkillDetail extends MarketplaceSkillSummary {
  versionId: string;
  bundleSha256: string;
  files: string[];
  instructions: string;
  examplePrompt?: string;
  /** The share card of this version, on the Worker's origin. Absent from a Worker that draws none. */
  cardUrl?: string | null;
}

export interface MarketplaceSkillPage {
  skills: MarketplaceSkillSummary[];
  nextCursor: string | null;
}

export interface MarketplaceSkillQuery {
  query?: string | undefined;
  category?: SkillCategory;
  featured?: boolean;
  /** True: only verified skills. False: only the other skills. */
  verified?: boolean | undefined;
  sort?: MarketplaceSkillSort | undefined;
  cursor?: string | undefined;
  limit?: number;
}

export interface SkillSubmission {
  showCreatorAvatar?: boolean;
  id: string;
  skillId: string;
  slug: string;
  name: string;
  description: string;
  category: SkillCategory;
  version: number;
  status: SkillReviewStatus;
  rejectionNote: string | null;
  iconUrl: string | null;
  createdAt: string;
}

export interface SkillPackagePreview {
  draftId: string;
  name: string;
  description: string;
  slug: string;
  files: string[];
  size: number;
}

export interface SubmitSkillInput {
  showCreatorAvatar?: boolean;
  draftId: string;
  category: SkillCategory;
  icon: { mimeType: "image/png" | "image/jpeg" | "image/webp"; bytes: Uint8Array } | null;
  skillId?: string;
}

/**
 * `workspace` is a skill folder in `.agents/skills`, `.claude/skills` or `.opencode/skills` of the
 * agent workspace that Tommy did not install. Tommy lists it read-only and never writes to it.
 */
export const INSTALLED_SKILL_ORIGINS = ["marketplace", "managed", "local", "workspace"] as const;

/**
 * The id of a skill in the host user's `~/.agents/skills` is `home:<slug>`. Only the `$` list of a
 * host has these skills, with the `workspace` origin, so an older client decodes them. They are the
 * same for every agent and are not in the agent's workspace.
 */
export const HOME_SKILL_ID_PREFIX = "home:";

export function isHomeSkillId(skillId: string): boolean {
  return skillId.startsWith(HOME_SKILL_ID_PREFIX);
}
export type InstalledSkillOrigin = (typeof INSTALLED_SKILL_ORIGINS)[number];

/**
 * The message a user sends to ask the agent for a new local skill, on desktop, web and mobile. The
 * agent reads it, so it stays English and the same everywhere; it names the skill-creation guide.
 */
export const SKILL_CREATION_REQUEST =
  "Help me create a new local skill. Use the skill-creation guide. Ask me what workflow it should support before you create it.";

/** The Agent Skills specification limit for a SKILL.md `description`. */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

export interface InstalledSkill {
  skillId: string;
  slug: string;
  name: string;
  installedVersion: number;
  availableVersion: number;
  state: InstalledSkillState;
  /** Missing on older hosts and Team GET payloads; treat as true. */
  enabled?: boolean;
  /** Missing on older hosts and Team GET payloads; treat as marketplace. */
  origin?: InstalledSkillOrigin;
  /** Missing on older hosts, Team GET payloads, and pre-description lock files. */
  description?: string;
  /** For a `workspace` skill: its folder, relative to the agent workspace. */
  location?: string;
  /**
   * For a `workspace` skill: why it does not follow the Agent Skills specification, or why
   * the agent's provider does not read its folder. A provider can skip such a skill.
   */
  problem?: string;
}

/*
 * What an installed skill of an agent is to the user. The agent skills dialog and the Marketplace
 * apply the same rules, so the count and the cap of one agent are the same in both.
 */

/** A skill that Tommy puts on the agent. The user does not remove it. */
export function isBuiltInSkill(skill: InstalledSkill): boolean {
  return skill.origin === "managed" || skill.slug === "tommy-site-hosting" || skill.skillId === "tommy-site-hosting";
}

/** A skill in a skill folder that Tommy lists but does not manage. */
export function isFolderSkill(skill: InstalledSkill): boolean {
  return skill.origin === "workspace";
}

export function isSkillEnabled(skill: InstalledSkill): boolean {
  return skill.enabled !== false;
}

/** A skill that the user added or made. A home skill comes with the `$` list; it is not in the agent's workspace. */
export function isUserAssignedSkill(skill: InstalledSkill): boolean {
  return !isBuiltInSkill(skill) && !isHomeSkillId(skill.skillId);
}

/** The skills that the user added or made, by name. */
export function userAssignedSkills(skills: readonly InstalledSkill[]): InstalledSkill[] {
  return skills.filter(isUserAssignedSkill).sort((left, right) => left.name.localeCompare(right.name));
}

/** A skill in a folder Tommy did not write is not an assignment, so it does not count toward the cap. */
export function assignedSkillCount(skills: readonly InstalledSkill[]): number {
  return skills.filter((skill) => !isBuiltInSkill(skill) && !isFolderSkill(skill)).length;
}

export interface InstallSkillInput {
  agentId: string;
  skillId: string;
  /**
   * The exact published version to install, for a caller that pins one - a plugin listing names the
   * version its app was written against. Omitted, the install takes the newest published version,
   * which is what the marketplace screens have always sent. An older host ignores the field and
   * installs the newest version, so a pin is a preference and never a requirement.
   */
  versionId?: string;
  replaceModified?: boolean;
}

export interface UninstallSkillInput {
  agentId: string;
  skillId: string;
  removeModified?: boolean;
}

export interface SetEnabledSkillInput {
  agentId: string;
  skillId: string;
  enabled: boolean;
}

export function isSkillCategory(value: unknown): value is SkillCategory {
  return isOneOf(SKILL_CATEGORIES, value);
}

/** A valid `location` or `problem` of an {@link InstalledSkill}. */
export function isSkillNote(value: unknown): value is string {
  return isString(value) && value.length > 0 && value.length <= SKILL_DESCRIPTION_MAX_LENGTH;
}

/**
 * The installed skills a remote host lists for one agent (`GET /v1/agents/:agentId/skills`). The
 * host is an untrusted sender: an unknown state fails the list, and an optional field that is not
 * valid is dropped.
 */
export function decodeInstalledSkills(value: unknown): InstalledSkill[] {
  if (!Array.isArray(value)) throw new Error("Invalid installed skill list.");
  return value.map((item) => {
    const skill = decodeRecord(item, "installed skill");
    const state = requiredString(skill, "state");
    if (!isOneOf(["installed", "update-available", "modified", "needs-repair"] as const, state)) {
      throw new Error("Invalid installed skill state.");
    }
    const description = optionalSkillDescription(skill.description);
    return {
      skillId: requiredString(skill, "skillId"),
      slug: requiredString(skill, "slug"),
      name: requiredString(skill, "name"),
      installedVersion: requiredNumber(skill, "installedVersion"),
      availableVersion: requiredNumber(skill, "availableVersion"),
      state,
      ...(skill.enabled === false ? { enabled: false } : skill.enabled === true ? { enabled: true } : {}),
      ...(isOneOf(INSTALLED_SKILL_ORIGINS, skill.origin) ? { origin: skill.origin } : {}),
      ...(description ? { description } : {}),
      ...(isSkillNote(skill.location) ? { location: skill.location } : {}),
      ...(isSkillNote(skill.problem) ? { problem: skill.problem } : {}),
    };
  });
}

function optionalSkillDescription(value: unknown): string | undefined {
  if (!isString(value)) return undefined;
  const description = value.trim();
  return description && description.length <= SKILL_DESCRIPTION_MAX_LENGTH ? description : undefined;
}

import { decodeRecord, requiredNumber, requiredString } from "./ipc-decoding";
import { isOneOf, isString } from "./runtime-values";

export interface CreateLocalSkillInput {
  agentId: string;
  sourcePath: string;
}
export interface ReviseLocalSkillInput extends CreateLocalSkillInput {
  skillId: string;
  expectedRevision: number;
}
export interface LocalSkillRevisionInput {
  skillId: string;
  revision?: number | undefined;
}
/** Installs one exact revision, so the agent gets the copy the user read. */
export type InstallLocalSkillInput = LocalSkillRevisionInput & { agentId: string; revision: number };
