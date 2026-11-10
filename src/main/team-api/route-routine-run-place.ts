import { isReleasedRoutineSchedule } from "@tommy/contracts/ipc";
import {
  ROUTINE_RUN_PLACE_CAPABILITY,
  ROUTINE_RUN_PLACE_ROUTES,
} from "@tommy/contracts/team-protocol/routine-run-place-v1";
import { sourceText } from "@tommy/i18n/source";
import { parseListEventRoutines, parseSaveEventRoutine } from "../host-events-inputs";
import { parseCreateRoutine, parseUpdateRoutine } from "../ipc/agent-inputs";
import type { TeamApiAgents, TeamApiOptions } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import {
  readJson,
  requireAdmin,
  requireAgentLevel,
  requireListedAgent,
  requireReleasedSchedule,
  requireVisibleBodyAgent,
  stringField,
} from "./request-helpers";
import { runEventsEffect } from "./route-events";

const PATHS = new Set<string>(Object.values(ROUTINE_RUN_PLACE_ROUTES));
export async function routeRoutineRunPlace(
  context: TeamApiRequestContext,
  agents: Pick<TeamApiAgents, "listAgents" | "listRoutines" | "createRoutine" | "updateRoutine">,
  events: TeamApiOptions["events"],
  hidden: ReadonlySet<string>,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (method !== "POST" || !PATHS.has(url.pathname)) return "unmatched";
  if (!capabilities.has(ROUTINE_RUN_PLACE_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.agentSettingsUnsupported"));
  const eventPath =
    url.pathname === ROUTINE_RUN_PLACE_ROUTES.eventList || url.pathname === ROUTINE_RUN_PLACE_ROUTES.eventSave;
  if (eventPath) requireAdmin(member);
  const body = await readJson(request);
  if (eventPath) {
    if (!events) throw new HttpError(400, sourceText("error.backend.eventsUnavailable"));
    if (url.pathname === ROUTINE_RUN_PLACE_ROUTES.eventList) {
      const input = parse(() => parseListEventRoutines(body));
      if (input.owner.kind === "agent") requireVisibleBodyAgent({ agentId: input.owner.id }, hidden);
      return json(
        200,
        (await runEventsEffect(events.listRoutines(input))).filter(
          ({ trigger }) => trigger.kind !== "schedule" || isReleasedRoutineSchedule(trigger.schedule),
        ),
      );
    }
    const input = parse(() => parseSaveEventRoutine(body));
    if (input.owner.kind === "agent") requireVisibleBodyAgent({ agentId: input.owner.id }, hidden);
    if (input.trigger.kind === "schedule") requireReleasedSchedule(input.trigger.schedule);
    if (input.id !== undefined) {
      const current = await runEventsEffect(events.listRoutines({ owner: input.owner }));
      if (
        current.some(
          ({ id, trigger }) =>
            id === input.id && trigger.kind === "schedule" && !isReleasedRoutineSchedule(trigger.schedule),
        )
      )
        throw new HttpError(404, sourceText("error.backend.routineGone"));
    }
    return json(200, await runEventsEffect(events.saveRoutine(input)));
  }
  requireVisibleBodyAgent(body, hidden);
  const agentId = stringField(body, "agentId");
  requireListedAgent(agents, agentId);
  requireAgentLevel(context, agentId, url.pathname === ROUTINE_RUN_PLACE_ROUTES.list ? "view" : "manage");
  if (url.pathname === ROUTINE_RUN_PLACE_ROUTES.list)
    return json(
      200,
      agents.listRoutines(agentId).filter(({ trigger }) => isReleasedRoutineSchedule(trigger.schedule)),
    );
  if (url.pathname === ROUTINE_RUN_PLACE_ROUTES.create) {
    const input = parse(() => parseCreateRoutine(body));
    requireReleasedSchedule(input.schedule);
    return json(201, agents.createRoutine(input));
  }
  const input = parse(() => parseUpdateRoutine(body));
  if (
    agents
      .listRoutines(agentId)
      .some(({ id, trigger }) => id === input.routineId && !isReleasedRoutineSchedule(trigger.schedule))
  )
    throw new HttpError(404, sourceText("error.backend.routineGone"));
  requireReleasedSchedule(input.schedule);
  return json(200, agents.updateRoutine(input));
}
function parse<A>(decode: () => A): A {
  try {
    return decode();
  } catch {
    throw new HttpError(400, "Invalid routine request.");
  }
}
