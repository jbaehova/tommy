import type { AgentProviderId } from "@tommy/contracts/ipc";
import type { ProviderPickerOption } from "@tommy/ui/components/ProviderPicker";

export interface OnboardingProviderRows {
  listed: ProviderPickerOption[];
  /** The providers behind "More providers". The four providers all fit in the list. */
  hidden: ProviderPickerOption[];
}

/** Whether the provider is connected, or its CLI is on the computer and only the sign-in is missing. */
function userHasProvider(option: ProviderPickerOption): boolean {
  return option.state === "available" || option.state === "sign-in-required" || option.state === "outdated";
}

/**
 * The provider rows of the first-run list. `kept` holds the rows that stay in their order, so a row
 * does not move under the pointer when a download finishes. After them come the providers that the
 * user has, then the others.
 */
export function onboardingProviderRows(
  options: readonly ProviderPickerOption[],
  kept: readonly AgentProviderId[] = [],
): OnboardingProviderRows {
  const keptRows = kept.flatMap((id) => options.filter((option) => option.id === id));
  const others = options.filter((option) => !kept.includes(option.id));
  return {
    listed: [...keptRows, ...others.filter(userHasProvider), ...others.filter((option) => !userHasProvider(option))],
    hidden: [],
  };
}
