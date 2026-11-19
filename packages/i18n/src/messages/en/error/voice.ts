import { defineMessages } from "../../../message";

export const messages = defineMessages("error.voice", {
  "error.voice.live.disconnected": "Live voice disconnected.",
  "error.voice.live.signIn": "Sign in to Codex with your ChatGPT account to use live voice.",
  "error.voice.live.timedOut": "Codex live voice did not start in time. Try again.",
  "error.voice.live.cannotStart":
    "Live voice could not start. Check the Codex sign-in and update Codex, then try again.",
  "error.voice.live.busy": "This agent is busy. Wait for its work or voice call to end, then try again.",
  "error.voice.live.codexOnly": "Live voice needs an agent that uses Codex.",
});
