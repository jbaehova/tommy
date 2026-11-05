import { defineMessages } from "../../../message";

export const messages = defineMessages("error.connector", {
  // The built-in GitHub connection: the device flow, the token refresh and the stored file.
  "error.connector.linkExpired": "The Link connection expired. Connect Link again.",
  // The 1Password connection: the CLI that creates the service account, the token and the stored file.
});
