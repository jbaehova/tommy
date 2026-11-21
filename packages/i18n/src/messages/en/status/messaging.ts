import { defineMessages } from "../../../message";

export const messages = defineMessages("status.messaging", {
  "status.messaging.telegramManualCaptcha": "The site requires a CAPTCHA. You cannot complete this step in Telegram.",
  "status.messaging.telegramManualPasskey": "The site requires a passkey. You cannot complete this step in Telegram.",
  "status.messaging.telegramManualAccount": "You must choose an account on the site. You cannot select it in Telegram.",
  "status.messaging.telegramManualPayment":
    "The payment provider requires confirmation on its site. You cannot confirm it in Telegram.",
  "status.messaging.telegramManualStep":
    "This step needs direct interaction with the site. You cannot complete it in Telegram.",
  "status.messaging.telegramBlockedLogin":
    "The site could not complete sign-in on the server. You cannot complete this step in Telegram.",
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
  "status.messaging.telegramCreateHelp":
    "Tap Create agent, choose a name and confirm the Telegram username. You can also send /new followed by what the agent does. That role goes to the next agent you create within 10 minutes.",
  "status.messaging.telegramInitialRole":
    "You are ready to receive work from your owner on Telegram. Your role: {description}\n\nWait for their first task.",
  "status.messaging.telegramAskRole":
    "What does {name} do? Send the answer as your next message within 10 minutes. The role shows on the bot's profile. Send /skip to answer later in @{username}.",
  "status.messaging.telegramAskRoleText": "Send what {name} does as text, or send /skip.",
  "status.messaging.telegramRoleSkipped": "{name} has no role yet. Tell it what it does in @{username}.",
  "status.messaging.telegramRoleFailed":
    "Tommy could not save the role of {name}. Tell it what it does in @{username}.",
  "status.messaging.telegramRoleSaved": "{name} now knows its role. Its answer appears in @{username}.",
  "status.messaging.telegramRoleMessage": "Your owner set your role: {description}",
  "status.messaging.telegramCreate": "Create Telegram agent",
  "status.messaging.telegramActive": "Connected to Tommy",
  "status.messaging.telegramPending": "Waiting for verification",
  "status.messaging.telegramNoAgents": "You have no Telegram agents yet. Send /new to create one.",
  "status.messaging.telegramManagerHelp":
    "Send a message here to talk to your root agent. Use /connect to give your other agents their own chats, /new to create a new agent, and /agents to see your agent bots. Use /disconnect @username to unlink an agent bot, and /delete to delete an agent without a chat. Use /browser to see the browser and /stop to stop the current task. Messages between agents appear in each agent's chat. Open Tommy for private browser requests.",
  "status.messaging.telegramChooseRoot": "Choose your root agent. It answers in this chat and leads your other agents.",
  "status.messaging.telegramRootCurrent": "{name} is your root agent. Choose another agent only to replace it.",
  "status.messaging.telegramRootSelected": "{name} is now your root agent. Send it a message here.",
  "status.messaging.telegramConnectHelp":
    "Tap an agent, then create the new bot in Telegram. Keep the suggested name so that the bot connects to that agent. You can change the username.",
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
  "status.messaging.telegramCommandFailed": "Tommy could not do that. Try again.",
  "status.messaging.telegramAccessFull": "Full access",
  "status.messaging.telegramAccessWorkspace": "Workspace only",
  "status.messaging.telegramLabelEngine": "Engine",
  "status.messaging.telegramLabelEffort": "Reasoning",
  "status.messaging.telegramLabelAccess": "Access",
  "status.messaging.telegramLabelState": "Now",
  "status.messaging.telegramLabelQueue": "Waiting messages",
  "status.messaging.telegramStateWorking": "Working",
  "status.messaging.telegramStateIdle": "Idle",
  "status.messaging.telegramPendingRuntime": "Switches to {model} after the current task.",
  "status.messaging.telegramModelChoose": "Choose a model.",
  "status.messaging.telegramModelUnknown": "No model is called {name}. Send /model to see the list.",
  "status.messaging.telegramModelSet": "Model: {model}",
  "status.messaging.telegramEffortChoose": "Choose the reasoning level.",
  "status.messaging.telegramEffortUnsupported": "This model has no reasoning setting.",
  "status.messaging.telegramEffortUnknown": "Use one of these levels: {levels}",
  "status.messaging.telegramEffortSet": "Reasoning: {effort}",
  "status.messaging.telegramAccessChoose": "Choose what the agent may change.",
  "status.messaging.telegramAccessSet": "Access: {access}",
  "status.messaging.telegramInstructionsEmpty":
    "This agent has no instructions yet. Send /instructions set and the text.",
  "status.messaging.telegramInstructionsHelp":
    "Send /instructions set and the text to replace them, or /instructions add and a line to add it.",
  "status.messaging.telegramInstructionsSaved": "Saved the instructions. The agent uses them from its next task.",
  "status.messaging.telegramInstructionsFailed":
    "Tommy could not save the instructions. The file changed or is too large. Try again.",
  "status.messaging.telegramFoldersNone": "The agent can change only its workspace and the shared folder.",
  "status.messaging.telegramFoldersHelp": "Send /folders add or /folders remove and an absolute path on the server.",
  "status.messaging.telegramFoldersSaved": "Saved the folders.",
  "status.messaging.telegramFoldersInvalid":
    "Use an absolute path of an existing folder on the server, outside Tommy's data and the agent's workspace.",
  "status.messaging.telegramFoldersUnknown": "The agent has no such folder. Send /folders to see the list.",
  "status.messaging.telegramDeleteRoot": "The root agent cannot be deleted. Choose another root with /root first.",
  "status.messaging.telegramDeleteConfirm":
    "This deletes {name} with its conversation and workspace on the server. To confirm, send /delete {name}",
  "status.messaging.telegramDeleted": "Deleted {name}.",
  "status.messaging.telegramCommandDeleteAgent": "Delete an agent without a chat",
  "status.messaging.telegramDeleteUsage":
    "Send /delete followed by the name of the agent. Agents without a chat:\n{names}",
  "status.messaging.telegramDeleteNone": "Every agent has a chat. Send /delete in the agent's own chat to delete it.",
  "status.messaging.telegramDeleteUnknown": "No agent without a chat has this name. Send /delete to see the list.",
  "status.messaging.telegramDeleteAmbiguous": "More than one agent has this name. Delete it in Tommy.",
  "status.messaging.telegramDeleteHasChat": "{name} has its own chat. Send /delete in @{username}.",
  "status.messaging.telegramDeleteAsk":
    "This deletes {name}, its conversations and its workspace from the server. You cannot undo it. To confirm, send this within 5 minutes:\n\n/delete {name} {code}",
  "status.messaging.telegramCompacted": "Compacting the conversation context.",
  "status.messaging.telegramCompactRefused": "Tommy cannot compact now. Try again when the agent is idle.",
  "status.messaging.telegramQueueEmpty": "No messages are waiting.",
  "status.messaging.telegramCanceled": "Canceled waiting messages: {count}",
  "status.messaging.telegramUsageTitle": "Plan usage (used, resets):",
  "status.messaging.telegramUsageNone": "No usage data yet.",
  "status.messaging.telegramWorking": "Working…",
  "status.messaging.telegramWorkingFor": "Working… {minutes} min",
  "status.messaging.telegramMemoryNone": "This agent has no memories yet.",
  "status.messaging.telegramMemoryShared": "Shared by all agents:",
  "status.messaging.telegramRoutinesNone": "This agent has no routines.",
  "status.messaging.telegramRoutineOn": "on",
  "status.messaging.telegramRoutineOff": "off",
  "status.messaging.telegramRoutinesHelp": "Send /routines on, /routines off or /routines run and a routine name.",
  "status.messaging.telegramRoutineUnknown": "No routine is called {name}.",
  "status.messaging.telegramRoutineStarted": "Started {name}.",
  "status.messaging.telegramRoutineSaved": "Routine {name} is now {state}.",
  "status.messaging.telegramHistoryNone": "No messages yet.",
  "status.messaging.telegramHistoryYou": "You",
  "status.messaging.telegramCommandStatus": "Show the agent's settings and state",
  "status.messaging.telegramCommandModel": "Change the model",
  "status.messaging.telegramCommandEffort": "Change the reasoning level",
  "status.messaging.telegramCommandAccess": "Change what the agent may change",
  "status.messaging.telegramCommandInstructions": "Show or change the instructions",
  "status.messaging.telegramCommandFolders": "Show or change the extra folders",
  "status.messaging.telegramCommandCompact": "Compact the conversation context",
  "status.messaging.telegramCommandCancel": "Cancel waiting messages",
  "status.messaging.telegramCommandQueue": "Show waiting messages",
  "status.messaging.telegramCommandUsage": "Show plan usage",
  "status.messaging.telegramCommandMemory": "Show the agent's memories",
  "status.messaging.telegramCommandRoutines": "Show or change routines",
  "status.messaging.telegramCommandHistory": "Show recent messages",
  "status.messaging.telegramCommandDelete": "Delete this agent",
  "status.messaging.telegramPrivateInput":
    "{name} needs a private answer. Open Tommy to answer it. The answer does not go into this chat.",
  "status.messaging.telegramHandoffWork": "📥 Received a session from {source}. The agent continues the work.",
  "status.messaging.telegramAskNotice": "❓ {source} asked this agent a question. The answer also goes back there.",
  "status.messaging.telegramHandoffRecord":
    "📥 Received a session record from {source}. The agent keeps it and does not act.",
  "status.messaging.telegramStopped": "Stopped the current task.",
  "status.messaging.telegramLimit": "The engine plan reached its usage limit. Work continues at {time}.",
  "status.messaging.telegramLimitLater": "The engine plan reached its usage limit. Work continues when it resets.",
  "status.messaging.telegramNothingToStop": "Nothing is running.",
  "status.messaging.telegramNotTaken":
    "⚠️ The agent could not take your message. {reason} Tommy tries again by itself for a while, so you do not need to send it again.",
  "status.messaging.telegramSignInExpired":
    "⚠️ The engine sign-in of this agent expired, so it cannot work. Sign the engine in again on the Tommy server.",
  "status.messaging.telegramFileFailed": "Tommy could not read the file. Files up to 20 MB work.",
  "status.messaging.telegramT3LinkExpiring":
    "⏳ The link to T3 Code {name} ({origin}) ends on {date}. After that, agents cannot use T3 Code there. To keep it, run t3 pair on that computer, then run sudo tommy t3 link --name {name} {origin} on the Tommy server.",
  "status.messaging.telegramMcpConnect": "Connect",
  "status.messaging.telegramMcpRequested": "{name} needs a sign-in.",
  "status.messaging.telegramMcpConnected": "{name} is connected.",
  "status.messaging.telegramMcpDenied": "Sign-in to {name} was declined.",
  "status.messaging.telegramMcpExpired": "The sign-in request for {name} expired.",
  "status.messaging.telegramMcpFailed": "Tommy could not connect to {name}.",
  "status.messaging.remoteMcpCode":
    "🔐 {client} asks to read your Tommy data (memories, chats and knowledge folders, read-only). Sign-in code: {code}\nType it on the Tommy sign-in page within 10 minutes. If you did not start this sign-in, do not type the code anywhere.",
  "status.messaging.remoteMcpConnected":
    "✅ {client} can read your Tommy data now (read-only). To disconnect it, run sudo tommy connector revoke --all on the Tommy server.",
  "status.messaging.remoteMcpTitle": "Connect to Tommy",
  "status.messaging.remoteMcpBody":
    "Tommy sent a sign-in code to your Telegram manager chat. Type it here to give read-only access to your memories, chats and knowledge folders.",
  "status.messaging.remoteMcpClient": "Requested by",
  "status.messaging.remoteMcpCodeLabel": "Sign-in code",
  "status.messaging.remoteMcpAllow": "Allow access",
  "status.messaging.remoteMcpDeny": "Deny",
  "status.messaging.remoteMcpWrongCode": "The code is wrong. Tries left: {count}",
  "status.messaging.remoteMcpEndedTitle": "This sign-in ended",
  "status.messaging.remoteMcpEndedBody":
    "The request expired, was used, or got too many wrong codes. Start the connection again in your app.",
  "status.messaging.remoteMcpInvalidTitle": "Tommy cannot accept this sign-in",
  "status.messaging.remoteMcpInvalidBody": "The app sent a sign-in request that this server does not accept.",
  "status.messaging.remoteMcpBusyTitle": "Too many sign-in requests",
  "status.messaging.remoteMcpBusyBody": "Wait an hour, then start the connection again.",
  "status.messaging.remoteMcpUnavailableTitle": "Tommy cannot send a code",
  "status.messaging.remoteMcpUnavailableBody":
    "Telegram is not ready on this server, so Tommy cannot send the sign-in code. Try again later.",
});
