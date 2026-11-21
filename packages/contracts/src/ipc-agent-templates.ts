import { createAgentTemplateShareUrl, isAgentTemplateId, isAgentTemplateShareOrigin } from "./agent-template-links";
import { isAvatarMimeType, isValidAvatarImage } from "./avatar-images";
import { INPUT_LIMITS } from "./input-limits";
import { type AvatarHue, isAvatarHue, isAvatarSeed } from "./ipc-agent-identity";
import type { AvatarImageInput } from "./ipc-agents";
import type { MarketplaceAgentRoutine, MarketplaceAgentSkill } from "./ipc-marketplace-agents";
import { isReleasedRoutineSchedule } from "./ipc-routines";
import { isBoolean, isDynamicRecord, isNumber, isString } from "./runtime-values";

/**
 * An agent template is a public, link-only copy of one agent's instructions, skills and routines.
 * It never holds workspace files or memories. A marketplace skill travels as a reference to an
 * approved version; a local skill travels as its `SKILL.md` text only.
 */
export type AgentTemplateSkill =
  | ({ kind: "marketplace" } & MarketplaceAgentSkill)
  | { kind: "embedded"; slug: string; name: string; markdown: string };

export interface AgentTemplateSnapshot {
  name: string;
  title: string;
  description: string;
  avatarSeed: string;
  avatarHue: AvatarHue | null;
  skills: AgentTemplateSkill[];
  routines: MarketplaceAgentRoutine[];
}

export interface AgentTemplatePublication {
  templateId: string;
  shareUrl: string;
  publishedAt: string;
}

/** What the publish dialog shows for one local agent. `publication` is null when it is not published. */
export interface AgentTemplatePreview extends AgentTemplateSnapshot {
  agentId: string;
  avatarUrl: string | null;
  /** The uploaded avatar's bytes, so the share card can draw it. Null for a generated avatar. */
  avatarImage: AvatarImageInput | null;
  updatedAt: string | null;
  publication: AgentTemplatePublication | null;
  /**
   * Why the skills could not be read, such as a marketplace skill with local changes. The preview
   * still opens, so a published agent can be unpublished; publishing refuses with this error.
   */
  skillsError: string | null;
}

export interface PublishAgentTemplateInput {
  agentId: string;
  /** A PNG of `AGENT_TEMPLATE_CARD` size for link previews, or null to publish without one. */
  card: Uint8Array | null;
}

export interface InstallAgentTemplateInput {
  templateId: string;
  timezone: string;
  /** The `updatedAt` of the template the user reviewed; a newer version is refused, not installed. */
  expectedUpdatedAt: string;
}

export const AGENT_TEMPLATE_LIMITS = {
  skills: 32,
  embeddedSkills: 10,
  skillMarkdown: 65_536,
  skillName: 80,
  skillSlug: 64,
  /** The JSON of the whole template, well under the Worker's row and request limits. */
  snapshotBytes: 1_000_000,
} as const;

const SKILL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export function isAgentTemplateSkill(value: unknown): value is AgentTemplateSkill {
  if (!isDynamicRecord(value)) return false;
  if (value.kind === "marketplace")
    return (
      isString(value.skillId) &&
      isString(value.versionId) &&
      isString(value.slug) &&
      isString(value.name) &&
      isNumber(value.version)
    );
  return (
    value.kind === "embedded" &&
    isString(value.slug) &&
    SKILL_SLUG_PATTERN.test(value.slug) &&
    isString(value.name) &&
    value.name.trim().length > 0 &&
    value.name.length <= AGENT_TEMPLATE_LIMITS.skillName &&
    isString(value.markdown) &&
    value.markdown.trim().length > 0 &&
    value.markdown.length <= AGENT_TEMPLATE_LIMITS.skillMarkdown
  );
}

export function isAgentTemplateRoutine(value: unknown): value is MarketplaceAgentRoutine {
  return (
    isDynamicRecord(value) &&
    isString(value.name) &&
    value.name.trim().length > 0 &&
    value.name.length <= INPUT_LIMITS.routineName &&
    isString(value.instruction) &&
    value.instruction.trim().length > 0 &&
    value.instruction.length <= INPUT_LIMITS.routineInstruction &&
    isBoolean(value.active) &&
    isReleasedRoutineSchedule(value.schedule)
  );
}

