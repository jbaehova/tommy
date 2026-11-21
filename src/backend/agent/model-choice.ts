import type { AgentModelId, AgentModelOption, AgentProviderStatus, CreateAgentInput } from "@tommy/contracts/ipc";
import { defaultProviderModel, PICKER_PROVIDERS } from "@tommy/contracts/ipc";
import { sourceText } from "@tommy/i18n/source";
import type { AgentProvider } from "../agent-client";
import { providerLabel } from "./thread-items";

/** The provider and model setup or Settings recorded, `model` being `null` for the provider's default. */
export interface ProviderPreference {
  provider: AgentProvider;
  model: AgentModelId | null;
}

export interface ModelChoice {
  provider: AgentProvider;
  model: AgentModelOption;
}

/**
 * The model a new agent, or a profile draft with no agent, starts on for `provider`.
 *
 * Setup records a model beside the preferred provider, so that model comes first -- but only while
 * the CLI still lists it, because the list is the provider's answer and a saved id can name an
 * endpoint or a model that is gone. After it come the provider's own default and then whatever it
 * does list; `null` means it listed nothing at all.
 */
export function startingModel(
  provider: AgentProvider,
  models: AgentModelOption[],
  preference: ProviderPreference,
): AgentModelOption | null {
  const listed = (id: AgentModelId) => models.find((model) => model.provider === provider && model.id === id);
  const chosen = preference.model !== null && provider === preference.provider ? listed(preference.model) : null;
  return (
    chosen ?? listed(defaultProviderModel(provider)) ?? models.find((model) => model.provider === provider) ?? null
  );
}

/**
 * Why `model` of `provider` is not in `models`: the provider is not connected, it listed no models
 * (with its last error), or its list does not hold the id. A custom agent's model is checked against
 * that agent's own models, because one agent that failed to list leaves the others on `acp`. With no
 * provider there is nothing to check, and the error names no cause.
 */
export function modelUnavailableError(
  model: string,
  provider: AgentProvider | undefined,
  models: readonly AgentModelOption[],
  providers: readonly AgentProviderStatus[],
): Error {
  if (provider === undefined) return new Error(sourceText("error.agent.modelUnavailable"));
  const name = providerLabel(provider);
  const row = providers.find((candidate) => candidate.id === provider);
  if (row?.state !== "available") {
    return new Error(sourceText("error.agent.modelProviderNotConnected", { model, provider: name }));
  }
  const listed = models.some((candidate) => candidate.provider === provider);
  if (listed) return new Error(sourceText("error.agent.modelNotInProviderList", { model, provider: name }));
  return new Error(
    row.lastError
      ? sourceText("error.agent.modelListEmpty", { model, provider: name, detail: row.lastError })
      : sourceText("error.agent.modelListEmptyNoError", { model, provider: name }),
  );
}

/**
 * The provider and model a creation request names, resolved against what the CLIs list right now,
 * or `null` when the request names neither. A named model must be listed for the named provider;
 * a lone provider takes its default when listed, else whatever it lists first.
 */
export function creationModel(
  input: Pick<CreateAgentInput, "provider" | "model">,
  models: AgentModelOption[],
  providers: readonly AgentProviderStatus[] = [],
): ModelChoice | null {
  const { provider, model: requestedId } = input;
  if (provider === undefined && requestedId === undefined) return null;
  if (requestedId !== undefined) {
    const model = models.find(
      (candidate) => candidate.id === requestedId && (provider === undefined || candidate.provider === provider),
    );
    if (!model) throw modelUnavailableError(requestedId, provider, models, providers);
    if (provider !== undefined && model.provider !== provider) {
      throw new Error(sourceText("error.agent.modelProviderMismatch"));
    }
    return { provider: model.provider, model };
  }
  if (provider === undefined) return null;
  const model =
    models.find((candidate) => candidate.provider === provider && candidate.id === defaultProviderModel(provider)) ??
    models.find((candidate) => candidate.provider === provider) ??
    null;
  if (!model) throw new Error(sourceText("error.provider.noModelNamed", { provider: providerLabel(provider) }));
  return { provider, model };
}

/** Choose the saved provider first, then a provider that can start its model. */
export function startingChoice(
  models: AgentModelOption[],
  preference: ProviderPreference,
  providerAvailable: (provider: AgentProvider) => boolean,
): ModelChoice | null {
  // `PICKER_PROVIDERS` leaves out `acp`: a custom agent is a program the user added for a purpose,
  // so no agent moves to one unasked.
  const others = PICKER_PROVIDERS.filter((provider) => provider !== preference.provider);
  for (const provider of [preference.provider, ...others]) {
    const chosen = provider === preference.provider;
    if (!chosen && !providerAvailable(provider)) continue;
    const model = startingModel(provider, models, preference);
    if (model) return { provider, model };
  }
  return null;
}
