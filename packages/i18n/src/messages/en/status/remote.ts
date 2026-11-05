import { defineMessages } from "../../../message";

export const messages = defineMessages("status.remote", {
  // Status lines of remote desktop setup and remote connection recovery.
  "status.remote.stagePreferences": "Loading local chat preferences: {reason}",
  "status.remote.stageConnection": "Connecting to the desktop: {reason}",
  "status.remote.stageCompatibility": "Checking desktop compatibility: {reason}",
  "status.remote.stageAgents": "Loading agents: {reason}",
  "status.remote.stageReads": "Loading read status: {reason}",
  "status.remote.suspendedDetail": "Update Tommy Mobile or the desktop app before connecting.\n{detail}",
  "status.remote.cooldownDetail":
    "Connection failed after {limit} attempts. Retrying in {minutes}:{seconds}.\n{detail}",
  "status.remote.cooldown": "Connection failed after {limit} attempts. Retrying in {minutes}:{seconds}.",
  "status.remote.connectionLostDetail": {
    one: "Connection lost. Retrying in {count}s.\n{detail}",
    other: "Connection lost. Retrying in {count}s.\n{detail}",
  },
  "status.remote.connectionLost": {
    one: "Connection lost. Retrying in {count}s.",
    other: "Connection lost. Retrying in {count}s.",
  },
  "status.remote.attemptFailedDetail": {
    one: "Connection attempt failed. Retrying in {count}s.\n{detail}",
    other: "Connection attempt failed. Retrying in {count}s.\n{detail}",
  },
  "status.remote.attemptFailed": {
    one: "Connection attempt failed. Retrying in {count}s.",
    other: "Connection attempt failed. Retrying in {count}s.",
  },
  "status.remote.reconnectingDetail": {
    one: "Reconnecting {attempt}/{count}\n{detail}",
    other: "Reconnecting {attempt}/{count}\n{detail}",
  },
  "status.remote.reconnecting": { one: "Reconnecting {attempt}/{count}", other: "Reconnecting {attempt}/{count}" },
});
