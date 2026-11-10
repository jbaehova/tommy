import type { ClientAgentModelOption, ServerSummary } from "@tommy/contracts/ipc";
import { serverSupportsCapability } from "../servers/server-capabilities";
import { agentsPort } from "./agents-port";

/** Frozen model routes keep their shape. The additive route supplies supported speed tiers. */
export async function withAgentSpeedModels(
  models: ClientAgentModelOption[],
  server: ServerSummary | undefined,
): Promise<ClientAgentModelOption[]> {
  if (server?.kind !== "remote" || !serverSupportsCapability(server, "agent-speed-v1")) return models;
  const speed = await agentsPort()
    .agent.getAgentSpeedModels(server.id)
    .catch(() => null);
  if (!speed) return models;
  return models.map((model) => {
    const tiers = speed.models.find((entry) => entry.provider === model.provider && entry.id === model.id);
    return tiers
      ? {
          ...model,
          fastServiceTier: tiers.fastServiceTier,
          ...(tiers.ultrafastServiceTier === undefined ? {} : { ultrafastServiceTier: tiers.ultrafastServiceTier }),
        }
      : model;
  });
}
