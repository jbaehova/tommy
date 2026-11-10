// A remote host is untrusted. These are the response and event boundaries used by the desktop
// adapters. The preload implements its FromMain twins separately.
import { type BrowserProfileProxySummary, decodeHostBrowserProfileProxy } from "@tommy/contracts/browser-profile-proxy";
import {
  isWorkflowIntegrationCatalog,
  type VaultTwoStepCodes,
  type WorkflowIntegrationCatalog,
} from "@tommy/contracts/ipc";
import {
  type AgentSpeedModels,
  type AgentSpeedSettings,
  decodeAgentSpeedModelsFromHost as decodeRemoteSpeedModels,
  decodeAgentSpeedSettingsFromHost as decodeRemoteSpeedSettings,
} from "@tommy/contracts/ipc-agent-speed";
import { decodeList, decodeRecord, requiredNumber, requiredString } from "@tommy/contracts/ipc-decoding";
import {
  decodeHistoryDeleteResult,
  decodeMessageDeleteResult,
  type HistoryDeleteResult,
  type MessageDeleteResult,
  type MessageDeletionEvent,
} from "@tommy/contracts/ipc-message-deletion";
import {
  decodeHostSkillLearning,
  decodeLearnedSkillDetail,
  decodeLearnedSkillDetails,
  decodeRestoreLearnedSkillResult,
  decodeSaveSkillSuggestionResult,
  type HostSkillLearning,
  type RestoreLearnedSkillResult,
  type SaveSkillSuggestionResult,
} from "@tommy/contracts/ipc-skill-learning";
import {
  decodeVoiceLiveEvent,
  decodeVoiceLiveSession,
  type ScopedVoiceLiveEvent,
  type VoiceLiveSession,
} from "@tommy/contracts/ipc-voice";
import { messageDeletionEvent } from "@tommy/contracts/team-protocol/message-deletion-events-v1";

export function decodeAgentSpeedModelsFromHost(value: unknown): AgentSpeedModels {
  return decodeRemoteSpeedModels(value);
}

export function decodeAgentSpeedSettingsFromHost(value: unknown): AgentSpeedSettings {
  return decodeRemoteSpeedSettings(value);
}

export function decodeBrowserProfileProxyFromHost(value: unknown): BrowserProfileProxySummary {
  return decodeHostBrowserProfileProxy(value);
}

export function decodeSkillLearningFromHost(value: unknown): HostSkillLearning {
  const setting = decodeHostSkillLearning(value);
  if (!setting.mode || setting.choices.some((choice) => !choice))
    throw new Error("Invalid skill learning setting from host.");
  return setting;
}

export function decodeSavedSkillSuggestionFromHost(value: unknown): SaveSkillSuggestionResult {
  return decodeSaveSkillSuggestionResult(value);
}

export function decodeRestoredLearnedSkillFromHost(value: unknown): RestoreLearnedSkillResult {
  return decodeRestoreLearnedSkillResult(value);
}

export function decodeMessageDeleteResultFromHost(value: unknown): MessageDeleteResult {
  return decodeMessageDeleteResult(value);
}

export function decodeHistoryDeleteResultFromHost(value: unknown): HistoryDeleteResult {
  return decodeHistoryDeleteResult(value);
}

export function decodeMessageDeletionEventFromHost(value: unknown): MessageDeletionEvent {
  const event = messageDeletionEvent(value);
  if (!event) throw new Error("Invalid message deletion event from host.");
  return event;
}

export function decodeVoiceLiveSessionFromHost(value: unknown): VoiceLiveSession {
  return decodeVoiceLiveSession(value);
}

export function decodeScopedVoiceLiveEventFromHost(value: unknown): ScopedVoiceLiveEvent {
  const scoped = decodeRecord(value, "live voice event scope");
  const serverId = requiredString(scoped, "serverId");
  if (!serverId || serverId.length > 128) throw new Error("Invalid live voice event scope from host.");
  return { serverId, event: decodeVoiceLiveEvent(scoped.event) };
}

const VAULT_SECRET_KEYS = ["password", "number", "securityCode", "key", "twoStepKey", "secret"] as const;

export function decodeVaultCodesFromHost(value: unknown): VaultTwoStepCodes {
  const answer = decodeRecord(value, "Vault codes response");
  if (!Array.isArray(answer.codes) || answer.codes.length > 10_000 || VAULT_SECRET_KEYS.some((key) => key in answer))
    throw new Error("Invalid Vault codes response.");
  return {
    codes: decodeList(answer.codes, "Vault code", (item) => {
      const id = requiredString(item, "id");
      const code = requiredString(item, "code");
      const period = requiredNumber(item, "period");
      const remainingMs = requiredNumber(item, "remainingMs");
      if (
        !id ||
        id.length > 64 ||
        !/^\d{6,8}$/u.test(code) ||
        !Number.isInteger(period) ||
        period < 10 ||
        period > 300 ||
        !Number.isFinite(remainingMs) ||
        remainingMs < 0 ||
        remainingMs > period * 1_000 ||
        VAULT_SECRET_KEYS.some((key) => key in item)
      )
        throw new Error("Invalid Vault code response.");
      return { id, code, period, remainingMs };
    }),
  };
}

export function decodeWorkflowIntegrationCatalogFromHost(value: unknown): WorkflowIntegrationCatalog {
  if (!isWorkflowIntegrationCatalog(value)) throw new Error("Invalid workflow integration catalog from host.");
  return {
    github: value.github,
    places: value.places.map((place) => ({
      connectionId: place.connectionId,
      placeId: place.placeId,
      label: place.label,
      platform: place.platform,
      connection: place.connection,
      name: place.name,
    })),
    slack: value.slack.map((connection) => ({
      connectionId: connection.connectionId,
      name: connection.name,
      channels: connection.channels.map(({ id, name }) => ({ id, name })),
    })),
    telegram: value.telegram.map(({ connectionId, name }) => ({ connectionId, name })),
    discord: value.discord.map((connection) => ({
      connectionId: connection.connectionId,
      name: connection.name,
      channels: connection.channels.map(({ id, name }) => ({ id, name })),
      roles: connection.roles.map(({ id, name }) => ({ id, name })),
    })),
  };
}

export function decodeLearnedSkillFromHost(
  value: unknown,
): import("@tommy/contracts/ipc-skills").MarketplaceSkillDetail {
  return decodeLearnedSkillDetail(value);
}
export function decodeLearnedSkillsFromHost(
  value: unknown,
): import("@tommy/contracts/ipc-skills").MarketplaceSkillDetail[] {
  return decodeLearnedSkillDetails(value);
}
