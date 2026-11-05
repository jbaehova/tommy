import { INPUT_LIMITS } from "@tommy/contracts/input-limits";
import type {
  ConfigureHostInput,
  SetServerMutedInput,
  SetServerNotificationLevelInput,
  SetTeamTypingInput,
  UpdateHostIdentityInput,
} from "@tommy/contracts/ipc";
import { SERVER_MUTE_DURATIONS_MS, SERVER_NOTIFICATION_LEVELS } from "@tommy/contracts/ipc";
import { isBoolean, isOneOf, isString } from "@tommy/contracts/runtime-values";
import { parseAvatarImage } from "./avatar-inputs";
import { isObject, requireString } from "./validation";

export function parseHostConfig(value: unknown): ConfigureHostInput {
  if (!isObject(value)) throw new Error("Host configuration is required.");
  const serverName = requireString(value.serverName, "serverName", INPUT_LIMITS.serverName);
  if (serverName.trim().length < INPUT_LIMITS.serverNameMin) {
    throw new Error(`Server name must contain at least ${INPUT_LIMITS.serverNameMin} characters.`);
  }
  return {
    serverName,
    ...(value.logo === undefined ? {} : { logo: parseAvatarImage(value.logo) }),
  };
}

export function parseHostIdentity(value: unknown): UpdateHostIdentityInput {
  if (!isObject(value)) throw new Error("Host identity is required.");
  if (value.serverName === undefined && value.logo === undefined) {
    throw new Error("A host identity change is required.");
  }
  const serverName =
    value.serverName === undefined ? undefined : requireString(value.serverName, "serverName", INPUT_LIMITS.serverName);
  if (serverName !== undefined && serverName.trim().length < INPUT_LIMITS.serverNameMin) {
    throw new Error(`Server name must contain at least ${INPUT_LIMITS.serverNameMin} characters.`);
  }
  return {
    ...(serverName === undefined ? {} : { serverName }),
    ...(value.logo === undefined ? {} : { logo: parseAvatarImage(value.logo) }),
  };
}

export function parseSetTeamTyping(value: unknown): SetTeamTypingInput {
  if (!isObject(value) || !isBoolean(value.typing)) {
    throw new Error("Invalid typing state.");
  }
  if (value.agentId !== null && !isString(value.agentId)) {
    throw new Error("Invalid typing agent.");
  }
  if (value.typing && !value.agentId) throw new Error("A typing agent is required.");
  return {
    agentId: value.agentId === null ? null : requireString(value.agentId, "agentId", INPUT_LIMITS.identifier),
    typing: value.typing,
  };
}

export function parseSetServerMuted(value: unknown): SetServerMutedInput {
  if (!isObject(value) || !isBoolean(value.muted)) throw new Error("Invalid server mute setting.");
  const serverId = requireString(value.serverId, "serverId", INPUT_LIMITS.identifier);
  if (value.durationMs === undefined) return { serverId, muted: value.muted };
  // Only a mute has an end, and only the menu's durations are accepted.
  if (!value.muted || !isOneOf(SERVER_MUTE_DURATIONS_MS, value.durationMs)) {
    throw new Error("Invalid server mute duration.");
  }
  return { serverId, muted: true, durationMs: value.durationMs };
}

export function parseSetServerNotificationLevel(value: unknown): SetServerNotificationLevelInput {
  if (!isObject(value) || !isOneOf(SERVER_NOTIFICATION_LEVELS, value.level)) {
    throw new Error("Invalid server notification level.");
  }
  return { serverId: requireString(value.serverId, "serverId", INPUT_LIMITS.identifier), level: value.level };
}
