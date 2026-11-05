import type { TommyDesktopApi } from "@tommy/contracts/ipc";

/**
 * What turn state reaches in main: the queue, the routine ids, and the answers to prompts,
 * approvals and browser takeovers.
 */
export interface TurnsPort {
  agent: Pick<
    TommyDesktopApi["agent"],
    | "cancelQueuedMessage"
    | "cancelWait"
    | "clearContext"
    | "compactContext"
    | "compactTaskContext"
    | "interrupt"
    | "listQueue"
    | "listRoutines"
    | "listWaits"
    | "reorderQueue"
    | "respondToApproval"
    | "respondToBrowserTakeover"
    | "respondToPrompt"
    | "steerQueuedMessage"
    | "updateQueuedMessage"
  >;
}

/** Read on each call: tests and stories replace `window.tommy` per case. */
export function turnsPort(): TurnsPort {
  return window.tommy;
}
