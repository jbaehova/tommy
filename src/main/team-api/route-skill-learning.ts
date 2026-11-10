import {
  parseLearnedSkillRevision,
  parseRestoreLearnedSkill,
  parseSaveSkillSuggestion,
  parseSkillLearningPreference,
} from "@tommy/contracts/ipc-skill-learning";
import { SKILL_LEARNING_CAPABILITY, SKILL_LEARNING_ROUTES } from "@tommy/contracts/team-protocol/skill-learning-v1";
import { sourceText } from "@tommy/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { TeamApiSkillLearning } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin, requireAgentLevel, requireVisibleBodyAgent } from "./request-helpers";

const PATHS = new Set<string>(Object.values(SKILL_LEARNING_ROUTES));

/** Settings and revision restore are admin actions. Saving a stored suggestion needs chat access. */
export async function routeSkillLearning(
  context: TeamApiRequestContext,
  service: TeamApiSkillLearning | undefined,
  hidden: ReadonlySet<string>,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (method !== "POST" || !PATHS.has(url.pathname)) return "unmatched";
  if (!service || !capabilities.has(SKILL_LEARNING_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.agentSettingsUnsupported"));
  if (url.pathname !== SKILL_LEARNING_ROUTES.save) requireAdmin(member);
  const body = await readJson(request);
  requireVisibleBodyAgent(body, hidden);
  switch (url.pathname) {
    case SKILL_LEARNING_ROUTES.listLocal:
      return json(200, await runCauseEffect(service.listLocalSkills()));
    case SKILL_LEARNING_ROUTES.readLocal:
      return json(200, await runCauseEffect(service.readLocalSkill(parse(parseLearnedSkillRevision, body))));
    case SKILL_LEARNING_ROUTES.settings:
      return json(200, service.snapshot());
    case SKILL_LEARNING_ROUTES.update:
      return json(200, await runCauseEffect(service.set(parse(parseSkillLearningPreference, body))));
    case SKILL_LEARNING_ROUTES.save: {
      const input = parse(parseSaveSkillSuggestion, body);
      requireAgentLevel(context, input.agentId, "chat");
      return json(200, await runCauseEffect(service.save(input)));
    }
    case SKILL_LEARNING_ROUTES.restore:
      return json(200, await runCauseEffect(service.restore(parse(parseRestoreLearnedSkill, body))));
  }
  return "unmatched";
}

function parse<A>(decode: (input: unknown) => A, input: unknown): A {
  try {
    return decode(input);
  } catch {
    throw new HttpError(400, "Invalid skill learning request.");
  }
}
