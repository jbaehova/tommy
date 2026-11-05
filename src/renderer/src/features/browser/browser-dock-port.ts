import type { TommyDesktopApi } from "@tommy/contracts/ipc";

/**
 * What the browser dock overlay reaches in main: the presentation, the actions, the frame, and the code
 * that the agent asks for. The overlay has no provider tree, so this is a module.
 */
export interface BrowserDockPort {
  agent: Pick<TommyDesktopApi["agent"], "respondToBrowserSecret">;
  browserDock: Pick<
    TommyDesktopApi["browserDock"],
    "getPresentation" | "onPresentation" | "performAction" | "setFrame"
  >;
}

/** Read on each call: tests and stories replace `window.tommy` per case. */
export function browserDockPort(): BrowserDockPort {
  return window.tommy;
}
