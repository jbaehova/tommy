import { defineMessages } from "../../../message";

export const messages = defineMessages("error.voice", {
  // Voice transcription errors.
  "error.voice.transcriptionFailed": "Tommy could not transcribe this recording.",
  "error.voice.cloud.keyRequired": "Add your OpenAI API key in Settings → Voice.",
  "error.voice.cloud.keyRejected": "OpenAI did not accept the API key. Check the key in Settings → Voice.",
  "error.voice.cloud.quotaExceeded": "Your OpenAI quota is used up.",
  "error.voice.cloud.rateLimited": "OpenAI is busy. Try again in a moment.",
  "error.voice.cloud.streamEnded": "The dictation stream ended. Record again.",
  // The user's own voice server.
  "error.voice.live.unavailable": "This host does not support live voice. Update the host to use it.",
  "error.voice.live.disconnected": "Live voice disconnected.",
  "error.voice.live.signIn": "Sign in to Codex with your ChatGPT account to use live voice.",
  "error.voice.live.timedOut": "Codex live voice did not start in time. Try again.",
  "error.voice.live.cannotStart":
    "Live voice could not start. Check the Codex sign-in and update Codex, then try again.",
  "error.voice.live.busy": "This agent is busy. Wait for its work or voice call to end, then try again.",
  "error.voice.live.codexOnly": "Live voice needs an agent that uses Codex.",
});
