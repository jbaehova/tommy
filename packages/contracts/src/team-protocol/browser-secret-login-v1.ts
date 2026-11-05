// Frozen optional browser-secret-login-v1 wire contract. Keep IPC types out of this file.
//
// What it grants, recorded here because freezing it makes it permanent: the secure card of a host
// agent can ask for the account name beside the password, with one form on one page step. A host adds
// `askUsername` and an optional `username` to the takeover request only for a client with this
// capability. The client answers on its own route with the released submit fields, the `username`, and
// `saveToVault`. A save needs an owner or admin on the host, as `browser-secret-vault-v1` does. The
// answer never carries the password. Widening any of it needs a second capability.
import { isRequestId } from "../ipc-bounded-values";
import { isDynamicRecord, isString } from "../runtime-values";
import {
  type AdminDecoder,
  adminRoute,
  boolean,
  empty,
  fields,
  identifier,
  type OptionalRouteCodec,
  string,
} from "./admin-wire";
import { mapBrowserTakeoverRequests } from "./browser-secret-v1";
import type { TeamProtocolV8BaseJsonValue } from "./v8-base";

export const BROWSER_SECRET_LOGIN_CAPABILITY = "browser-secret-login-v1";

export const BROWSER_SECRET_LOGIN_ROUTES = {
  respond: "/v1/browser-secrets/respond-login",
} as const;

export const BROWSER_SECRET_USERNAME_LIMIT = 512;

const requestId: AdminDecoder = (value) => {
  if (!isRequestId(value)) throw new Error("Invalid admin identifier.");
  return value;
};

export const BROWSER_SECRET_LOGIN_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    BROWSER_SECRET_LOGIN_ROUTES.respond,
    adminRoute(
      fields({
        requestId,
        agentId: identifier,
        secret: string(4096),
        username: string(BROWSER_SECRET_USERNAME_LIMIT),
        saveToVault: boolean,
      }),
      empty,
    ),
  ],
]);

/** Adds the validated account-name request beside the frozen takeover projection. */
export function restoreBrowserSecretLogin(
  projected: TeamProtocolV8BaseJsonValue,
  source: unknown,
): TeamProtocolV8BaseJsonValue {
  return mapBrowserTakeoverRequests(projected, source, (target, request) => {
    if (!isDynamicRecord(target) || !isDynamicRecord(request) || !isDynamicRecord(request.secret)) return target;
    if (!isDynamicRecord(target.secret) || request.secret.askUsername !== true) return target;
    const { username } = request.secret;
    if (username !== undefined && (!isString(username) || username.length > BROWSER_SECRET_USERNAME_LIMIT))
      throw new Error("Invalid secure authentication metadata.");
    return {
      ...target,
      secret: { ...target.secret, askUsername: true, ...(username === undefined ? {} : { username }) },
    };
  });
}
