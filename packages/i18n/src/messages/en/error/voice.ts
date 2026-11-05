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
});
