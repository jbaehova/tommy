import { parseUpdateAgentSpeedInput } from "@tommy/contracts/ipc-agent-speed";
import { AGENT_SPEED_CAPABILITY, AGENT_SPEED_ROUTES } from "@tommy/contracts/team-protocol/agent-speed-v1";
import { sourceText } from "@tommy/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import { AgentNotFoundError } from "../agent-admin-settings";
import type { TeamApiAdmin } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAgentLevel, requireVisibleBodyAgent, stringField } from "./request-helpers";

const PATHS = new Set<string>(Object.values(AGENT_SPEED_ROUTES));

export async function routeAgentSpeed(
  context: TeamApiRequestContext,
  admin: TeamApiAdmin | undefined,
  hidden: ReadonlySet<string>,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json } = context;
  if (method !== "POST" || !PATHS.has(url.pathname)) return "unmatched";
  const settings = admin?.agentHost;
  if (!settings || !capabilities.has(AGENT_SPEED_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.agentSettingsUnsupported"));
  const body = await readJson(request);
  if (url.pathname === AGENT_SPEED_ROUTES.models) return json(200, settings.listSpeedModels());
  requireVisibleBodyAgent(body, hidden);
  const agentId = stringField(body, "agentId");
  requireAgentLevel(context, agentId, url.pathname === AGENT_SPEED_ROUTES.settings ? "view" : "manage");
  try {
    if (url.pathname === AGENT_SPEED_ROUTES.settings) return json(200, settings.readSpeed(agentId));
    let input: ReturnType<typeof parseUpdateAgentSpeedInput>;
    try {
      input = parseUpdateAgentSpeedInput(body);
    } catch {
      throw new HttpError(400, "Invalid agent speed setting.");
    }
    return json(200, await runCauseEffect(settings.updateSpeed(input)));
  } catch (error) {
    if (error instanceof AgentNotFoundError) throw new HttpError(404, error.message);
    throw error;
  }
}
