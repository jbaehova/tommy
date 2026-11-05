// What main answers for the app shell, the account, the updater, notifications, voice, exports,
// hosted servers, custom providers and remote desktop.
//
// Each decoder checks every field the contract type requires and keeps each optional field it
// carries, so a value the renderer reads always has the shape its type says.

import {
  type AccountSession,
  AGENT_DEFAULT_KEYS,
  type AgentDefaults,
  type AgentMemoryLimitPreference,
  type AppAppearancePreference,
  type AppBehaviorPreference,
  type AppInfo,
  type AppInterfaceSizePreference,
  type AppLanguagePreference,
  type ApprovalAutomationPreference,
  type AppSetupState,
  type AppThemePalette,
  type BusyMessageModePreference,
  type CentralAuthIssue,
  type CentralAuthState,
  type CentralAuthUser,
  type ChatWindowTarget,
  DEFAULT_AGENT_DEFAULTS,
  decodeExternalLinkTarget,
  decodeScheduledUpdateRestart,
  type ExportResult,
  type ExternalLinkBrowser,
  type ExternalLinkBrowsers,
  type ExternalLinkFallback,
  type ExternalLinkPreference,
  IDLE_RESTART_TARGETS,
  type IdleRestart,
  isAgentMemoryLimit,
  isAgentModel,
  isAgentProvider,
  isAppAppearance,
  isAppInterfaceSize,
  isAppLanguage,
  isApprovalAutomationPreference,
  isAppThemePalette,
  isAppThemePaletteId,
  isBusyMessageMode,
  isRemoteNetworkRoute,
  isVoiceLanguage,
  isVoiceModelId,
  isVoiceServerProbe,
  isVoiceServerSettings,
  type MobileConnectedDevice,
  type MobileConnectTicket,
  type NotificationOpenedEvent,
  type NotificationPreference,
  type RemoteNetworkRouteState,
  type RemoteSessionReusePreference,
  UPDATE_PHASES,
  type UpdatePreference,
  type UpdateStatus,
  type VoiceModelStatus,
  type VoiceServerProbe,
  type VoiceServerSettings,
  type VoiceSettings,
  type VoiceStream,
  type VoiceStreamTranscript,
  type VoiceTranscriptionResult,
} from "@tommy/contracts/ipc";
import {
  decodeList,
  decodeRecord,
  emptyDecoder,
  guardedDecoder,
  nullableBoolean,
  nullableNumber,
  nullableString,
  requiredBoolean,
  requiredNumber,
  requiredString,
} from "@tommy/contracts/ipc-decoding";
import {
  isMarketplaceAgentId,
  isMarketplaceSkillSlug,
  type MarketplaceListingLink,
} from "@tommy/contracts/marketplace-links";
import {
  type DynamicRecord,
  isBoolean,
  isDynamicRecord,
  isNumber,
  isOneOf,
  isString,
} from "@tommy/contracts/runtime-values";

export function decodeAppInfo(value: unknown): AppInfo {
  const info = decodeRecord(value, "app info");
  const { platform, variant } = info;
  if (!isOneOf(["darwin", "linux"] as const, platform)) throw new Error("Invalid platform.");
  if (!isOneOf(["production", "dev", "preview"] as const, variant)) throw new Error("Invalid variant.");
  return {
    name: requiredString(info, "name"),
    version: requiredString(info, "version"),
    platform,
    variant,
  };
}

export function decodeAppSetupState(value: unknown): AppSetupState {
  const state = decodeRecord(value, "setup state");
  const { preferredProvider, preferredModel } = state;
  if (preferredProvider !== null && !isAgentProvider(preferredProvider)) throw new Error("Invalid preferredProvider.");
  if (preferredModel !== null && !isAgentModel(preferredModel)) throw new Error("Invalid preferredModel.");
  return { completed: requiredBoolean(state, "completed"), preferredProvider, preferredModel };
}

export const decodeApprovalAutomationPreference: (value: unknown) => ApprovalAutomationPreference = guardedDecoder(
  isApprovalAutomationPreference,
  "approval automation preference",
);

export function decodeBusyMessageModePreference(value: unknown): BusyMessageModePreference {
  const preference = decodeRecord(value, "busy message mode preference");
  if (!isBusyMessageMode(preference.mode)) throw new Error("Invalid busy message mode.");
  return { mode: preference.mode };
}

export function decodeAgentDefaults(value: unknown): AgentDefaults {
  const defaults = decodeRecord(value, "agent defaults");
  const decoded = { ...DEFAULT_AGENT_DEFAULTS };
  for (const key of AGENT_DEFAULT_KEYS) decoded[key] = requiredBoolean(defaults, key);
  return decoded;
}

