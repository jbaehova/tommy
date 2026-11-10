import { canAdministerServer } from "@tommy/contracts/ipc";
import {
  parseChannelHistoryDeleteInput,
  parseChannelMessageDeleteInput,
  parseHistoryDeleteInput,
  parseMessageDeleteInput,
  parseTaskMessageDeleteInput,
} from "@tommy/contracts/ipc-message-deletion";
import { CHAT_HISTORY_CAPABILITY, CHAT_HISTORY_ROUTES } from "@tommy/contracts/team-protocol/chat-history-v1";
import { MESSAGE_DELETE_CAPABILITY, MESSAGE_DELETE_ROUTES } from "@tommy/contracts/team-protocol/message-delete-v1";
import { sourceText } from "@tommy/i18n/source";
import type { Effect } from "effect";
import type { ChannelService } from "../../backend/channel-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import { MessageDeleteRefused } from "../../backend/message-deletion";
import type { TeamApiAgents, TeamApiMessageDeletion } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import {
  readJson,
  requireAdmin,
  requireAgentLevel,
  requireListedAgent,
  requireVisibleBodyAgent,
} from "./request-helpers";

const MESSAGE_PATHS = new Set<string>(Object.values(MESSAGE_DELETE_ROUTES));
const HISTORY_PATHS = new Set<string>(Object.values(CHAT_HISTORY_ROUTES));

/** The authenticated route derives access. No renderer or remote body can claim deleteAny. */
export async function routeMessageDeletion(
  context: TeamApiRequestContext,
  service: TeamApiMessageDeletion | undefined,
  agents: Pick<TeamApiAgents, "listAgents">,
  channels: { store: Pick<ChannelService["store"], "exists"> } | undefined,
  hidden: ReadonlySet<string>,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  const history = HISTORY_PATHS.has(url.pathname);
  if (method !== "POST" || (!history && !MESSAGE_PATHS.has(url.pathname))) return "unmatched";
  if (!service || !capabilities.has(history ? CHAT_HISTORY_CAPABILITY : MESSAGE_DELETE_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.agentSettingsUnsupported"));
  const body = await readJson(request);
  const requireAgent = (agentId: string, level: "chat" | "manage") => {
    requireVisibleBodyAgent({ agentId }, hidden);
    requireListedAgent(agents, agentId);
    requireAgentLevel(context, agentId, level);
  };
  const requireChannel = (channelId: string) => {
    if (!channels?.store.exists(channelId)) throw new HttpError(404, sourceText("error.team.routeNotFound"));
    // Released channel reads remain visible when one member is hidden. Deletion is scoped by the
    // authenticated message author below, not by access to every agent in that shared channel.
  };
  switch (url.pathname) {
    case MESSAGE_DELETE_ROUTES.agent: {
      const input = parse(() => parseMessageDeleteInput(body));
      requireAgent(input.agentId, "chat");
      return json(
        200,
        await run(
          service.deleteMessage(input, {
            memberId: member.id,
            deleteAny: context.agentLevel(input.agentId) === "manage",
          }),
        ),
      );
    }
    case MESSAGE_DELETE_ROUTES.task: {
      const input = parse(() => parseTaskMessageDeleteInput(body));
      requireAgent(input.agentId, "chat");
      return json(
        200,
        await run(
          service.deleteTaskMessage(input, {
            memberId: member.id,
            deleteAny: context.agentLevel(input.agentId) === "manage",
          }),
        ),
      );
    }
    case MESSAGE_DELETE_ROUTES.channel: {
      const input = parse(() => parseChannelMessageDeleteInput(body));
      requireChannel(input.channelId);
      return json(
        200,
        await run(
          service.deleteChannelMessage(input, { memberId: member.id, deleteAny: canAdministerServer(member.role) }),
        ),
      );
    }
    case CHAT_HISTORY_ROUTES.agentDelete: {
      const input = parse(() => parseHistoryDeleteInput(body));
      requireAgent(input.agentId, "manage");
      return json(200, await run(service.deleteAgentHistory(input)));
    }
    case CHAT_HISTORY_ROUTES.channelDelete: {
      requireAdmin(member);
      const input = parse(() => parseChannelHistoryDeleteInput(body));
      requireChannel(input.channelId);
      return json(200, await run(service.deleteChannelHistory(input)));
    }
  }
  return "unmatched";
}
function parse<A>(decode: () => A): A {
  try {
    return decode();
  } catch {
    throw new HttpError(400, "Invalid message deletion request.");
  }
}
async function run<A>(operation: Effect.Effect<A, { readonly cause: unknown }>): Promise<A> {
  try {
    return await runCauseEffect(operation);
  } catch (error) {
    if (error instanceof MessageDeleteRefused)
      throw new HttpError(
        error.reason === "busy" ? 409 : error.reason === "forbidden" ? 403 : 404,
        sourceText(
          error.reason === "busy"
            ? "error.backend.messageDeleteBusy"
            : error.reason === "forbidden"
              ? "error.backend.messageDeleteForbidden"
              : "error.backend.messageDeleteNotFound",
        ),
      );
    throw error;
  }
}
