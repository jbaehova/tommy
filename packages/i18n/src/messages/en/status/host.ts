import { defineMessages } from "../../../message";

export const messages = defineMessages("status.host", {
  "status.host.telegramDisconnectUsage": "Send /disconnect @username in this manager chat.",
  "status.host.telegramDisconnectAmbiguous":
    "Multiple connections use @{username}. Check the current username in BotFather before disconnecting.",
  "status.host.telegramDisconnectedAlready": "@{username} has no connection to this Tommy server.",
  "status.host.telegramDisconnectConfirm":
    "To disconnect @{username}, send the command below within five minutes. Tommy keeps the agent and its workspace.\n\n/disconnect @{username} {code}",
  "status.host.telegramDisconnectExpired": "Start a new confirmation with /disconnect @{username}.",
  "status.host.telegramDisconnected":
    "Disconnected @{username}. Tommy keeps the agent and its workspace. To permanently delete the Telegram bot account, use /deletebot in @BotFather.",
});
