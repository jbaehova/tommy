import type { TeamApiOptions } from "./dependencies";
// The team itself: who you are, who else is here, and who is allowed to stay.
//
// Membership, invitations and sessions all run through `requireAdmin` first. That check is a
// throw, not a branch, so a route that forgets it does not fail closed - it quietly hands a member
// the administrator's view. Every handler below that touches another member calls it on its own
// first line for exactly that reason.

import { readFile } from "node:fs/promises";
import type { TeamPresenceSnapshot } from "@tommy/contracts/ipc";
import { TEAM_API_ROUTES } from "@tommy/contracts/team-api-routes";
import { HOST_LOGO_ROUTES } from "@tommy/contracts/team-protocol/host-logo-v1";
import { sourceText } from "@tommy/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { TeamStore } from "../team-store";
import type { TeamApiBrowser, TeamApiBrowserView } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { pathIdentifier, readJson, requireAdmin } from "./request-helpers";

export interface TeamRouteDependencies {
  store: Pick<TeamStore, "logout" | "resolveLogo" | "listMembers" | "listSessions" | "revokeSession">;
  /** A session or a member that ends gives back the browser tabs it controls. */
  browser?: Pick<TeamApiBrowser, "releaseUserControlHeldBy">;
  browserView?: Pick<TeamApiBrowserView, "revokeTeamSession">;
  onSessionRevoked?: TeamApiOptions["onSessionRevoked"];
  getPresence: () => TeamPresenceSnapshot;
  refreshPresence: () => void;
}

export async function routeTeam(
  context: TeamApiRequestContext,
  { store, browser, browserView, onSessionRevoked, getPresence, refreshPresence }: TeamRouteDependencies,
): Promise<RouteOutcome> {
  const { method, url, request, response, member, token, sessionId, json, empty } = context;

  if (method === "POST" && url.pathname === TEAM_API_ROUTES.auth.logout) {
    await runCauseEffect(store.logout(token));
    browser?.releaseUserControlHeldBy({ kind: "session", sessionId });
    await (browserView ? runCauseEffect(browserView.revokeTeamSession(sessionId)) : undefined);
    refreshPresence();
    return empty(204);
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.me) {
    return json(200, member);
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.team.presence) {
    return json(200, getPresence());
  }
  if (method === "POST" && url.pathname === HOST_LOGO_ROUTES.read) {
    const body = await readJson(request);
    const logo = store.resolveLogo();
    if (!logo || logo.version !== body.version) return json(404, { error: sourceText("error.team.logoNotFound") });
    return json(200, { mimeType: logo.mimeType, data: (await readFile(logo.path)).toString("base64") });
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.team.logo) {
    const logo = store.resolveLogo();
    if (!logo || (url.searchParams.get("v") && url.searchParams.get("v") !== logo.version)) {
      return json(404, { error: sourceText("error.team.logoNotFound") });
    }
    const bytes = await readFile(logo.path);
    response.writeHead(200, {
      "Content-Type": logo.mimeType,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(bytes);
    return "handled";
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.events) {
    return json(426, { error: "Use WebSocket for remote events." });
  }
  // Two routes a released client still asks for. They answer 426 rather than 404 so the client
  // shows "update the host" instead of treating the host as broken; the features behind them are
  // gone, and the wire protocol is frozen, so the tombstones stay.
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.host.remoteMac) {
    return json(426, { error: sourceText("error.team.updateRequired"), code: "protocol_mismatch" });
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.team.members) {
    requireAdmin(member);
    return json(200, store.listMembers());
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.team.sessions) {
    requireAdmin(member);
    return json(200, store.listSessions());
  }
  const sessionMatch = url.pathname.match(/^\/v1\/team\/sessions\/([^/]+)$/);
  if (method === "DELETE" && sessionMatch) {
    requireAdmin(member);
    const revokedSessionId = pathIdentifier(sessionMatch[1], "sessionId");
    // Admins manage members, not the owner: only the owner ends the owner's sessions.
    const target = store.listSessions().find((session) => session.id === revokedSessionId);
    const targetMember = target && store.listMembers().find((candidate) => candidate.id === target.memberId);
    if (member.role !== "owner" && targetMember?.role === "owner") {
      throw new HttpError(400, sourceText("error.team.ownerCannotChange"));
    }
    await runCauseEffect(store.revokeSession(revokedSessionId));
    await (onSessionRevoked ? runCauseEffect(onSessionRevoked(revokedSessionId)) : undefined);
    browser?.releaseUserControlHeldBy({ kind: "session", sessionId: revokedSessionId });
    await (browserView ? runCauseEffect(browserView.revokeTeamSession(revokedSessionId)) : undefined);
    refreshPresence();
    return empty(204);
  }

  return "unmatched";
}
