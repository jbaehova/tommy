import { type AgentProviderStatus, DEFAULT_PROVIDER_ACCOUNT_ID } from "@tommy/contracts/ipc";
import { decodeProviderAccountModels, parseProviderAccountModelsInput } from "@tommy/contracts/provider-account-models";
import {
  PROVIDER_ACCOUNT_MODELS_CAPABILITY,
  PROVIDER_ACCOUNT_MODELS_ROUTE,
} from "@tommy/contracts/team-protocol/provider-account-models-v1";
import { sourceText } from "@tommy/i18n/source";
import type { TeamApiProviderAccountModels } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

/** A catalog exposes account capabilities, so an ordinary member cannot read it. */
export async function routeProviderAccountModels(
  context: TeamApiRequestContext,
  service: TeamApiProviderAccountModels | undefined,
): Promise<RouteOutcome> {
  const { method, url, member, capabilities, request, json } = context;
  if (method !== "POST" || url.pathname !== PROVIDER_ACCOUNT_MODELS_ROUTE) return "unmatched";
  requireAdmin(member);
  if (!service || !capabilities.has(PROVIDER_ACCOUNT_MODELS_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.providersUnsupported"));
  const body = await readJson(request);
  let input: ReturnType<typeof parseProviderAccountModelsInput>;
  try {
    input = parseProviderAccountModelsInput(body);
  } catch {
    throw new HttpError(400, "Invalid provider account model request.");
  }
  const status: AgentProviderStatus | undefined = service
    .getStatus()
    .providers?.find((row) => row.id === input.provider);
  if (
    !status ||
    status.off ||
    (input.providerAccountId &&
      input.providerAccountId !== DEFAULT_PROVIDER_ACCOUNT_ID &&
      !status.accounts?.some((account) => account.id === input.providerAccountId))
  )
    throw new HttpError(404, sourceText("error.team.providersUnsupported"));
  const account = input.providerAccountId
    ? status.accounts?.find((row) => row.id === input.providerAccountId)
    : undefined;
  // A listed but unavailable account has no authoritative catalog yet. Never substitute another account.
  if (account && account.models === undefined) throw new HttpError(409, sourceText("error.team.providersUnsupported"));
  const models = service.listAgentModels(input).filter((model) => model.provider === input.provider);
  return json(200, decodeProviderAccountModels({ models }, input.provider));
}
