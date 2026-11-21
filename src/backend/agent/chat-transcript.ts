import { CHAT_VISUAL_ITEM_TYPE_PREFIX } from "@tommy/contracts/chat-visual";
import {
  type AgentSummary,
  CONVERSATION_PLAN_ITEM_TYPE,
  CONVERSATION_SUBAGENTS_ITEM_TYPE,
  type ConversationMessage,
  ROUTINE_QUIET_ANSWER_ITEM_TYPE,
} from "@tommy/contracts/ipc";
import { tagSafe } from "./developer-instructions";

const MESSAGE_CHARACTERS = 4_000;
const CHAT_CHARACTERS = 60_000;

/** Indented JSON for a prompt block, with `<` escaped as `tagSafe` does. */
export function promptJson(value: unknown): string {
  return tagSafe(JSON.stringify(value, null, 2));
}

/** A message that a person or the agent wrote in the chat, not a tool step or a status line. */
function chatMessage(message: ConversationMessage): boolean {
  return (
    (message.author === "user" || message.author === "assistant" || message.author === "agent") &&
    message.text.trim().length > 0 &&
    message.itemType !== "commentary" &&
    message.itemType !== "question_prompt" &&
    message.itemType !== "agent_attachment" &&
    !message.itemType?.startsWith(CHAT_VISUAL_ITEM_TYPE_PREFIX) &&
    message.itemType !== CONVERSATION_PLAN_ITEM_TYPE &&
    message.itemType !== CONVERSATION_SUBAGENTS_ITEM_TYPE &&
    message.itemType !== ROUTINE_QUIET_ANSWER_ITEM_TYPE
  );
}

/** The chat messages that fit the budget, newest last, each with the name of its writer. */
export function chatTranscript(agent: AgentSummary, messages: readonly ConversationMessage[]) {
  const entries: { from: string; text: string }[] = [];
  let characters = 0;
  for (const message of [...messages].filter(chatMessage).reverse()) {
    const text = message.text.slice(0, MESSAGE_CHARACTERS);
    if (characters + text.length > CHAT_CHARACTERS) break;
    characters += text.length;
    const from =
      message.author === "user"
        ? (message.senderMember?.name ?? "User")
        : message.senderAgentId
          ? "Another agent"
          : agent.name;
    entries.push({ from, text });
  }
  return entries.reverse();
}
