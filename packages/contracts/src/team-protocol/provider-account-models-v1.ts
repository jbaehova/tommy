// Additive V9 owner/admin catalog. Released provider-accounts-v1 remains unchanged.
import { adminRoute, boolean, fields, identifier, list, type OptionalRouteCodec, oneOf, string } from "./admin-wire";

export const PROVIDER_ACCOUNT_MODELS_CAPABILITY = "provider-account-models-v1";
export const PROVIDER_ACCOUNT_MODELS_ROUTE = "/v1/providers/account-models";

const provider = oneOf("claude", "codex", "cursor", "pi");
const effort = oneOf("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra");
const model = fields(
  {
    provider,
    id: string(160),
    name: string(160),
    description: string(2_000),
    defaultReasoningEffort: effort,
    supportedReasoningEfforts: list(effort, 8),
  },
  { reasoningEffortConfigurable: boolean, fastServiceTier: string(64), ultrafastServiceTier: string(64) },
);

export const PROVIDER_ACCOUNT_MODELS_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    PROVIDER_ACCOUNT_MODELS_ROUTE,
    adminRoute(fields({ provider }, { providerAccountId: identifier }), fields({ models: list(model, 1_000) })),
  ],
]);