export function decodeAgentMemoryLimitPreference(value: unknown): AgentMemoryLimitPreference {
  const preference = decodeRecord(value, "agent memory limit preference");
  if (!isAgentMemoryLimit(preference.limit)) throw new Error("Invalid agent memory limit.");
  return { limit: preference.limit };
}

export function decodeAppLanguagePreference(value: unknown): AppLanguagePreference {
  const preference = decodeRecord(value, "language preference");
  if (!isAppLanguage(preference.language)) throw new Error("Invalid language.");
  return { language: preference.language };
}

/** Only a hex color passes: each one becomes a CSS property value in the page. */
function decodeThemePalette(palette: DynamicRecord): AppThemePalette {
  if (!isAppThemePalette(palette)) throw new Error("Invalid theme palette.");
  return { id: palette.id, name: palette.name, scheme: palette.scheme, colors: { ...palette.colors } };
}

export function decodeAppAppearancePreference(value: unknown): AppAppearancePreference {
  const preference = decodeRecord(value, "appearance preference");
  if (!isAppAppearance(preference.appearance)) throw new Error("Invalid appearance.");
  if (typeof preference.transparentWindow !== "boolean") throw new Error("Invalid transparent window.");
  if (preference.palette !== null && !isAppThemePaletteId(preference.palette))
    throw new Error("Invalid theme palette.");
  return {
    appearance: preference.appearance,
    transparentWindow: preference.transparentWindow,
    palette: preference.palette,
    palettes: decodeList(preference.palettes, "theme palettes", decodeThemePalette),
  };
}

export function decodeAppInterfaceSizePreference(value: unknown): AppInterfaceSizePreference {
  const preference = decodeRecord(value, "interface size preference");
  if (!isAppInterfaceSize(preference.percent)) throw new Error("Invalid interface size.");
  return { percent: preference.percent };
}

export function decodeChatWindowTargets(value: unknown): ChatWindowTarget[] {
  if (!Array.isArray(value)) throw new Error("Invalid chat windows.");
  return value.map((item) => {
    const target = decodeRecord(item, "chat window");
    if (!isString(target.serverId) || !isString(target.agentId)) throw new Error("Invalid chat window.");
    return { serverId: target.serverId, agentId: target.agentId };
  });
}

export function decodeCentralAuthState(value: unknown): CentralAuthState {
  const state = decodeRecord(value, "account state");
  switch (state.status) {
    case "loading":
    case "signed_out":
    case "signing_in":
      return { status: state.status };
    case "code_sent": {
      const { developmentCode, issue } = state;
      if (developmentCode !== undefined && !isString(developmentCode)) throw new Error("Invalid developmentCode.");
      return {
        status: "code_sent",
        challengeId: requiredString(state, "challengeId"),
        email: requiredString(state, "email"),
        expiresAt: requiredNumber(state, "expiresAt"),
        resendAvailableAt: requiredNumber(state, "resendAvailableAt"),
        ...(developmentCode === undefined ? {} : { developmentCode }),
        ...(issue === undefined ? {} : { issue: decodeCentralAuthIssue(issue) }),
      };
    }
    case "signed_in":
      return { status: "signed_in", user: decodeCentralAuthUser(state.user) };
    case "error":
      return { status: "error", issue: decodeCentralAuthIssue(state.issue) };
    default:
      throw new Error("Invalid account status.");
  }
}

function decodeCentralAuthUser(value: unknown): CentralAuthUser {
  const user = decodeRecord(value, "account user");
  return {
    id: requiredString(user, "id"),
    email: requiredString(user, "email"),
    name: nullableString(user, "name"),
    avatarUrl: nullableString(user, "avatarUrl"),
  };
}

function decodeCentralAuthIssue(value: unknown): CentralAuthIssue {
  const issue = decodeRecord(value, "account issue");
  const { retryAfterSeconds, reference } = issue;
  if (retryAfterSeconds !== undefined && !isNumber(retryAfterSeconds)) throw new Error("Invalid retryAfterSeconds.");
  if (reference !== undefined && !isString(reference)) throw new Error("Invalid reference.");
  return {
    code: requiredString(issue, "code"),
    message: requiredString(issue, "message"),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...(reference === undefined ? {} : { reference }),
  };
}

export function decodeMobileConnectTicket(value: unknown): MobileConnectTicket {
  const ticket = decodeRecord(value, "Mobile Connect ticket");
  return { qrData: requiredString(ticket, "qrData"), expiresAt: requiredNumber(ticket, "expiresAt") };
}

export function decodeMobileConnectedDevices(value: unknown): MobileConnectedDevice[] {
  return decodeList(value, "connected device list", (device) => {
    const { platform } = device;
    if (!isOneOf(["ios", "android", "unknown"] as const, platform)) throw new Error("Invalid platform.");
    return {
      sessionId: requiredString(device, "sessionId"),
      name: requiredString(device, "name"),
      platform,
      connectedAt: requiredNumber(device, "connectedAt"),
      lastActiveAt: requiredNumber(device, "lastActiveAt"),
      via: device.via === "link" ? "link" : "code",
    };
  });
}

