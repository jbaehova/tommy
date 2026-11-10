import { INPUT_LIMITS } from "@tommy/contracts/input-limits";
import type { AgentModelOption } from "@tommy/contracts/ipc";
import type { ModelListResponse } from "./../protocol";

/**
 * A model name the contract guards accept. `isAgentModelOption` bounds the name, and both the IPC
 * and the Team API list decoders reject the whole array when one option fails, so a name that is one
 * character too long does not shorten a label - it empties the model picker.
 */
export function modelDisplayName(name: string): string {
  return name.slice(0, INPUT_LIMITS.modelName);
}

/** The first version number in a model name: `[5, 6]` for `GPT-5.6 Sol`, `null` for `gpt-reserve`. */
function modelVersion(name: string): number[] | null {
  const match = /\d+(?:\.\d+)*/u.exec(name);
  return match ? match[0].split(".").map(Number) : null;
}

/**
 * Newest version first, so the picker leads with the latest model. A name with no version goes
 * last, and equal versions compare equal so the CLI's own order stays between them.
 */
export function compareModelVersions(left: AgentModelOption, right: AgentModelOption): number {
  const a = modelVersion(left.name);
  const b = modelVersion(right.name);
  if (!a || !b) return Number(!a) - Number(!b);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/**
 * The product name of a Claude model, from its id, or `null` for an id that does not read as one.
 *
 * Claude Code lists a model by the part it plays in that CLI - "Default (recommended)", "Opus" -
 * so its display name says which pick it is there, not which model an agent runs here. The picker
 * puts all three providers side by side, and the other two name a model in full, so the same
 * sentence has to be true of this one: the id carries it, with a release stamp the picker has no
 * use for. `claude-haiku-4-5-20251001` is Claude Haiku 4.5, and `claude-fable-5-1[1m]` is the 1M
 * context window of Claude Fable 5.1.
 */
export function claudeModelName(id: string): string | null {
  const parsed = /^([a-z0-9-]+?)(?:\[([a-z0-9]+)\])?$/u.exec(id.trim().toLowerCase());
  if (!parsed) return null;
  const [, base = "", variant] = parsed;
  const parts = base.split("-");
  if (parts.shift() !== "claude") return null;
  const family = parts.shift();
  if (!family || !/^[a-z]+$/u.test(family)) return null;
  // Eight digits are the build date, which names a release of the model rather than the model.
  const version = parts.filter((part) => !/^\d{8}$/u.test(part));
  if (!version.length || version.some((part) => !/^\d+$/u.test(part))) return null;
  const name = `Claude ${family[0]?.toUpperCase()}${family.slice(1)} ${version.join(".")}`;
  return variant ? `${name} (${variant.toUpperCase()} context)` : name;
}

export const FALLBACK_MODELS: AgentModelOption[] = [
  {
    provider: "codex",
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    description: "Fast and efficient for everyday agent work.",
    // `DEFAULT_REASONING_EFFORT`, not the `medium` the Codex CLI reports: this is the model a new
    // agent starts on, and the two have to say the same thing.
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "codex",
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    description: "Older fast and efficient model.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "codex",
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    description: "Balanced speed and capability for involved tasks.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    provider: "codex",
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    description: "Most capable for complex, long-running work.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    provider: "claude",
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    description: "",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["medium"],
  },
  {
    provider: "claude",
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    description: "Most capable Claude model for complex work.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "claude",
    id: "claude-fable-5",
    name: "Claude Fable 5",
    description: "Fast Claude model for everyday agent work.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "claude",
    id: "claude-opus-5",
    name: "Claude Opus 5",
    description: "Most capable Claude model for complex work.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "claude",
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    description: "Balanced Claude model for general agent work.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
];

/**
 * The tier that Codex names "Fast". Codex lists it in `serviceTiers` (`priority` in 0.163); an older
 * release lists only the deprecated `additionalSpeedTiers`, where it is `fast`.
 */
export function serviceTierFields(server: ModelListResponse["data"][number]): {
  fastServiceTier?: string;
  ultrafastServiceTier?: string;
} {
  const named = (name: string) =>
    server.serviceTiers?.find((candidate) => candidate.name?.trim().toLowerCase() === name)?.id;
  const usable = (tier: string | undefined): tier is string =>
    tier !== undefined && tier.length <= INPUT_LIMITS.serviceTier;
  const fast = named("fast") ?? (server.additionalSpeedTiers?.includes("fast") ? "fast" : undefined);
  const ultrafast = named("ultrafast");
  // Ultrafast is a choice beside Fast; a model without a Fast tier does not show a speed control.
  if (!usable(fast)) return {};
  return { fastServiceTier: fast, ...(usable(ultrafast) ? { ultrafastServiceTier: ultrafast } : {}) };
}