/** Copies only the known fields, so an extra key from the wire never reaches storage or the renderer. */
export function toAgentTemplateSnapshot(value: AgentTemplateSnapshot): AgentTemplateSnapshot {
  return {
    name: value.name.trim(),
    title: value.title.trim(),
    description: value.description.trim(),
    avatarSeed: value.avatarSeed,
    avatarHue: value.avatarHue,
    skills: value.skills.map((skill) =>
      skill.kind === "marketplace"
        ? {
            kind: "marketplace",
            skillId: skill.skillId,
            versionId: skill.versionId,
            slug: skill.slug,
            name: skill.name,
            version: skill.version,
          }
        : { kind: "embedded", slug: skill.slug, name: skill.name, markdown: skill.markdown },
    ),
    routines: value.routines.map(({ name, instruction, active, schedule }) => ({
      name,
      instruction,
      active,
      schedule: structuredClone(schedule),
    })),
  };
}

/**
 * The agent-publish-v1 preview a host sent. The host keeps `avatarUrl`, a file on it; the dialog
 * does not read it, and the card draws the avatar from its bytes.
 */
export function decodeHostAgentTemplatePreview(value: unknown): AgentTemplatePreview {
  if (
    !isDynamicRecord(value) ||
    !isString(value.agentId) ||
    !isString(value.name) ||
    !isString(value.title) ||
    !isString(value.description) ||
    !isAvatarSeed(value.avatarSeed) ||
    (value.avatarHue !== null && !isAvatarHue(value.avatarHue)) ||
    !Array.isArray(value.skills) ||
    !value.skills.every(isAgentTemplateSkill) ||
    !Array.isArray(value.routines) ||
    !value.routines.every(isAgentTemplateRoutine) ||
    (value.updatedAt !== null && !isString(value.updatedAt)) ||
    (value.skillsError !== null && !isString(value.skillsError))
  )
    throw new Error("The host returned an invalid agent preview.");
  return {
    ...toAgentTemplateSnapshot({
      name: value.name,
      title: value.title,
      description: value.description,
      avatarSeed: value.avatarSeed,
      avatarHue: value.avatarHue,
      skills: value.skills,
      routines: value.routines,
    }),
    agentId: value.agentId,
    avatarUrl: null,
    avatarImage: decodeHostAvatarImage(value.avatarImage),
    updatedAt: value.updatedAt,
    publication: value.publication === null ? null : decodeHostAgentTemplatePublication(value.publication),
    skillsError: value.skillsError,
  };
}

/** The link is rebuilt from the id on a loopback origin, so a host cannot name another address. */
export function decodeHostAgentTemplatePublication(value: unknown): AgentTemplatePublication {
  if (
    !isDynamicRecord(value) ||
    !isString(value.templateId) ||
    !isAgentTemplateId(value.templateId) ||
    !isString(value.shareUrl) ||
    !isString(value.publishedAt)
  )
    throw new Error("The host returned an invalid agent publication.");
  let origin: string;
  try {
    origin = new URL(value.shareUrl).origin;
  } catch {
    throw new Error("The host returned an invalid agent link.");
  }
  if (!isAgentTemplateShareOrigin(origin)) throw new Error("The host returned an invalid agent link.");
  return {
    templateId: value.templateId,
    shareUrl: createAgentTemplateShareUrl(value.templateId, origin),
    publishedAt: value.publishedAt,
  };
}

function decodeHostAvatarImage(value: unknown): AvatarImageInput | null {
  if (value === null) return null;
  if (!isDynamicRecord(value) || !isString(value.mimeType) || !isString(value.data))
    throw new Error("The host returned an invalid agent avatar.");
  const { mimeType } = value;
  const bytes = Uint8Array.from(atob(value.data), (character) => character.charCodeAt(0));
  if (!isAvatarMimeType(mimeType) || !isValidAvatarImage(mimeType, bytes))
    throw new Error("The host returned an invalid agent avatar.");
  return { mimeType, bytes };
}
