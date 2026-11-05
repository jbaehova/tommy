import type { TommyDesktopApi } from "@tommy/contracts/ipc";

/**
 * What the account context reaches in main: the pairing with the server, and the usage the page
 * rail and the Usage page show.
 */
export interface AccountPort {
  agent: Pick<TommyDesktopApi["agent"], "getUsage">;
  auth: Pick<TommyDesktopApi["auth"], "getState" | "logout" | "onEvent" | "pairDevice" | "retry">;
}

/** Read on each call: tests and stories replace `window.tommy` per case. */
export function accountPort(): AccountPort {
  return window.tommy;
}
