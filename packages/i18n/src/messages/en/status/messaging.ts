import { defineMessages } from "../../../message";

export const messages = defineMessages("status.messaging", {
  // Text that Tommy posts in a Slack conversation. Slack users read it. It names no agent: in
  // Slack, every answer comes from Tommy.
  // The name and title of the agent that Tommy adds to answer in Slack. The user can rename it.
  // The same texts for Discord. Discord users read the first one.
  // The sidebar section that Tommy puts the Slack Orchestrator in. The user can rename it.
  "status.messaging.integrationsSection": "Integrations",
  // The page a development Slack install ends on.
  // Text that Tommy posts in a Telegram chat, and the Telegram Orchestrator agent. Telegram users
  // read the posts. The user can rename the agent.
  "status.messaging.telegramTaskFailed": "Your Telegram agent could not finish this task.",
  "status.messaging.telegramTaskCancelled": "Your Telegram agent stopped this task.",
  "status.messaging.telegramOpenApp": "Open Tommy",
  "status.messaging.telegramInitialMessage":
    "You are ready to receive work from your owner on Telegram. Wait for their first task.",
  "status.messaging.telegramOpenChat": "Start agent chat",
  "status.messaging.telegramCreateHelp": "Tap Create agent, choose a name and confirm the Telegram username.",
  "status.messaging.telegramCreate": "Create Telegram agent",
  "status.messaging.telegramActive": "Connected to Tommy",
  "status.messaging.telegramPending": "Waiting for verification",
  "status.messaging.telegramNoAgents": "You have no Telegram agents yet. Send /new to create one.",
  "status.messaging.telegramManagerHelp":
    "Send a message here to talk to your root agent. Use /connect to give your other agents their own chats, /new to create a new agent, and /agents to see your agent bots. Use /disconnect @username to unlink an agent bot. Use /browser to see the browser and /stop to stop the current task. Messages between agents appear in each agent's chat. Open Tommy for private browser requests.",
  "status.messaging.telegramChooseRoot": "Choose your root agent. It answers in this chat and leads your other agents.",
  "status.messaging.telegramRootCurrent": "{name} is your root agent. Choose another agent only to replace it.",
  "status.messaging.telegramRootSelected": "{name} is now your root agent. Send it a message here.",
  "status.messaging.telegramConnectHelp":
    "Tap an agent, then confirm the new bot in Telegram. Keep the suggested name so that the bot connects to that agent.",
  "status.messaging.telegramAllConnected": "Every agent already has a chat. Send /new to create a new agent.",
  "status.messaging.telegramChatReady": "@{username} is ready. Open its chat to talk to {name}.",
  "status.messaging.telegramChatHelp":
    "Send a task here. Use /engine codex or /engine claude to select an engine. Use /name to change the name. Use /browser to see the agent's browser, and /stop to stop the current task. You can send photos and files.",
  "status.messaging.telegramApprovalTitle": "{name} asks for approval",
  "status.messaging.telegramApprove": "Allow",
  "status.messaging.telegramDecline": "Decline",
  "status.messaging.telegramSkip": "Skip",
  "status.messaging.telegramDone": "Done",
  "status.messaging.telegramPickMany": "Tap every option that applies, then tap Done.",
  "status.messaging.telegramSecretAnswer": "Tommy deletes your answer from this chat after reading it.",
  "status.messaging.telegramAnswerSent": "Answer sent.",
  "status.messaging.telegramBrowserHelp": "Open Tommy to see this agent's browser tabs and answer its requests.",
  "status.messaging.telegramUnavailable": "This Tommy agent is unavailable on the server.",
  "status.messaging.telegramNeedsInput":
    "This agent needs your input on the VPS. Open Tommy to inspect the site and respond.",
  "status.messaging.telegramCommandConnect": "Give an agent its own chat",
  "status.messaging.telegramCommandNew": "Create a new agent",
  "status.messaging.telegramCommandAgents": "List the agent chats",
  "status.messaging.telegramCommandStop": "Stop the current task",
  "status.messaging.telegramCommandBrowser": "See the agent's browser",
  "status.messaging.telegramCommandRoot": "Change the root agent",
  "status.messaging.telegramCommandDisconnect": "Unlink an agent chat",
  "status.messaging.telegramCommandEngine": "Switch to codex or claude",
  "status.messaging.telegramCommandName": "Rename this agent",
  "status.messaging.telegramUnsupported":
    "Tommy cannot pass this kind of message on. Send text, a photo, a file, a voice message or a video.",
  "status.messaging.telegramEditedPrefix": "(Edited. This replaces my earlier message.)",
  "status.messaging.telegramStopped": "Stopped the current task.",
  "status.messaging.telegramLimit": "The engine plan reached its usage limit. Work continues at {time}.",
  "status.messaging.telegramLimitLater": "The engine plan reached its usage limit. Work continues when it resets.",
  "status.messaging.telegramNothingToStop": "Nothing is running.",
  "status.messaging.telegramFileFailed": "Tommy could not read the file. Files up to 20 MB work.",
});
