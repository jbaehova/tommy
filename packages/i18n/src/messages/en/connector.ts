import { defineMessages } from "../../message";

export const messages = defineMessages("connector", {
  // Marketplace > Apps > Slack: a workspace installs the one Tommy app, and the Slack
  // Orchestrator agent receives each request, asks the team and answers.
  // {workspace} is the Slack workspace name.
  // {action} is a button, such as Pause; {name} is the workspace name.
  // The connect dialog. The steps show as numbers; screen readers read the names.
  // {workspace} is the Slack workspace name.
  // Shown when the page has the maximum number of workspaces.
  // {count} is the number of Slack workspaces: two or more.
  // Marketplace > Apps > Discord: a Discord server (a guild) adds the one Tommy bot, and
  // the Discord Orchestrator agent receives each request, asks the team and answers. Always write
  // "Discord server": "server" alone is an Tommy server.
  // {workspace} is the Discord server name.
  // {action} is a button, such as Pause; {name} is the Discord server name.
  // The connect dialog. The steps show as numbers; screen readers read the names.
  // {workspace} is the Discord server name.
  // {count} is the number of Discord servers: two or more.
  // Who can use Tommy in one Discord server: the members with one of the chosen Discord roles.
  // {roles} is a list of Discord role names, such as "Admin and Moderator".
  // {workspace} is the Discord server name.
  // {role} is the name of a Discord role that the server no longer has.
  // {host} is the joined server's name.
  // Marketplace > Apps > Telegram: each chat adds the one Tommy bot, and the Telegram
  // Orchestrator agent receives the messages of all chats, asks the team and answers.
  // {count} is the number of linked Telegram chats.
  // {action} is a button, such as Pause; {name} is the chat name.
  // The connect dialog. The steps show as numbers; screen readers read the names.
  // {chat} is the Telegram chat name.
  // Marketplace > 1Password: a vault that the user shares with Tommy through a service account.
  // The three setup steps before a connection, each with the one button it needs.
  // {version} is a version number, such as 2.39.0.
  // The last row of the setup steps: the other way to connect, without the CLI.
  // {count} is a number, such as 3.
  // The same page for the connection of a joined server. {host} is the server name, such as Studio.
  // The exact folder name that Tommy looks for in the vault. Keep it in English.,
});
