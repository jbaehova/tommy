import { type AgentProviderId, isAgentProvider } from "./agent-providers";
import { type AgentModelOption, isAgentModelOption } from "./ipc-agent-identity";
import { DEFAULT_PROVIDER_ACCOUNT_ID, isProviderAccountId } from "./ipc-agent-status";
import { isDynamicRecord } from "./runtime-values";

export interface ProviderAccountModelsInput {
  provider: AgentProviderId;
  providerAccountId?: string;
}

export interface ProviderAccountModels {
  models: AgentModelOption[];
}

export function parseProviderAccountModelsInput(value: unknown): ProviderAccountModelsInput {
  if (
    !isDynamicRecord(value) ||
    !isAgentProvider(value.provider) ||
    (value.providerAccountId !== undefined && !isProviderAccountId(value.providerAccountId))
  )
    throw new Error("Invalid provider account model request.");
  return {
    provider: value.provider,
    ...(value.providerAccountId === undefined || value.providerAccountId === DEFAULT_PROVIDER_ACCOUNT_ID
      ? {}
      : { providerAccountId: value.providerAccountId }),
  };
}

/** Keep only catalog fields. A provider response cannot add credentials to current IPC metadata. */
export function providerAccountModel(model: AgentModelOption): AgentModelOption {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    description: model.description,
    defaultReasoningEffort: model.defaultReasoningEffort,
    supportedReasoningEfforts: [...model.supportedReasoningEfforts],
    ...(model.reasoningEffortConfigurable === undefined
      ? {}
      : { reasoningEffortConfigurable: model.reasoningEffortConfigurable }),
    ...(model.fastServiceTier === undefined ? {} : { fastServiceTier: model.fastServiceTier }),
    ...(model.ultrafastServiceTier === undefined ? {} : { ultrafastServiceTier: model.ultrafastServiceTier }),
  };
}

export function decodeProviderAccountModels(value: unknown, provider?: AgentProviderId): ProviderAccountModels {
  if (
    !isDynamicRecord(value) ||
    !Array.isArray(value.models) ||
    value.models.length > 1_000 ||
    !value.models.every(isAgentModelOption) ||
    (provider !== undefined && value.models.some((model) => model.provider !== provider))
  )
    throw new Error("Invalid provider account model catalog.");
  return { models: value.models.map(providerAccountModel) };
}
