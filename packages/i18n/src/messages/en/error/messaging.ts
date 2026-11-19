import { defineMessages } from "../../../message";

export const messages = defineMessages("error.messaging", {
  // Errors of a Slack workspace connection, which the host sends.
  // Errors of a Discord server connection, which the host sends.
  // Errors of a Telegram chat connection, which the host sends.
  "error.messaging.telegramExchangeUnavailable":
    "Tommy could not confirm the Telegram delivery. Check that both agents are connected and permit messages from other bots.",
  "error.messaging.telegramPeerTaskFailed":
    "The other Telegram agent could not complete the task. Check its provider connection before you retry.",
  "error.messaging.telegramExchangeLimit":
    "This Telegram exchange reached its delivery limit. Ask the owner to start a new task.",
  // The agent gets this when a connected workspace has too many saved facts.
});
