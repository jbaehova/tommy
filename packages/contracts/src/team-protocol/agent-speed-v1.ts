// Optional agent-speed-v1 contract. Released agent-fast-mode-v1 remains unchanged.
// A member needs view access to read settings and manage access to update them.
// A missing capability disables this speed control. A missing Ultrafast model tier falls back to Fast.
import {
  adminRoute,
  boolean,
  empty,
  fields,
  identifier,
  list,
  nullable,
  type OptionalRouteCodec,
  string,
} from "./admin-wire";

export const AGENT_SPEED_CAPABILITY = "agent-speed-v1";
export const AGENT_SPEED_ROUTES = {
  models: "/v1/agent-speed/models",
  settings: "/v1/agent-speed",
  update: "/v1/agent-speed/update",
} as const;

const model = fields(
  { provider: identifier, id: string(160), fastServiceTier: string(64) },
  { ultrafastServiceTier: string(64) },
);
const settings = fields({ fastMode: nullable(boolean), ultrafast: boolean });

export const AGENT_SPEED_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [AGENT_SPEED_ROUTES.models, adminRoute(empty, fields({ models: list(model, 1_000) }))],
  [AGENT_SPEED_ROUTES.settings, adminRoute(fields({ agentId: identifier }), settings)],
  [
    AGENT_SPEED_ROUTES.update,
    adminRoute(fields({ agentId: identifier, fastMode: boolean, ultrafast: boolean }), settings),
  ],
]);
