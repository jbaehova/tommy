// Optional message-delete-v1 wire contract. Only protocol 9 can advertise it.
// A member can remove their own sent message when they can use its chat. Removing another person's
// message needs agent manage access, or server owner/admin access for a channel. The host refuses
// active-turn messages with 409, inaccessible messages with 404 and unauthorized removals with 403.
// Removal affects the host's displayed history for all members. Provider memory can still retain it.
// A retry retains requestId. The host computes all access fields.
import { adminRoute, boolean, fields, identifier, type OptionalRouteCodec } from "./admin-wire";

export const MESSAGE_DELETE_CAPABILITY = "message-delete-v1";
export const MESSAGE_DELETE_ROUTES = {
  agent: "/v1/messages/delete",
  task: "/v1/messages/delete-task",
  channel: "/v1/channels/messages/delete",
} as const;

const result = fields({ deleted: boolean });
export const MESSAGE_DELETE_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    MESSAGE_DELETE_ROUTES.agent,
    adminRoute(fields({ agentId: identifier, messageId: identifier, requestId: identifier }), result),
  ],
  [
    MESSAGE_DELETE_ROUTES.task,
    adminRoute(
      fields({ agentId: identifier, taskId: identifier, messageId: identifier, requestId: identifier }),
      result,
    ),
  ],
  [
    MESSAGE_DELETE_ROUTES.channel,
    adminRoute(fields({ channelId: identifier, messageId: identifier, requestId: identifier }), result),
  ],
]);
