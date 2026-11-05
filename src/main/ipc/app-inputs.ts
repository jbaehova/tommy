import type {
  AgentDefaults,
  AgentMemoryLimitPreference,
  AgentProviderId,
  AppBehaviorPreferenceChange,
  BrowserDockAction,
  BrowserDockFrame,
  BrowserDockPresentation,
  BusyMessageModePreference,
  ChatWindowTarget,
  DynamicIslandAction,
  DynamicIslandPreference,
  DynamicIslandPresentation,
  ExternalDestination,
  ExternalLinkPreference,
  HostUpdateSettingsChange,
  InstallSkillInput,
  MacAutomationTarget,
  MarketplaceSkillQuery,
  MarketplaceSkillSort,
  MemoryReviewPreference,
  NotificationPreference,
  PairDeviceInput,
  RemoteNetworkRoutePreference,
  RemoteSessionReusePreference,
  SaveSetupInput,
  SetAppAppearancePreferenceInput,
  SetAppInterfaceSizePreferenceInput,
  SetAppLanguagePreferenceInput,
  SetDynamicIslandInteractiveInput,
  SetEnabledSkillInput,
  SubmitSkillInput,
  UninstallSkillInput,
} from "@tommy/contracts/ipc";
import {
  decodeExternalLinkTarget,
  isAgentDefaults,
  isAgentMemoryLimit,
  isAgentModel,
  isAgentProvider,
  isAppAppearance,
  isAppInterfaceSize,
  isAppLanguage,
  isAppThemePaletteId,
  isBrowserDockAction,
  isBrowserDockFrame,
  isBrowserDockPresentation,
  isBusyMessageMode,
  isDynamicIslandAction,
  isDynamicIslandInteractive,
  isDynamicIslandPreference,
  isDynamicIslandPresentation,
  isMemoryReviewInterval,
  isRemoteNetworkRoute,
  isSkillCategory,
  MAC_AUTOMATION_TARGETS,
} from "@tommy/contracts/ipc";
import {
  type DynamicRecord,
  isBoolean,
  isDynamicRecord,
  isNumber,
  isOneOf,
  isString,
} from "@tommy/contracts/runtime-values";
import { parseAvatarImage } from "./avatar-inputs";
import { isObject, optionalBoolean, requireString } from "./validation";

export function parseSetup(input: unknown): SaveSetupInput {
  if (!isDynamicRecord(input)) throw new Error("Setup input is required.");
  const provider = input.preferredProvider;
  if (!isAgentProvider(provider)) throw new Error("Unknown provider.");
  // `null` is the whole meaning of "no model chosen", so a missing field is not accepted in its
  // place: setup is written from one screen that always knows which of the two it means.
  const model = input.preferredModel;
  if (model !== null && !isAgentModel(model)) throw new Error("Unknown model.");
  return { preferredProvider: provider, preferredModel: model };
}

export function parseProviderId(input: unknown): AgentProviderId {
  if (!isAgentProvider(input)) throw new Error("Unknown provider.");
  return input;
}

export function parseBusyMessageModePreference(input: unknown): BusyMessageModePreference {
  if (!isDynamicRecord(input) || !isBusyMessageMode(input.mode)) throw new Error("Busy message mode is required.");
  return { mode: input.mode };
}

export function parseAgentDefaults(input: unknown): AgentDefaults {
  if (!isAgentDefaults(input)) throw new Error("Agent defaults are required.");
  return {
    allowAutomation: input.allowAutomation,
    allowNewChat: input.allowNewChat,
    quickAcknowledgement: input.quickAcknowledgement,
  };
}

export function parseAgentMemoryLimitPreference(input: unknown): AgentMemoryLimitPreference {
  if (!isDynamicRecord(input) || !isAgentMemoryLimit(input.limit)) throw new Error("Agent memory limit is required.");
  return { limit: input.limit };
}

export function parseMemoryReviewPreference(input: unknown): MemoryReviewPreference {
  if (!isDynamicRecord(input) || !isMemoryReviewInterval(input.interval))
    throw new Error("Memory review interval is required.");
  return { interval: input.interval };
}

export function parseChatWindowTarget(input: unknown): ChatWindowTarget {
  if (!isDynamicRecord(input)) throw new Error("A chat is required.");
  return { serverId: requireString(input.serverId, "Server"), agentId: requireString(input.agentId, "Agent") };
}

export function parseExternalLinkPreference(input: unknown): ExternalLinkPreference {
  const target = isDynamicRecord(input) ? decodeExternalLinkTarget(input.target) : null;
  if (!target) throw new Error("The external link setting is required.");
  return { target };
}

