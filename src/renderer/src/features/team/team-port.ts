import type { TommyDesktopApi } from "@tommy/contracts/ipc";

/**
 * What team presence reaches in main: who is online, and whether this member is typing.
 */
export interface TeamPort {
  servers: Pick<TommyDesktopApi["servers"], "onPresence" | "setTyping">;
}

/** Read on each call: tests and stories replace `window.tommy` per case. */
export function teamPort(): TeamPort {
  return window.tommy;
}
