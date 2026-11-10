// Frozen optional host profile proxy contract. Owner/admin only. It never grants member egress.
// Saved passwords are write-only. Clear restores the host system proxy and closes profile tabs.
import {
  type AdminDecoder,
  adminRoute,
  boolean,
  fields,
  nullable,
  type OptionalRouteCodec,
  string,
} from "./admin-wire";

export const BROWSER_PROFILE_PROXY_CAPABILITY = "browser-profile-proxy-v1";
export const BROWSER_PROFILE_PROXY_ROUTES = {
  read: "/v1/admin/browser-profile-proxy/read",
  save: "/v1/admin/browser-profile-proxy/save",
} as const;
const profileId: AdminDecoder = (value) => {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/u.test(value)) throw new Error("Invalid browser profile id.");
  return value;
};
const summary = fields({ profileId, address: nullable(string(2048)), hasPassword: boolean });
export const BROWSER_PROFILE_PROXY_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [BROWSER_PROFILE_PROXY_ROUTES.read, adminRoute(fields({ profileId }), summary)],
  [
    BROWSER_PROFILE_PROXY_ROUTES.save,
    adminRoute(fields({ profileId, address: nullable(string(2048)) }, { keepPassword: boolean }), summary),
  ],
]);
