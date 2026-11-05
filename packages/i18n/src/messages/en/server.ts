import { defineMessages } from "../../message";

export const messages = defineMessages("server", {
  "server.connection.planEnded": "The plan for {name} has ended",
  "server.connection.wakeFailed": "Could not start {name}",
  "server.connection.startTimeout": "{name} did not start in time",
  "server.connection.sleeping": "{name} is asleep",
  "server.connection.waking": "Starting {name}",
  "server.connection.startProgress": "{step} · {time}",
  "server.connection.providerLimit": "The cloud provider limits new starts now. Tommy tries again soon.",
  "server.connection.updating": "Updating {name}",
  "server.connection.loading": "Loading {name}",
  "server.connection.connecting": "Connecting to {name}",
  "server.connection.reconnecting": "Reconnecting to {name}",
  "server.connection.blocked": "{name} needs your attention",
  "server.connection.nextRetry": "Next attempt in {seconds} seconds.",
  "server.connection.wakeHint": "Use this workspace or select Retry to start the server.",
  "server.connection.planHint": "Open account settings to check the server plan.",
  "server.connection.loadingHint": "You can select another server while this one loads.",
  "server.connection.cachedHint": "Loaded content and drafts are kept. Server actions will resume after reconnection.",
  "server.connection.conversationFailed": "The conversation could not load. Try again.",
  "server.connection.panelsFailed": "Some workspace panels could not load. Try again.",
  "server.connection.retry": "Retry",
  "server.connection.manage": "Open settings",
  "server.connection.restored": "Connection to {name} restored",
  "server.connection.details": "Details",

  "server.status.steps": "Connection steps",
  "server.status.updateCause": "{name} restarts to install Tommy {version}.",
  "server.status.updateCauseNoVersion": "{name} restarts to install an Tommy update.",
  "server.status.wakeCause": "{name} was stopped. Tommy starts it again.",
  "server.status.connectCause": "This app connects to {name}.",
  "server.status.connectionCause": "This app lost its connection to {name}. It connects again automatically.",
  "server.status.stepUpdate": "Install the update",
  "server.status.stepUpdateDetail": "Tommy stops, installs the update and starts again.",
  "server.status.stepWake": "Start the server",
  "server.status.stepWakeDetail": "This can take a few minutes.",
  "server.status.stepConnect": "Connect",
  "server.status.stepConnectDetail": "This app opens a connection to the server.",
  "server.status.stepLoad": "Load the workspace",
  "server.status.stepLoadDetail": "Agents and chats load from the server.",
  "server.status.elapsed": "Elapsed: {time}",

  // The dialog that the plus button on the server rail opens. {price} is a formatted amount, such as "€20".
  // The switch left of the billing period, when the account has no license. Work adds a license to the server.
  // The row under the plans that sets the users of the license. It is disabled for personal use.
  // A toast when "Fewer members" is at the people who use the account's servers now. The license must include them.
  // On each plan that the people fit, for work. {percent} is a whole number, such as 20.
  // The plan summary for work: the price includes the license. {license} is the license line, such as
  // "Team license, 5 members".
  // {amount} is a formatted amount, such as "€120". It follows the yearly price.
  // Visually hidden. It comes before the struck-through monthly price on yearly billing.
  // The footer under the plans, for needs that the plans do not cover.
  // A small menu in the top corner of the hosted server plans, with the ways to add a server without a plan.
  // An item in the "Other options" menu of the hosted server plans. The server runs on this computer, with its own agents, chats and files.
  // Shown over the plans when the account has the maximum number of hosted servers. The plans are disabled.
  // Opens the list of the account's hosted servers, where the user can delete one.
  // The offer of a hosted server after a new routine that depends on the user's computer.
  // {name} is the routine.
  // Labels in the small picture above the modal text: a laptop and a server, each with a status.
  // One line under the notice that the user's computer is offline.
  "server.upsell.offline": "An Tommy server stays on 24/7, so routines keep running.",
  "server.upsell.seePlans": "See plans",
  // The setup waits for the first payment on the Stripe page in the browser.
  // The name of a new server. {number} is a number, such as 2.
  "server.hosted.detail.start.boot": "Turning on the machine",
  "server.hosted.detail.start.app": "Starting Tommy",
  "server.mute.for15Minutes": "For 15 minutes",
  "server.mute.for1Hour": "For 1 hour",
  "server.mute.for3Hours": "For 3 hours",
  "server.mute.for8Hours": "For 8 hours",
  "server.mute.for24Hours": "For 24 hours",
  "server.mute.untilTurnedOn": "Until I turn it back on",
  "server.mute.muted": "Muted",
  "server.mute.mutedUntil": "Muted until {time}",
  "server.notificationLevel.all": "All activity",
  "server.notificationLevel.needsMe": "Only when it needs me",
  "server.notificationLevel.nothing": "Nothing",
  "server.state.online": "online",
  "server.state.connecting": "connecting",
  "server.state.offline": "offline",
  "server.state.error": "error",
  "server.state.incompatible": "incompatible",
  "server.menu.open": "Open server menu for {name}",
  "server.menu.label": "Server menu",
  "server.menu.settings": "Server settings",
  "server.menu.disconnect": "Disconnect this computer",
  // Added to the tooltip of a server that runs on this computer, after its name.
  "server.rail.notificationsMuted": "notifications muted",
  "server.rail.unmute": "Unmute server",
  // The last items of the server menu. Leave is for a joined server; restart and delete are for a hosted server that the user owns.
  // Hides the server on this computer from the server list while the user has other servers.
  // Brings the hidden server on this computer back to the server list. {name} is its name, "Local".
  "server.select.failedTitle": "Could not select the server",
  "server.select.failedDescription": "Could not switch servers. Try again.",
  "server.select.openAgentFailed": "Could not open {name}. Find it in the sidebar.",
  "server.settings.unavailable": "This server is not available.",
  "server.settings.identityRefreshFailed": "The server identity could not refresh.",
  "server.settings.loadFailed": "The server settings could not load.",
  "server.settings.identityLocalOnly": "The name and logo of this server can only change on the computer that runs it.",
  "server.connection.failedTitle": "The connection failed",
  "server.connection.failedDescription":
    "Could not connect to this server. Check that the host is online and try again.",
  "server.notifications.changeFailedTitle": "Could not change server notifications",
  "server.notifications.changeFailedDescription": "Could not save the setting. Try again.",
  "server.settings.generalTitle": "General",
  "server.settings.generalDescription": "Manage this server’s name, logo, and preferences.",
  "server.settings.vaultTitle": "Vault",
  "server.settings.vaultDescription":
    "Save logins, cards and contact info that every agent on this server can fill in.",
  "server.settings.mcpTitle": "MCP",
  "server.settings.mcpDescription": "Connect MCP servers and choose which ones this server’s agents can use.",
  "server.settings.storageTitle": "Storage",
  "server.settings.storageDescription": "See what Tommy keeps on this server’s disk, and free space.",
  "server.settings.transferTitle": "Transfer",
  "server.settings.transferDescription": "Move this server's agents and server settings to or from a file.",
  "server.settings.routinesTitle": "Routines",
  "server.settings.routinesDescription": "Show the routine schedule of this computer in a calendar app.",
  "server.routineFeed.title": "Calendar feed",
  "server.routineFeed.offTitle": "The calendar feed is off",
  "server.routineFeed.offDescription":
    "Make a private URL, then subscribe to it in Apple Calendar (On My Mac) or in another calendar app that reads it on this computer. Each run of the next 30 days shows as an event. Paused routines are not shown.",
  "server.routineFeed.create": "Make feed URL",
  "server.routineFeed.urlLabel": "Feed URL",
  "server.routineFeed.agentLabel": "Agent filter",
  "server.routineFeed.allAgents": "All agents and channels",
  "server.routineFeed.copy": "Copy URL",
  "server.routineFeed.privacy":
    "Anyone with this URL can read routine names and run times. The URL works only on this computer, so Google Calendar and iCloud cannot read it.",
  "server.routineFeed.regenerate": "New URL",
  "server.routineFeed.regenerateLabel": "Make a new URL. The old URL stops working.",
  "server.routineFeed.turnOff": "Turn off",
  "server.routineFeed.loading": "Loading the calendar feed",
  "server.routineFeed.regenerateTitle": "Make a new URL?",
  "server.routineFeed.regenerateDescription":
    "The current URL stops working. Calendars that use it stop updating until you subscribe again with the new URL.",
  "server.routineFeed.regenerateConfirm": "Make new URL",
  "server.routineFeed.turnOffTitle": "Turn off the calendar feed?",
  "server.routineFeed.turnOffDescription":
    "The current URL stops working. If you turn the feed on again, it gets a new URL.",
  "server.routineFeed.agentsLoadFailed": "Could not load the agents.",
  "server.settings.nameTooShort": "Enter at least {limit} characters.",
  "server.settings.nameTooLong": "Use no more than {limit} characters.",
  "server.settings.actionFailedTitle": "Server action failed",
  "server.settings.actionFailed": "The server action failed.",
  "server.settings.imageReadFailed": "Tommy could not read this image.",
  "server.settings.copyFailedTitle": "Copy failed",
  "server.settings.copyFailed": "Tommy could not copy this value.",
  "server.settings.unavailableTitle": "Server settings unavailable",
  "server.settings.unsavedMcpChanges": "Unsaved MCP changes",
  "server.settings.reset": "Reset",
  "server.settings.unsavedChanges": "Unsaved changes",
  "server.settings.changesNotSaved": "Changes not saved",
  "server.settings.sections": "Server settings sections",
  "server.settings.identity": "Identity",
  "server.settings.logo": "Server logo",
  "server.settings.name": "Server name",
  "server.settings.nameOwnerOnly": "Only the server owner can change this name.",
  "server.settings.nameDescription": "Shown in the top of the app.",
  "server.settings.namePlaceholder": "e.g. Design studio",
  "server.settings.logoDescription": "Shown in the top of the app.",
  "server.settings.logoOwnerOnly": "Only the server owner can change this logo.",
  "server.settings.editLogo": "Edit server logo",
  "server.settings.addLogo": "Add server logo",
  "server.settings.removeLogo": "Remove server logo",
  "server.settings.agents": "Agents",
  "server.settings.timezone": "Timezone",
  "server.settings.timezoneDescription":
    "New routines use this timezone when the message does not give the sender's timezone.",
  "server.settings.timezoneAutomatic": "Automatic ({zone})",
  "server.settings.timezoneLoadFailed": "Could not load the server timezone.",
  "server.settings.memoryLimit": "Memories per agent",
  "server.settings.memoryLimitDescription": "How many memories each agent on this server can keep.",
  "server.settings.memoryLimitLoadFailed": "Could not load the memory limit of this server.",
  "server.settings.memoryReview": "Memory review",
  "server.settings.memoryReviewDescription":
    "How often agents on this server save lasting facts from their chats in the background.",
  "server.settings.memoryReviewOff": "Off",
  "server.settings.memoryReviewTurns": { one: "Every {count} turn", other: "Every {count} turns" },
  "server.settings.memoryReviewLoadFailed": "Could not load the memory review setting.",
  // A name for a server that the user publishes before naming it. {name} is the first word of the account name.
  "server.settings.hostKeyTitle": "Server key",
  "server.settings.hostKeyRotate": "Change the server key",
  "server.settings.hostKeyDescription":
    "Make a new identity key for this server. Paired computers and phones, and webhook routes, stay connected.",
  "server.settings.hostKeyRotateAction": "Change key",
  "server.settings.hostKeyConfirmTitle": "Change the server key?",
  "server.settings.hostKeyConfirmDescription":
    "The current key and the new key both sign a handover. Apps of members change to the new key when they connect again. Do this if the key file was copied or exposed.",
  "server.settings.hostKeyRotated": "Server key changed",
  "server.settings.hostKeyChanged": "Last change",
  // {date} is the date and time of the change.
  "server.settings.hostKeyChangedDescription": "{date}. The previous key and the new key both signed this change.",
  // The empty pending list. {word} is the one handwritten word of the title.
  "server.settings.providersTitle": "Providers",
  "server.settings.providersDescription": "Manage the AI providers of the computer that runs this server.",
  "server.settings.providersSwitchNote": "Switch to {name} to manage its AI providers.",
  "server.settings.providersSwitch": "Switch to this server",
  // Server Settings > Updates: the Tommy update of a joined server's host. {name} is the server.
  // {progress} is a percent, such as 42%.
  // Before the host knows the size, or while it waits to start the download.
  // The update dialog: the download, the restart and the server back online.
  "server.update.dialog.offerTitle": "Update {name} to Tommy {version}",
  "server.update.dialog.progressTitle": "Updating {name}",
  // The notice of an update whose dialog the user hid.
  // The work that a restart waits for, in "Waiting for {reasons}".
  // A notice to every member when a joined server restarts into an update. {name} is the server.
});
