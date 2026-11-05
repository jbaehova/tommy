import { defineMessages } from "../../message";

export const messages = defineMessages("update", {
  // The app update button in Settings, one label for each updater phase.

  // The provider CLI update notification.
  "update.provider.update": "Update",
  "update.provider.upToDate": "{name} is up to date",
  "update.provider.checking": "Checking for {name} updates",
  "update.provider.available": "{name} update available",
  "update.provider.updating": "Updating {name}",
  "update.provider.waiting": "Waiting to update {name}",
  "update.provider.failed": "{name} update failed",
  "update.provider.settingUp": "Setting up",
  "update.provider.failedRetry": "The update failed. Try again.",
  "update.provider.unknownVersion": "unknown version",
  "update.provider.remoteHost": "Provider CLI updates run on the computer that hosts them.",
  "update.provider.unavailable": "Provider updates are unavailable.",
  "update.provider.downloadsUnavailable": "Provider downloads are unavailable.",
  "update.provider.startFailed": "The update could not start. Try again.",
  "update.provider.showDetails": "Show details",
  "update.provider.hideDetails": "Hide details",

  // An update that an admin of this server asked for. {name} is the admin.
  // The same notice when "Install updates automatically" scheduled the restart.

  // A restart that the user of this computer asked for. It waits until no work runs.

  // The "What's new" dialog after an app update.
});
