import { defineMessages } from "../../../message";

export const messages = defineMessages("error.host", {
  // Errors from host setup, publishing, and host maintenance.
  "error.host.webRtcNotConfigured": "The server service is not configured.",
  "error.host.nameBeforePublish": "Name this Tommy before publishing it.",
  "error.host.publishFailed": "This Tommy could not be published.",
  "error.host.noServer": "This computer has no server to change.",
  "error.host.identityLocalOnly": "The server name and logo can only be changed on the computer that runs it.",
  "error.host.timezoneInvalid": "This timezone is not known.",
});
