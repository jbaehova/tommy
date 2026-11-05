import { defineMessages } from "../../../message";

/** Errors that the workflow store and runtime send. */
export const messages = defineMessages("error.workflow", {
  "error.workflow.missing": "This workflow no longer exists.",
  "error.workflow.versionMissing": "This version of the workflow no longer exists.",
  "error.workflow.annotation": "Text, notes and shapes cannot have connections.",
  "error.workflow.port": "A step cannot take this type of input.",
  "error.workflow.branch": "Only a condition can have yes and no connections.",
  "error.workflow.conditionBranch": "Each connection from a condition must be yes or no.",
  "error.workflow.duplicateEdge": "These two steps already have this connection.",
  "error.workflow.serverTooOld": "This server does not support workflows. Update Tommy on the computer that runs it.",
  "error.workflow.nodeUnsupported": "This version of Tommy cannot run image, file and message steps yet.",
  "error.workflow.interrupted": "Tommy stopped while this step ran. Run it again.",
  "error.workflow.agentMissing": "Choose an agent for this step.",
  "error.workflow.handoffFailed": "Tommy could not send this step to its agent.",
  "error.workflow.agentStepEnded": "The agent's message for this step was removed before it answered.",
  "error.workflow.conditionUnclear": "The model did not answer yes or no.",
  "error.workflow.modelFailed": "The model could not answer. Run the step again.",
  "error.workflow.modelBusy": "Another model request is running. Run the step again soon.",
  "error.workflow.stepMissing": "This step no longer exists.",
  "error.workflow.nodeMissing": "This step is not in the workflow.",
  "error.workflow.runMissing": "This run no longer exists.",
  "error.workflow.notRetryable": "Only a step that failed or stopped can run again.",
  "error.workflow.noDecision": "This step does not wait for a decision.",
  "error.workflow.outputPlaceMissing": "Choose a messaging place for this output.",
  "error.workflow.discordNoMessage":
    "This output acts on the Discord message that started the run. Start the run from a Discord mention, or choose Post in channel.",
  "error.workflow.outputConnectionOff":
    "The messaging connection of this output is off or removed. Choose a place again.",
  "error.workflow.outputNotRunning": "The messaging connection does not run now. Try again when it runs.",
  "error.workflow.outputRefused": "The place refused the post. Make sure that Tommy can post there.",
  "error.workflow.outputUncertain":
    "The post stopped on its way. Part of it can be in the place. Look there before you try again.",
  "error.workflow.tooLarge": "This workflow is too large to save. Remove some drawings or long texts, then try again.",
  "error.workflow.tooLargeToSend":
    "This workflow is too large to send to another computer. Open it on the computer that runs the server.",
  "error.workflow.webhookMissing": "This step is not a webhook trigger. Save the workflow, then try again.",
  "error.workflow.githubActionMissing": "Choose what this output does on GitHub.",
  "error.workflow.githubRepositoryMissing": "Choose a repository for this output.",
  "error.workflow.githubItemMissing":
    "This output has no issue or pull request. Start the run from a GitHub event, or put the number in its input.",
  "error.workflow.githubPullRequestOnly": "This action works only on pull requests.",
  "error.workflow.githubTextMissing": "This output has no text to send. Connect a step that writes it.",
  "error.workflow.githubEventText":
    "This output cannot send the raw event of the trigger. Put an agent between the trigger and this output.",
  "error.workflow.githubChoiceMissing": "Choose the labels or the person for this output.",
  "error.workflow.githubChoseNothing": "The model chose no label or person of this repository.",
  "error.workflow.githubNotConnected": "Connect GitHub on the computer that runs this workflow.",
  "error.workflow.githubUncertain":
    "The change stopped on its way. It can be on GitHub. Look there before you run the step again.",
  "error.workflow.githubNoEvent": "GitHub has no issue or pull request that this trigger starts on.",
});