export function parseRemoteSessionReusePreference(input: unknown): RemoteSessionReusePreference {
  if (!isDynamicRecord(input) || !isBoolean(input.keepBetweenRuns))
    throw new Error("The remote session setting is required.");
  return { keepBetweenRuns: input.keepBetweenRuns };
}

export function parseRemoteNetworkRoutePreference(input: unknown): RemoteNetworkRoutePreference {
  if (!isDynamicRecord(input) || !isRemoteNetworkRoute(input.route)) throw new Error("The network route is required.");
  return { route: input.route };
}

export function parseAppLanguagePreference(input: unknown): SetAppLanguagePreferenceInput {
  if (!isDynamicRecord(input) || !isAppLanguage(input.language)) throw new Error("Language preference is required.");
  return { language: input.language };
}

export function parseAppAppearancePreference(input: unknown): SetAppAppearancePreferenceInput {
  if (!isDynamicRecord(input)) throw new Error("Appearance is required.");
  const { appearance, transparentWindow, palette } = input;
  if (appearance !== undefined && !isAppAppearance(appearance)) throw new Error("Appearance is invalid.");
  if (transparentWindow !== undefined && typeof transparentWindow !== "boolean")
    throw new Error("Transparent window must be true or false.");
  if (palette !== undefined && palette !== null && !isAppThemePaletteId(palette))
    throw new Error("Theme palette is invalid.");
  if (appearance === undefined && transparentWindow === undefined && palette === undefined)
    throw new Error("Appearance is required.");
  return {
    ...(appearance === undefined ? {} : { appearance }),
    ...(transparentWindow === undefined ? {} : { transparentWindow }),
    ...(palette === undefined ? {} : { palette }),
  };
}

export function parseAppInterfaceSizePreference(input: unknown): SetAppInterfaceSizePreferenceInput {
  if (!isDynamicRecord(input) || !isAppInterfaceSize(input.percent)) throw new Error("Interface size is required.");
  return { percent: input.percent };
}

export function parseAppBehaviorPreferenceChange(input: unknown): AppBehaviorPreferenceChange {
  return parseSwitches(
    input,
    ["launchAtLogin", "keepRunningInBackground", "keepAwake", "keepAwakeOnBattery"],
    "The app behavior setting is required.",
  );
}

/** The switches an admin of a joined server sets on its host. `allowRemoteUpdates` stays with the host user. */
export function parseHostUpdateSettings(input: unknown): HostUpdateSettingsChange {
  return parseSwitches(input, ["autoDownload", "autoInstall"], "Update settings are required.");
}

/** At least one of `keys`, each a boolean. An absent key stays absent. */
function parseSwitches<Key extends string>(
  input: unknown,
  keys: readonly Key[],
  message: string,
): Partial<Record<Key, boolean>> {
  if (!isDynamicRecord(input)) throw new Error(message);
  const change: Partial<Record<Key, boolean>> = {};
  for (const key of keys) {
    const value = input[key];
    if (value === undefined) continue;
    if (!isBoolean(value)) throw new Error(message);
    change[key] = value;
  }
  if (Object.keys(change).length === 0) throw new Error(message);
  return change;
}

export function parseNotificationPreference(input: unknown): NotificationPreference {
  if (!isDynamicRecord(input) || !isBoolean(input.desktopNotifications) || !isBoolean(input.messagePreview)) {
    throw new Error("Notification preference is required.");
  }
  return { desktopNotifications: input.desktopNotifications, messagePreview: input.messagePreview };
}

export function parseDynamicIslandPreference(input: unknown): DynamicIslandPreference {
  if (!isDynamicIslandPreference(input)) {
    throw new Error("Dynamic Island preference is required.");
  }
  return input;
}

export function parseDynamicIslandInteractive(input: unknown): SetDynamicIslandInteractiveInput {
  if (!isDynamicIslandInteractive(input)) {
    throw new Error("Dynamic Island interaction state is required.");
  }
  return input;
}

export function parseDynamicIslandPresentation(input: unknown): DynamicIslandPresentation {
  if (!isDynamicIslandPresentation(input)) throw new Error("Dynamic Island presentation is invalid.");
  return input;
}

export function parseDynamicIslandAction(input: unknown): DynamicIslandAction {
  if (isDynamicIslandAction(input)) return input;
  throw new Error("Dynamic Island action is invalid.");
}

export function parseBrowserDockPresentation(input: unknown): BrowserDockPresentation | null {
  if (input === null || isBrowserDockPresentation(input)) return input;
  throw new Error("Browser dock presentation is invalid.");
}

export function parseBrowserDockAction(input: unknown): BrowserDockAction {
  if (isBrowserDockAction(input)) return input;
  throw new Error("Browser dock action is invalid.");
}

