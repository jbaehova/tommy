// Frozen optional host-logo-v1 wire contract.
//
// What it grants: each member can read the logo of the server over a connection that carries only
// JSON. The answer holds base64 of the image, at most 512 KiB, the limit that host-admin-v1 sets.
// `version` is the logo that the client knows. A host with another logo answers 404.
import { isDynamicRecord, isString } from "../runtime-values";
import { adminRoute, fields, type OptionalRouteCodec, oneOf, string } from "./admin-wire";

export interface HostLogo {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
}

export const HOST_LOGO_CAPABILITY = "host-logo-v1";

export const HOST_LOGO_ROUTES = {
  read: "/v1/host/logo",
} as const;

/** Base64 of 512 KiB: `ceil(524288 / 3) * 4`. */
const LOGO_BASE64_LIMIT = 699_052;

const decodeLogoFields = fields({
  mimeType: oneOf("image/png", "image/jpeg", "image/webp"),
  data: string(LOGO_BASE64_LIMIT),
});

const isLogoType = (value: unknown): value is HostLogo["mimeType"] =>
  value === "image/png" || value === "image/jpeg" || value === "image/webp";

export function decodeHostLogo(value: unknown): HostLogo {
  const logo = decodeLogoFields(value);
  if (!isDynamicRecord(logo) || !isLogoType(logo.mimeType) || !isString(logo.data))
    throw new Error("Invalid host logo.");
  return { mimeType: logo.mimeType, data: logo.data };
}

export const HOST_LOGO_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [HOST_LOGO_ROUTES.read, adminRoute(fields({ version: string(128) }), decodeLogoFields)],
]);
