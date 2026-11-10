import { decodeVoiceLiveCancel, decodeVoiceLiveStart, decodeVoiceLiveStop } from "@tommy/contracts/ipc-voice";
import { LIVE_VOICE_CAPABILITY, LIVE_VOICE_ROUTES } from "@tommy/contracts/team-protocol/live-voice-v1";
import { isFixedSourceText, sourceText } from "@tommy/i18n/source";
import type { Effect } from "effect";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { TeamApiAgents, TeamApiLiveVoice } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAgentLevel, requireListedAgent, requireVisibleBodyAgent } from "./request-helpers";

/** Stable across event socket reconnects, private to one authenticated logical session. */
export function teamLiveVoiceOwner(memberId: string, sessionId: string): string {
  return `team:${memberId}:${sessionId}`;
}

export async function routeLiveVoice(
  context: TeamApiRequestContext,
  service: TeamApiLiveVoice | undefined,
  agents: Pick<TeamApiAgents, "listAgents">,
  hidden: ReadonlySet<string>,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, sessionId, request, json } = context;
  if (
    method !== "POST" ||
    (url.pathname !== LIVE_VOICE_ROUTES.start &&
      url.pathname !== LIVE_VOICE_ROUTES.stop &&
      url.pathname !== LIVE_VOICE_ROUTES.cancel)
  )
    return "unmatched";
  if (!service || !capabilities.has(LIVE_VOICE_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.agentSettingsUnsupported"));
  const body = await readJson(request);
  const ownerId = teamLiveVoiceOwner(member.id, sessionId);
  if (url.pathname === LIVE_VOICE_ROUTES.cancel) {
    await run(service.cancel(parse(() => decodeVoiceLiveCancel(body)).requestId, ownerId));
    return json(200, {});
  }
  if (url.pathname === LIVE_VOICE_ROUTES.stop) {
    await run(service.stop(parse(() => decodeVoiceLiveStop(body)).sessionId, ownerId));
    return json(200, {});
  }
  requireVisibleBodyAgent(body, hidden);
  const input = parse(() => decodeVoiceLiveStart(body));
  requireListedAgent(agents, input.agentId);
  requireAgentLevel(context, input.agentId, "chat");
  return json(200, await run(service.start(input, ownerId)));
}
function parse<A>(decode: () => A): A {
  try {
    return decode();
  } catch {
    throw new HttpError(400, "Invalid live voice request.");
  }
}
async function run<A>(operation: Effect.Effect<A, { readonly cause: unknown }>): Promise<A> {
  try {
    return await runCauseEffect(operation);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && isFixedSourceText(error.message)) throw new HttpError(409, error.message);
    throw error;
  }
}