export function decodeAccountSessions(value: unknown): AccountSession[] {
  return decodeList(value, "account session list", (session) => {
    const { kind, hostedServer } = session;
    if (!isOneOf(["desktop", "mobile"] as const, kind)) throw new Error("Invalid kind.");
    if (hostedServer !== undefined && !isBoolean(hostedServer)) throw new Error("Invalid hostedServer.");
    return {
      sessionId: requiredString(session, "sessionId"),
      name: requiredString(session, "name"),
      kind,
      current: requiredBoolean(session, "current"),
      connectedAt: requiredNumber(session, "connectedAt"),
      lastActiveAt: requiredNumber(session, "lastActiveAt"),
      ...(hostedServer === undefined ? {} : { hostedServer }),
    };
  });
}

export function decodeUpdateStatus(value: unknown): UpdateStatus {
  const status = decodeRecord(value, "update status");
  const { phase, errorCode, managedByHost, scheduledRestart, idleRestart } = status;
  if (!isOneOf(UPDATE_PHASES, phase)) throw new Error("Invalid phase.");
  if (errorCode !== null && !isOneOf(["check_failed", "download_failed", "install_failed"] as const, errorCode)) {
    throw new Error("Invalid errorCode.");
  }
  if (managedByHost !== undefined && !isBoolean(managedByHost)) throw new Error("Invalid managedByHost.");
  return {
    phase,
    currentVersion: requiredString(status, "currentVersion"),
    availableVersion: nullableString(status, "availableVersion"),
    progress: nullableNumber(status, "progress"),
    checkedAt: nullableString(status, "checkedAt"),
    message: nullableString(status, "message"),
    errorCode,
    ...(managedByHost === undefined ? {} : { managedByHost }),
    ...(scheduledRestart === undefined ? {} : { scheduledRestart: decodeScheduledUpdateRestart(scheduledRestart) }),
    ...(idleRestart === undefined ? {} : { idleRestart: decodeIdleRestart(idleRestart) }),
  };
}

function decodeIdleRestart(value: unknown): IdleRestart {
  const restart = decodeRecord(value, "idle restart");
  const { target, waitingFor, error } = restart;
  if (!isOneOf(IDLE_RESTART_TARGETS, target)) throw new Error("Invalid target.");
  if (!Array.isArray(waitingFor) || !waitingFor.every(isString)) throw new Error("Invalid waitingFor.");
  if (error !== undefined && !isString(error)) throw new Error("Invalid error.");
  return { target, waitingFor: [...waitingFor], ...(error === undefined ? {} : { error }) };
}

export function decodeUpdatePreference(value: unknown): UpdatePreference {
  const preference = decodeRecord(value, "update preference");
  return {
    autoDownload: requiredBoolean(preference, "autoDownload"),
    allowRemoteUpdates: requiredBoolean(preference, "allowRemoteUpdates"),
    autoInstall: requiredBoolean(preference, "autoInstall"),
  };
}

export function decodeAppBehaviorPreference(value: unknown): AppBehaviorPreference {
  const preference = decodeRecord(value, "app behavior preference");
  return {
    launchAtLogin: nullableBoolean(preference, "launchAtLogin"),
    keepRunningInBackground: nullableBoolean(preference, "keepRunningInBackground"),
    keepAwake: nullableBoolean(preference, "keepAwake"),
    keepAwakeOnBattery: nullableBoolean(preference, "keepAwakeOnBattery"),
  };
}

export function decodeExternalLinkPreference(value: unknown): ExternalLinkPreference {
  const target = decodeExternalLinkTarget(decodeRecord(value, "external link preference").target);
  if (!target) throw new Error("Invalid external link target.");
  return { target };
}

function decodeExternalLinkBrowser(value: unknown): ExternalLinkBrowser {
  const browser = decodeRecord(value, "browser");
  return { name: requiredString(browser, "name"), path: requiredString(browser, "path") };
}

export function decodeExternalLinkBrowserOrNull(value: unknown): ExternalLinkBrowser | null {
  return value === null ? null : decodeExternalLinkBrowser(value);
}

export function decodeExternalLinkBrowsers(value: unknown): ExternalLinkBrowsers {
  const list = decodeRecord(value, "browser list");
  if (!Array.isArray(list.browsers)) throw new Error("Invalid browser list.");
  return {
    defaultBrowser: decodeExternalLinkBrowserOrNull(list.defaultBrowser),
    browsers: list.browsers.map(decodeExternalLinkBrowser),
  };
}

