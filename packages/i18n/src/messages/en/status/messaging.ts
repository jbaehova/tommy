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
});
