import { isIdentifier } from "./ipc-bounded-values";
import { isDynamicRecord } from "./runtime-values";

export interface AgentSpeedSettings {
  fastMode: boolean | null;
  ultrafast: boolean;
}

export interface UpdateAgentSpeedInput {
  agentId: string;
  fastMode: boolean;
  ultrafast: boolean;
}

export interface AgentSpeedModel {
  provider: string;
  id: string;
  fastServiceTier: string;
  ultrafastServiceTier?: string;
}

export interface AgentSpeedModels {
  models: AgentSpeedModel[];
}

export function parseUpdateAgentSpeedInput(value: unknown): UpdateAgentSpeedInput {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.agentId) ||
    typeof value.fastMode !== "boolean" ||
    typeof value.ultrafast !== "boolean" ||
    (value.ultrafast && !value.fastMode)
  )
    throw new Error("Invalid agent speed setting.");
  return { agentId: value.agentId, fastMode: value.fastMode, ultrafast: value.ultrafast };
}

export function decodeAgentSpeedSettingsFromHost(value: unknown): AgentSpeedSettings {
  if (
    !isDynamicRecord(value) ||
    (value.fastMode !== null && typeof value.fastMode !== "boolean") ||
    typeof value.ultrafast !== "boolean" ||
    (value.ultrafast && value.fastMode !== true)
  )
    throw new Error("Invalid agent speed settings response.");
  return { fastMode: value.fastMode, ultrafast: value.ultrafast };
}

function bounded(value: unknown, length: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= length;
}

export function decodeAgentSpeedModelsFromHost(value: unknown): AgentSpeedModels {
  if (!isDynamicRecord(value) || !Array.isArray(value.models) || value.models.length > 1_000)
    throw new Error("Invalid agent speed models response.");
  return {
    models: value.models.map((model) => {
      if (
        !isDynamicRecord(model) ||
        !isIdentifier(model.provider) ||
        !bounded(model.id, 160) ||
        !bounded(model.fastServiceTier, 64) ||
        (model.ultrafastServiceTier !== undefined && !bounded(model.ultrafastServiceTier, 64))
      )
        throw new Error("Invalid agent speed model response.");
      return {
        provider: model.provider,
        id: model.id,
        fastServiceTier: model.fastServiceTier,
        ...(model.ultrafastServiceTier === undefined ? {} : { ultrafastServiceTier: model.ultrafastServiceTier }),
      };
    }),
  };
}
