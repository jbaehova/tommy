import { decodeBrowserProfileProxyInput } from "@tommy/contracts/browser-profile-proxy";
import { parseBrowserProfileId } from "@tommy/contracts/ipc";
import {
  BROWSER_PROFILE_PROXY_CAPABILITY,
  BROWSER_PROFILE_PROXY_ROUTES,
} from "@tommy/contracts/team-protocol/browser-profile-proxy-v1";
import { sourceText } from "@tommy/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import { BrowserProfileRejectedError } from "../browser-profile-service";
import type { TeamApiBrowserProfiles } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

export async function routeBrowserProfileProxy(
  context: TeamApiRequestContext,
  profiles: TeamApiBrowserProfiles | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (
    method !== "POST" ||
    (url.pathname !== BROWSER_PROFILE_PROXY_ROUTES.read && url.pathname !== BROWSER_PROFILE_PROXY_ROUTES.save)
  )
    return "unmatched";
  if (!profiles || !capabilities.has(BROWSER_PROFILE_PROXY_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.agentSettingsUnsupported"));
  requireAdmin(member);
  const body = await readJson(request);
  try {
    if (url.pathname === BROWSER_PROFILE_PROXY_ROUTES.read)
      return json(200, await runCauseEffect(profiles.proxy(parse(() => parseBrowserProfileId(body.profileId)))));
    return json(200, await runCauseEffect(profiles.setProxy(parse(() => decodeBrowserProfileProxyInput(body)))));
  } catch (error) {
    if (error instanceof BrowserProfileRejectedError) throw new HttpError(409, error.message);
    throw error;
  }
}
function parse<A>(decode: () => A): A {
  try {
    return decode();
  } catch {
    throw new HttpError(400, "Invalid browser profile proxy request.");
  }
}
