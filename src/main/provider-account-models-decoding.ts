import type { AgentProviderId } from "@tommy/contracts/ipc";
import { decodeProviderAccountModels, type ProviderAccountModels } from "@tommy/contracts/provider-account-models";

/** The remote host is untrusted. Keep its catalog decoding separate from current IPC decoding. */
export function decodeProviderAccountModelsFromHost(value: unknown, provider: AgentProviderId): ProviderAccountModels {
  return decodeProviderAccountModels(value, provider);
}
