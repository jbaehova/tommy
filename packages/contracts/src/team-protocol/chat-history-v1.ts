// Optional chat-history-v1 wire contract. Only protocol 9 can advertise it.
// Agent manage access can remove an agent's main-chat history. A server owner/admin can remove a
// channel's history. These actions preserve agent setup, side threads, memories, routines and tasks.
// The host refuses while work runs or waits, ends affected provider sessions and removes unshared
// managed files. Provider transcript files can remain outside Tommy's database.
// A retry keeps requestId and cannot remove messages received after its first successful commit.
import { adminRoute, boolean, fields, identifier, type OptionalRouteCodec } from "./admin-wire";

export const CHAT_HISTORY_CAPABILITY = "chat-history-v1";
export const CHAT_HISTORY_ROUTES = {
  agentDelete: "/v1/agent-history/delete",
  channelDelete: "/v1/channels/history/delete",
} as const;

const result = fields({ deleted: boolean });
export const CHAT_HISTORY_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [CHAT_HISTORY_ROUTES.agentDelete, adminRoute(fields({ agentId: identifier, requestId: identifier }), result)],
  [CHAT_HISTORY_ROUTES.channelDelete, adminRoute(fields({ channelId: identifier, requestId: identifier }), result)],
]);
