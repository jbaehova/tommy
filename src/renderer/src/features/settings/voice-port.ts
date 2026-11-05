import type { TommyDesktopApi } from "@tommy/contracts/ipc";

/** What the Voice tab reaches in main: the dictation models and the dictation settings. */
export interface VoicePort {
  voice: TommyDesktopApi["voice"];
}

/** Read on each call: tests and stories replace `window.tommy` per case. */
export function voicePort(): VoicePort {
  return window.tommy;
}
