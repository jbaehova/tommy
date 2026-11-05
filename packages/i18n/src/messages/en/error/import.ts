import { defineMessages } from "../../../message";

export const messages = defineMessages("error.import", {
  // Agent import errors and warnings.
  "error.import.memoryLimit": "{name}: only the first {limit} memories are imported.",
  "error.import.skillFolderMissing": "{name}: the skill folder {skill} has no SKILL.md.",
  "error.import.avatarSkipped": "{name}: the avatar is skipped because it is not a PNG, JPEG, or WebP under 512 KB.",
  "error.import.exportClosed": "The export is no longer open. Choose it again.",
  "error.import.agentNotInExport": "The selection names an agent that is not in the export.",
  "error.import.serverAgentLimit": "A server can have at most {limit} agents.",
  "error.import.exportChanged": "The export changed after it was checked. Choose it again.",
  "error.import.routineSkipped": '{name}: routine "{routine}" is skipped. {reason}',
  "error.import.fileRenamed": "{name}: {file} already exists, so this copy is saved as {saved}.",
  "error.import.fileSkipped": "{name}: the file {file} is skipped. {reason}",
  "error.import.chooseZip": "Choose a .zip file.",
  "error.import.unsafeFile": "The export contains an unsafe file: {name}",
  "error.import.empty": "The export is empty.",
  // Hermes Agent import from a folder on this computer.
  // Instance transfer between two Tommy computers.
  "error.import.transferRemoteTooLarge":
    "A transfer file for a joined server must be under 100 MB. Turn off workspace files, or export fewer agents.",
  "error.import.transferNotFile": "This file is not an Tommy transfer file.",
  "error.import.transferNewer": "A newer version of Tommy made this file. Update Tommy and try again.",
  "error.import.transferEmpty": "The file contains no agents and no settings.",
  "error.import.transferTooLarge":
    "A transfer file must be under 2 GB and 50,000 files. Turn off workspace files, or export fewer agents.",
  "error.import.transferAgentInvalid": "Agent {number} in the file is invalid, so it is skipped.",
  "error.import.transferSettingsInvalid": "The app settings in the file are invalid, so they are not imported.",
  "error.import.transferModelMissing":
    '{name}: the model "{model}" is not available here yet, so the agent uses the default model. Choose the model again when its provider is ready.',
  "error.import.transferSettingSkipped": "{name} is not imported. {reason}",
  "error.import.transferRoutineFlowSkipped": "The import left out a routine flow. {reason}",
  "error.import.transferCustomAgentCommand":
    '{name}: custom agents are not imported, because they run a command. Check the command "{command}" and add the agent again in Settings.',
  "error.import.transferSkillLimit":
    "{name}: only the first {limit} of its {total} skills are in the file, because an agent can have {limit} skills.",
  "error.import.transferFilesGone": "{number} files were deleted while the export ran, so they are not in the file.",
  "error.import.transferProviderKey": "{name}: enter its API key again in Settings.",
  "error.import.transferMcpValues":
    "{name}: the MCP server is added turned off. Check its command, enter its values and full address again, and turn it on in MCP settings.",
  "error.import.transferSharedKept":
    "{number} files in the Shared folder are already here, so they are kept as they are.",
});
