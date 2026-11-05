import { isConversationMessageSender } from "../ipc-conversation-messages";
import { isDynamicRecord, isString } from "../runtime-values";
import type { TeamProtocolV8BaseJsonObject, TeamProtocolV8BaseJsonValue } from "./v8-base";

/**
 * `senderMember` rides beside the frozen conversation projection, in the way `plan` does: the
 * shipped key lists drop it, so a client on protocol 1-4 shows every user message as its reader's
 * own, as it always did. Only the current protocol names the person who wrote it.
 *
 * A present sender must decode. The projection removes the key, so an unchecked value would reach
 * the client as a name no member bound allowed. Fail closed instead; an absent sender still means
 * an older host, or a message from before senders were kept.
 */
export function withConversationSenders(
  projected: TeamProtocolV8BaseJsonValue,
  source: unknown,
): TeamProtocolV8BaseJsonValue {
  if (!isDynamicRecord(projected) || !isDynamicRecord(source)) return projected;
  const senders = new Map<string, TeamProtocolV8BaseJsonObject>();
  for (const message of [
    ...(Array.isArray(source.messages) ? source.messages : []),
    // A page names the messages its replies point at separately, and a quoted reply names its author.
    ...(isDynamicRecord(source.references) ? Object.values(source.references) : []),
  ]) {
    if (!isDynamicRecord(message) || message.senderMember === undefined) continue;
    if (!isConversationMessageSender(message.senderMember)) throw new Error("Invalid conversation sender.");
    if (isString(message.id)) senders.set(message.id, { id: message.senderMember.id, name: message.senderMember.name });
  }
  if (senders.size === 0) return projected;
  const withSender = (message: TeamProtocolV8BaseJsonValue): TeamProtocolV8BaseJsonValue => {
    if (!isDynamicRecord(message) || !isString(message.id)) return message;
    const senderMember = senders.get(message.id);
    return senderMember === undefined ? message : { ...message, senderMember };
  };
  const result: TeamProtocolV8BaseJsonObject = { ...projected };
  if (Array.isArray(result.messages)) result.messages = result.messages.map(withSender);
  if (isDynamicRecord(result.references)) {
    result.references = Object.fromEntries(
      Object.entries(result.references).map(([id, value]) => [id, withSender(value)]),
    );
  }
  return result;
}