export function parseBrowserDockFrame(input: unknown): BrowserDockFrame {
  if (isBrowserDockFrame(input)) return input;
  throw new Error("Browser dock frame is invalid.");
}

/** Each app once, in the order asked: macOS shows one prompt at a time. */
export function parseMacAutomationTargets(input: unknown): readonly MacAutomationTarget[] {
  if (!Array.isArray(input) || !input.every((target) => isOneOf(MAC_AUTOMATION_TARGETS, target))) {
    throw new Error("Unknown Apple app.");
  }
  return [...new Set(input)];
}

export function parseExternalDestination(input: unknown): ExternalDestination {
  if (
    input !== "agent-setup" &&
    input !== "claude-install" &&
    input !== "hermes-install" &&
    input !== "opencode-install" &&
    input !== "opencode-auth" &&
    input !== "grok-bot-export" &&
    input !== "mac-screen-recording"
  ) {
    throw new Error("Unknown external destination.");
  }
  return input;
}

export function parsePairDevice(input: unknown): PairDeviceInput {
  if (!isObject(input)) throw new Error("Pairing details are required.");
  return { address: requireString(input.address, "address", 2_048), code: requireString(input.code, "code", 64) };
}

// The two marketplaces share query fields and validate their category filters at the boundary.
// `query` is truncated rather than rejected, which is the behaviour these channels have always had.
function parseMarketplaceQueryFields(input: DynamicRecord) {
  return {
    ...(isString(input.query) ? { query: input.query.slice(0, 100) } : {}),
    ...(input.featured === true ? { featured: true } : {}),
    ...(isString(input.cursor) ? { cursor: input.cursor } : {}),
    ...(isNumber(input.limit) ? { limit: input.limit } : {}),
  };
}

function parseMarketplaceSort<T extends string>(value: unknown, sorts: readonly T[], error: string): { sort?: T } {
  if (value === undefined) return {};
  if (!isOneOf(sorts, value)) throw new Error(error);
  return { sort: value };
}

const SKILL_SORTS = ["installs", "updated", "name"] as const satisfies readonly MarketplaceSkillSort[];

export function parseMarketplaceSkillQuery(input: unknown): MarketplaceSkillQuery {
  if (!isObject(input)) throw new Error("Invalid marketplace query.");
  const category = input.category;
  if (category !== undefined && !isSkillCategory(category)) throw new Error("Unknown skill category.");
  const verified = input.verified;
  if (verified !== undefined && !isBoolean(verified)) throw new Error("Invalid skill source filter.");
  return {
    ...parseMarketplaceQueryFields(input),
    ...parseMarketplaceSort(input.sort, SKILL_SORTS, "Unknown skill sort order."),
    ...(verified === undefined ? {} : { verified }),
    ...(category ? { category } : {}),
  };
}

export function parseSubmitSkill(input: unknown): SubmitSkillInput {
  if (!isObject(input) || !isSkillCategory(input.category)) throw new Error("Invalid skill submission.");
  return {
    draftId: requireString(input.draftId, "draftId"),
    ...creatorAvatarOption(input),
    category: input.category,
    icon: parseAvatarImage(input.icon),
    ...(input.skillId === undefined ? {} : { skillId: requireString(input.skillId, "skillId") }),
  };
}

export function parseInstallSkill(input: unknown): InstallSkillInput {
  if (!isObject(input)) throw new Error("Invalid skill installation.");
  return {
    agentId: requireString(input.agentId, "agentId"),
    skillId: requireString(input.skillId, "skillId"),
    ...(input.versionId === undefined ? {} : { versionId: requireString(input.versionId, "versionId") }),
    ...(input.replaceModified === true ? { replaceModified: true } : {}),
  };
}

export function parseUninstallSkill(input: unknown): UninstallSkillInput {
  if (!isObject(input)) throw new Error("Invalid skill removal.");
  return {
    agentId: requireString(input.agentId, "agentId"),
    skillId: requireString(input.skillId, "skillId"),
    ...(input.removeModified === true ? { removeModified: true } : {}),
  };
}

export function parseSetEnabledSkill(input: unknown): SetEnabledSkillInput {
  if (!isObject(input)) throw new Error("Invalid skill enablement.");
  const enabled = optionalBoolean(input.enabled, "enabled");
  if (enabled === undefined) throw new Error("Invalid skill enablement.");
  return {
    agentId: requireString(input.agentId, "agentId"),
    skillId: requireString(input.skillId, "skillId"),
    enabled,
  };
}

function creatorAvatarOption(input: DynamicRecord): { showCreatorAvatar?: boolean } {
  const showCreatorAvatar = optionalBoolean(input.showCreatorAvatar, "showCreatorAvatar");
  return showCreatorAvatar === undefined ? {} : { showCreatorAvatar };
}
