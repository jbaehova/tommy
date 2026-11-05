import { DESKTOP_FOCUS_CAPABILITY, DESKTOP_FOCUS_ROUTES } from "@tommy/contracts/team-protocol/desktop-focus-v1";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson } from "./request-helpers";

/** A desktop app of the calling member says whether it has focus. Frozen by `desktop-focus-v1`. */
export async function routeDesktopFocus(
  context: TeamApiRequestContext,
  record: (sessionId: string, memberId: string, focused: boolean) => void,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json, member, sessionId } = context;
  if (method !== "POST" || url.pathname !== DESKTOP_FOCUS_ROUTES.report) return "unmatched";
  if (!capabilities.has(DESKTOP_FOCUS_CAPABILITY)) return "unmatched";
  // `readJson` has already run the body through the desktop-focus wire codec.
  const body = await readJson(request);
  record(sessionId, member.id, body.focused === true);
  return json(200, {});
}
