// Optional workflow connector catalog. Existing workflows-v1 routes and codecs stay unchanged.
import {
  adminRoute,
  boolean,
  empty,
  fields,
  identifier,
  list,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";

export const WORKFLOWS_EXTENSIONS_CAPABILITY = "workflows-extensions-v1";
export const WORKFLOWS_EXTENSIONS_ROUTES = {
  integrationCatalog: "/v1/workflows/integrations",
} as const;

const name = string(256);
const named = fields({ id: identifier, name });
const connection = { connectionId: identifier, name };
const catalog = fields({
  github: boolean,
  places: list(
    fields({
      connectionId: identifier,
      placeId: identifier,
      label: string(768),
      platform: oneOf("slack", "discord", "telegram"),
      connection: name,
      name,
    }),
    1_000,
  ),
  slack: list(fields({ ...connection, channels: list(named, 1_000) }), 100),
  telegram: list(fields(connection), 100),
  discord: list(fields({ ...connection, channels: list(named, 1_000), roles: list(named, 1_000) }), 100),
});

export const WORKFLOWS_EXTENSIONS_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [WORKFLOWS_EXTENSIONS_ROUTES.integrationCatalog, adminRoute(empty, catalog)],
]);
