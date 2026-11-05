import { defineMessages } from "../../../message";

export const messages = defineMessages("error.update", {
  // Updater state the user reads.
  "error.update.unsupported": "Updates are available in installed desktop builds.",
  "error.update.managedByHost":
    "Updates on this Mac are installed by the host. The update stays ready until the host's maintenance runs.",
  // A joined server's admin reads these from the host.
  "error.update.remoteDisabled": "Updates from server admins are turned off on this computer.",
  "error.update.restartStarted": "Tommy is already restarting to install the update.",
});
