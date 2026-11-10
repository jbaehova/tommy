import { type AgentModelOption, type AgentProviderId, isAgentModelOption } from "@tommy/contracts/ipc";
import { type ProviderAccountModels, providerAccountModel } from "@tommy/contracts/provider-account-models";
import { isDynamicRecord } from "@tommy/contracts/runtime-values";

/** A trusted main response still validates every row before the renderer receives it. */
export function decodeProviderAccountModelsFromMain(value: unknown, provider?: AgentProviderId): ProviderAccountModels {
  if (
    !isDynamicRecord(value) ||
    !Array.isArray(value.models) ||
    value.models.length > 1_000 ||
    !value.models.every(isAgentModelOption) ||
    (provider !== undefined && value.models.some((model) => model.provider !== provider))
  )
    throw new Error("Invalid account models from main.");
  return { models: value.models.map((model: AgentModelOption) => providerAccountModel(model)) };
}