export function decodeExternalLinkFallback(value: unknown): ExternalLinkFallback {
  return { name: requiredString(decodeRecord(value, "external link fallback"), "name") };
}

export function decodeRemoteSessionReusePreference(value: unknown): RemoteSessionReusePreference {
  return {
    keepBetweenRuns: requiredBoolean(decodeRecord(value, "remote session preference"), "keepBetweenRuns"),
  };
}

export function decodeRemoteNetworkRouteState(value: unknown): RemoteNetworkRouteState {
  const state = decodeRecord(value, "remote network route");
  if (!isRemoteNetworkRoute(state.route)) throw new Error("Invalid remote network route.");
  return { route: state.route, tailscaleConnected: requiredBoolean(state, "tailscaleConnected") };
}

export function decodeNotificationPreference(value: unknown): NotificationPreference {
  const preference = decodeRecord(value, "notification preference");
  return {
    desktopNotifications: requiredBoolean(preference, "desktopNotifications"),
    messagePreview: requiredBoolean(preference, "messagePreview"),
  };
}

export function decodeNotificationOpenedEvent(value: unknown): NotificationOpenedEvent {
  const opened = decodeRecord(value, "opened notification");
  return {
    serverId: requiredString(opened, "serverId"),
    agentId: requiredString(opened, "agentId"),
    threadId: nullableString(opened, "threadId"),
    ...(opened.channelId === undefined ? {} : { channelId: requiredString(opened, "channelId") }),
  };
}

const VOICE_MODEL_PHASES: readonly VoiceModelStatus["phase"][] = ["missing", "downloading", "ready", "error"];

export function decodeVoiceModelStatus(value: unknown): VoiceModelStatus {
  const status = decodeRecord(value, "voice model status");
  const { modelId, phase, progress } = status;
  if (!isVoiceModelId(modelId) || !isOneOf(VOICE_MODEL_PHASES, phase) || (progress !== null && !isNumber(progress))) {
    throw new Error("Invalid voice model status.");
  }
  return { modelId, phase, progress, message: nullableString(status, "message") };
}

export function decodeVoiceSettings(value: unknown): VoiceSettings {
  const { modelId, language } = decodeRecord(value, "voice settings");
  if (!isVoiceModelId(modelId) || !isVoiceLanguage(language)) throw new Error("Invalid voice settings.");
  return { modelId, language };
}

export function decodeVoiceTranscriptionResult(value: unknown): VoiceTranscriptionResult {
  return { text: requiredString(decodeRecord(value, "voice transcription"), "text") };
}

export function decodeVoiceStream(value: unknown): VoiceStream {
  return { streamId: requiredString(decodeRecord(value, "voice stream"), "streamId") };
}

export function decodeVoiceStreamTranscript(value: unknown): VoiceStreamTranscript {
  const transcript = decodeRecord(value, "voice stream transcript");
  return { streamId: requiredString(transcript, "streamId"), text: requiredString(transcript, "text") };
}

export function decodeVoiceServerSettings(value: unknown): VoiceServerSettings | null {
  if (value === null) return null;
  if (!isVoiceServerSettings(value)) throw new Error("Invalid voice server settings.");
  const { address, hasApiKey, routes } = value;
  const { dictation, speech, transcriptionModel, speechModel, voice } = routes;
  return { address, hasApiKey, routes: { dictation, speech, transcriptionModel, speechModel, voice } };
}

export function decodeVoiceServerProbe(value: unknown): VoiceServerProbe {
  if (!isVoiceServerProbe(value)) throw new Error("Invalid voice server test result.");
  if (!value.ok) return { ok: false, field: value.field, message: value.message };
  const { transcription, speech, voices } = value.models;
  return { ok: true, models: { transcription: [...transcription], speech: [...speech], voices: [...voices] } };
}

export function decodeExportResult(value: unknown): ExportResult {
  return { saved: requiredBoolean(decodeRecord(value, "export result"), "saved") };
}

// The same check for a Marketplace link: the agent id or skill slug began in a URL a web page chose.
// Only the two fields come through, so nothing else main could add reaches the renderer.
export function decodePendingMarketplaceListing(value: unknown): MarketplaceListingLink | null {
  if (!isDynamicRecord(value) || !isString(value.id)) return null;
  if (value.kind === "agent" && isMarketplaceAgentId(value.id)) return { kind: "agent", id: value.id };
  if (value.kind === "skill" && isMarketplaceSkillSlug(value.id)) return { kind: "skill", id: value.id };
  return null;
}

export const decodeVoid = emptyDecoder("IPC returned unexpected data.");

/** True shows the hint that `Cmd + Q` must be held or pressed twice, and false removes it. */
export function decodeQuitShortcutHint(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  throw new Error("Invalid quit shortcut hint.");
}
