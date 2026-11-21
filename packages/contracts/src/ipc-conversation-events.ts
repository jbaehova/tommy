import { INPUT_LIMITS } from "./input-limits";
import { isBoundedString, isIdentifier } from "./ipc-bounded-values";
import type { ConversationMessage } from "./ipc-conversation-messages";
import type { RoutineRunStatus } from "./ipc-routines";
import { isDynamicRecord, isString } from "./runtime-values";

export const ROUTINE_EVENT_ITEM_TYPE_PREFIX = "routine-event:";

export type RoutineConversationEventAction = "created" | "updated" | "deleted";

export const ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX = "routine-run-event:";

export type RoutineRunConversationEventStatus = Exclude<RoutineRunStatus, "queued">;

export const HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX = "hosted-site-event:";

export type HostedSiteConversationEventAction = "publish" | "replace" | "delete";

export type HostedSiteConversationEventStatus = "running" | "succeeded" | "failed" | "interrupted" | "cancelled";

export interface HostedSiteConversationEventDetails {
  siteId: string | null;
  title: string;
  hostname: string | null;
  url: string | null;
}

function isHostedSiteConversationEventDetails(value: unknown): value is HostedSiteConversationEventDetails {
  if (
    !isDynamicRecord(value) ||
    (value.siteId !== null && !isIdentifier(value.siteId)) ||
    !isBoundedString(value.title, 120) ||
    value.title.trim().length === 0 ||
    (value.hostname !== null && (!isString(value.hostname) || !isHostedSiteHostname(value.hostname))) ||
    (value.url !== null && !isHostedSiteConversationEventUrl(value.url, value.hostname))
  ) {
    return false;
  }
  return value.hostname !== null || value.url === null;
}

export function routineConversationEventItemType(action: RoutineConversationEventAction, routineId: string): string {
  if (!isIdentifier(routineId)) throw new Error("A valid routine id is required.");
  const itemType = `${ROUTINE_EVENT_ITEM_TYPE_PREFIX}${action}:${routineId}`;
  if (itemType.length > INPUT_LIMITS.identifier) throw new Error("The routine event item type is too long.");
  return itemType;
}

export function routineRunConversationEventItemType(
  status: RoutineRunConversationEventStatus,
  routineId: string,
  runId: string,
): string {
  if (!isIdentifier(routineId)) throw new Error("A valid routine id is required.");
  if (!isIdentifier(runId)) throw new Error("A valid routine run id is required.");
  const itemType = `${ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX}${status}:${routineId}:${runId}`;
  if (itemType.length > INPUT_LIMITS.identifier) throw new Error("The routine run event item type is too long.");
  return itemType;
}

export function hostedSiteConversationEventItemType(
  action: HostedSiteConversationEventAction,
  status: HostedSiteConversationEventStatus,
  operationId: string,
): string {
  if (!isIdentifier(operationId)) throw new Error("A valid hosted site operation id is required.");
  const itemType = `${HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX}${action}:${status}:${operationId}`;
  if (itemType.length > INPUT_LIMITS.identifier) throw new Error("The hosted site event item type is too long.");
  return itemType;
}

export function hostedSiteConversationEventText(details: HostedSiteConversationEventDetails): string {
  if (!isHostedSiteConversationEventDetails(details)) throw new Error("Valid hosted site event details are required.");
  return JSON.stringify(details);
}

function isHostedSiteHostname(value: string): boolean {
  if (value.length === 0 || value.length > INPUT_LIMITS.hostname || value !== value.toLowerCase()) return false;
  try {
    const parsed = new URL(`https://${value}`);
    return (
      parsed.hostname === value &&
      parsed.port === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      value.endsWith(".tommy.invalid")
    );
  } catch {
    return false;
  }
}

export function isHostedSiteConversationEventUrl(value: unknown, hostname: unknown): value is string {
  if (!isBoundedString(value, INPUT_LIMITS.browserUrl) || !isString(hostname) || !isHostedSiteHostname(hostname)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return false;
    }
    if (parsed.protocol === "https:") return parsed.hostname === hostname && parsed.port === "";
    if (parsed.protocol !== "http:" || !parsed.port) return false;
    const port = Number(parsed.port);
    const label = hostname.slice(0, -".tommy.invalid".length);
    return Number.isInteger(port) && port >= 1_024 && port <= 65_535 && parsed.hostname === `${label}.tommy.localhost`;
  } catch {
    return false;
  }
}

export const CHANNEL_ROUTING_EVENT_ITEM_TYPE_PREFIX = "channel-routing-event:";

/**
 * `assigned` is the first owner a lead chose for a request. `continued` is the same request handed
 * to work that is already under way, so the reader sees that nothing new was started.
 */
