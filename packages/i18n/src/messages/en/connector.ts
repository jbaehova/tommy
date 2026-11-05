import { defineMessages } from "../../message";

export const messages = defineMessages("connector", {
  // Marketplace > Apps > GitHub: the built-in GitHub connection.
  "connector.github.title": "GitHub",
  "connector.github.description":
    "Every agent on this computer can use your GitHub repositories, issues and pull requests, and gh and git.",
  "connector.github.connect": "Connect GitHub",
  "connector.github.pendingTitle": "Type this code on GitHub",
  "connector.github.pendingDescription": "GitHub opened in your browser. Type the code there to connect.",
  "connector.github.waiting": "Waiting for GitHub",
  "connector.github.copyCode": "Copy code",
  "connector.github.codeCopied": "Copied",
  "connector.github.openGitHub": "Open GitHub",
  "connector.github.cancel": "Cancel",
  "connector.github.connectedAs": "Connected as @{login}",
  "connector.github.repositoriesTitle": "Repositories",
  "connector.github.repositoriesDescription":
    "Agents can use only the repositories where the Tommy GitHub App is installed.",
  "connector.github.chooseRepositories": "Choose repositories",
  "connector.github.repositoriesLoading": "Reading the repositories from GitHub",
  "connector.github.noRepositories": "The Tommy GitHub App is not installed on a repository yet.",
  // {count} is a number, such as 12.
  "connector.github.moreRepositories": { one: "And {count} more repository", other: "And {count} more repositories" },
  // A badge next to a repository that only its members can see.
  "connector.github.private": "Private",
  "connector.github.disconnect": "Disconnect",
  "connector.github.disconnectTitle": "Disconnect GitHub",
  "connector.github.disconnectSummary": "Every agent loses GitHub. Your chats and files stay.",
  "connector.github.expiredTitle": "The GitHub connection expired",
  "connector.github.expiredDescription": "Connect again as @{login} to give agents GitHub again.",
  "connector.github.reconnect": "Reconnect",
  "connector.github.actionFailed": "Tommy could not change the GitHub connection.",
  // The status next to the name at the top of the GitHub page.
  "connector.github.statusConnected": "Connected",
  "connector.github.statusConnecting": "Connecting",
  "connector.github.statusExpired": "Expired",
  "connector.github.accountTitle": "Account",
  // {count} is the number of repositories in the list, such as 12.
  "connector.github.filterPlaceholder": { one: "Filter {count} repository", other: "Filter {count} repositories" },
  "connector.github.filterLabel": "Filter repositories",
  // {query} is the text the user typed in the filter.
  "connector.github.noMatch": "No repository matches “{query}”.",
  // The connect dialog. The steps show as numbers; screen readers read the names.
  "connector.github.stepSignIn": "Sign in",
  "connector.github.stepConnected": "Connected",
  "connector.github.requestingCode": "Tommy asks GitHub for a code.",
  // {code} is the code to type on GitHub, such as WDJB-MJHT.
  "connector.github.codeLabel": "Code {code}",
  "connector.github.failedTitle": "GitHub did not connect",
  "connector.github.cancelConnecting": "Cancel connecting GitHub",
  // {count} is the number of repositories that agents can use.
  "connector.github.connectedSummary": {
    one: "{count} repository · every agent on this computer",
    other: "{count} repositories · every agent on this computer",
  },
  "connector.github.done": "Done",
  "connector.github.later": "Later",
  // The confirmation before Disconnect. {login} is the GitHub account name, such as octocat.
  "connector.github.disconnectConfirmTitle": "Disconnect GitHub?",
  "connector.github.disconnectConfirmDescription": "Disconnect removes the sign-in of @{login} from this computer.",
  "connector.github.disconnectEffectTools": "Every agent loses the GitHub tools, gh and git.",
  "connector.github.disconnectEffectRevoke": "Then GitHub opens, where you can revoke Tommy.",
  "connector.github.disconnectEffectKept": "Chats, files and agent memory stay on this computer.",
  // The same text for the connection of a joined server. {host} is the server name, such as Studio.
  "connector.github.descriptionHost":
    "Every agent on {host} can use your GitHub repositories, issues and pull requests, and gh and git.",
  "connector.github.connectedSummaryHost": {
    one: "{count} repository · every agent on {host}",
    other: "{count} repositories · every agent on {host}",
  },
  "connector.github.disconnectConfirmDescriptionHost": "Disconnect removes the sign-in of @{login} from {host}.",
  "connector.github.disconnectEffectKeptHost": "Chats, files and agent memory stay on {host}.",
  "connector.github.keepConnected": "Keep connected",
  "connector.github.close": "Close",
  // The last section of an integration page, with the action that removes it.
  "connector.dangerZone": "Danger zone",
  "connector.readFailed": "Tommy could not read the state of this connection.",

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
  // The exact folder name that Tommy looks for in the vault. Keep it in English.
});
