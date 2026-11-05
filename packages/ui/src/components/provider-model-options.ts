import type {
  AgentProviderId,
  AgentProviderStatus,
  AgentStatus,
  ClientAgentModelOption,
  ProviderRuntimeStatus,
} from "@tommy/contracts/ipc";
import { agentProviderName, isKnownAgentProvider } from "@tommy/contracts/ipc";
import type { AppTranslate } from "@tommy/i18n";
import { currentText } from "../text";

export interface PickerModel {
  id: string;
  provider: AgentProviderId;
  name: string;
  service: string;
  free: boolean;
  variants: { id: string; name: string }[];
}

export interface PickerModelGroup {
  name: string;
  models: PickerModel[];
}

/** Free tier first; id says nothing about locality. */
function modelTier(model: PickerModel): 0 | 1 {
  return model.free ? 0 : 1;
}

export function pickerModels(options: ClientAgentModelOption[]): PickerModel[] {
  // A model of a provider that this build does not know has no tab here; the picker shows it alone.
  return options.flatMap((model) => {
    if (!isKnownAgentProvider(model.provider)) return [];
    const name = model.name.replace(/^[\s:–-]+/, "") || model.id;
    return { id: model.id, provider: model.provider, name, service: "", free: false, variants: [] };
  });
}

/** One group per service, ordered by best tier; tier orders, badge carries pricing. */
export function groupPickerModels(models: PickerModel[], search: string): PickerModelGroup[] {
  const query = search.trim().toLowerCase();
  const groups = new Map<string, PickerModelGroup>();
  const tiers = new Map<string, number>();
  for (const model of models) {
    if (!`${model.service} ${model.name}`.toLowerCase().includes(query)) continue;
    const name = model.service;
    const group = groups.get(model.service) ?? { name, models: [] };
    group.models.push(model);
    groups.set(model.service, group);
    tiers.set(model.service, Math.min(tiers.get(model.service) ?? modelTier(model), modelTier(model)));
  }
  for (const group of groups.values()) group.models.sort((left, right) => modelTier(left) - modelTier(right));
  // Tiers are keyed by service: an ACP group name is a label that differs from its key.
  return [...groups.entries()]
    .sort(([left], [right]) => (tiers.get(left) ?? 0) - (tiers.get(right) ?? 0))
    .map(([, group]) => group);
}

/**
 * The status of a provider: the one that the host reports, else one from the host phase. A host
 * that is ready and reports no status for a provider can run it when it lists a model of it.
 */
export function providerAvailability(
  status: AgentStatus,
  models: readonly ClientAgentModelOption[],
  provider: AgentProviderId,
  t: AppTranslate,
): AgentProviderStatus {
  const explicit = status.providers?.find((item) => item.id === provider);
  if (explicit) return explicit;
  if (status.phase === "starting" || status.phase === "restarting") {
    return { id: provider, state: "checking", version: null, message: null };
  }
  const available = models.some((model) => model.provider === provider);
  return {
    id: provider,
    state: available ? "available" : "error",
    version: null,
    message: available ? null : t("provider.picker.unavailable", { name: agentProviderName(provider) }),
  };
}

/** Whether the user turned the provider off on this computer. */
export function providerTurnedOff(status: AgentStatus, provider: AgentProviderId): boolean {
  return status.providers?.some((item) => item.id === provider && item.off) ?? false;
}

/**
 * Whether the user can choose a model of the provider now, or soon: it is available, Tommy checks
 * it, it signs in, or its runtime downloads. A provider that is not connected cannot.
 */
export function providerUsable(status: AgentProviderStatus, runtime?: ProviderRuntimeStatus): boolean {
  return (
    status.state === "available" ||
    status.state === "checking" ||
    status.connectionState === "connecting" ||
    runtime?.phase === "downloading" ||
    runtime?.phase === "finishing"
  );
}

/** Whether a model list offers the provider: it is on, and the user can choose its models now or soon. */
export function providerOffersModels(
  status: AgentStatus,
  models: readonly ClientAgentModelOption[],
  provider: AgentProviderId,
  runtime?: ProviderRuntimeStatus,
): boolean {
  return (
    !providerTurnedOff(status, provider) &&
    providerUsable(providerAvailability(status, models, provider, currentText().t), runtime)
  );
}