export type ChannelRoutingConversationEventAction = "assigned" | "continued";

export interface ChannelRoutingConversationEvent {
  action: ChannelRoutingConversationEventAction;
  /** The member the request went to. The roster resolves the name, avatar and colour of the row. */
  agentId: string;
}

export function channelRoutingConversationEventItemType(
  action: ChannelRoutingConversationEventAction,
  agentId: string,
): string {
  if (!isIdentifier(agentId)) throw new Error("A valid agent id is required.");
  const itemType = `${CHANNEL_ROUTING_EVENT_ITEM_TYPE_PREFIX}${action}:${agentId}`;
  if (itemType.length > INPUT_LIMITS.identifier) throw new Error("The channel routing event item type is too long.");
  return itemType;
}

export function parseChannelRoutingConversationEventItemType(
  itemType: string | undefined,
): ChannelRoutingConversationEvent | null {
  if (!itemType?.startsWith(CHANNEL_ROUTING_EVENT_ITEM_TYPE_PREFIX)) return null;
  const [action, agentId, ...extra] = itemType.slice(CHANNEL_ROUTING_EVENT_ITEM_TYPE_PREFIX.length).split(":");
  if (extra.length > 0 || (action !== "assigned" && action !== "continued") || !isIdentifier(agentId)) return null;
  return { action, agentId };
}

/**
 * A routing receipt of a channel, not a message a member sent.
 *
 * Unlike the routine and hosted-site events, this one carries no `source`: a channel writes its
 * rows through `ChannelService`, which stamps the author alone. The text stays the readable
 * sentence, so a client that does not know this item type still shows the user what happened.
 */
export function channelRoutingConversationEvent(message: ConversationMessage): ChannelRoutingConversationEvent | null {
  if (message.author !== "system" || message.status !== "completed") return null;
  return parseChannelRoutingConversationEventItemType(message.itemType);
}

/**
 * The item type of the marker that clears the context of an agent's own thread.
 *
 * The messages before the marker stay visible, but a new provider session takes only the messages
 * after it. The text is a readable sentence, so a client that does not know this item type still
 * shows the user what happened.
 */
export const CONTEXT_RESET_ITEM_TYPE = "context-reset";

/**
 * The item types of the markers that show a switch of model for a plan's usage limit or a provider
 * error: one when the agent leaves its model, one when it goes back. The text is a readable sentence
 * that names the model, as for the context reset.
 */
export const MODEL_SWITCH_ITEM_TYPE_PREFIX = "model-switch:";
export const MODEL_SWITCH_ITEM_TYPES = {
  "usage-limit": `${MODEL_SWITCH_ITEM_TYPE_PREFIX}usage-limit`,
  "usage-limit-ended": `${MODEL_SWITCH_ITEM_TYPE_PREFIX}usage-limit-ended`,
  "provider-error": `${MODEL_SWITCH_ITEM_TYPE_PREFIX}provider-error`,
  "provider-error-ended": `${MODEL_SWITCH_ITEM_TYPE_PREFIX}provider-error-ended`,
} as const;
export type ModelSwitchReason = keyof typeof MODEL_SWITCH_ITEM_TYPES;

/**
 * The item type of the note that a member agent changed its channel at a person's request: a
 * member, the instructions or a routine. The text is a readable sentence that names the agent, the
 * change and the person, as for the model switch.
 */
export const CHANNEL_CHANGE_ITEM_TYPE = "channel-change";

export function isChannelChangeMarker(message: ConversationMessage): boolean {
  return (
    message.author === "system" &&
    message.source === "system" &&
    message.status === "completed" &&
    message.itemType === CHANNEL_CHANGE_ITEM_TYPE
  );
}

/**
 * The item type of the note that an agent added, changed or deleted a Vault item. The text is a
 * readable sentence that names the item, never a secret.
 */
export const VAULT_CHANGE_ITEM_TYPE = "vault-change";

/**
 * The item type of the note that a turn ended with open steps in the agent's plan, and that the agent
 * continues by itself. The text says which automatic continuation this is.
 */
export const PLAN_CONTINUATION_ITEM_TYPE = "plan-continuation";

/**
 * The item type of a message that one agent sends to another, in the sender's thread and in the
 * recipient's thread. It is traffic between agents, not a message to the user.
 */
export const AGENT_EXCHANGE_ITEM_TYPE = "agent-exchange";

export function isContextResetMarker(message: ConversationMessage): boolean {
  return (
    message.author === "system" &&
    message.source === "system" &&
    message.status === "completed" &&
    message.itemType === CONTEXT_RESET_ITEM_TYPE
  );
}
