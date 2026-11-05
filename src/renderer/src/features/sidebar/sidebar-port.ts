import type { TommyDesktopApi } from "@tommy/contracts/ipc";

/**
 * What the sidebar reaches in main: the saved sidebar layout and its changes, the pins that the host
 * keeps for all devices of the user, the free space on the disk of a server for the storage card, and
 * its machine use and alert levels for the machine card.
 */
export interface SidebarPort {
  agent: Pick<
    TommyDesktopApi["agent"],
    "getSidebarLayout" | "mutateSidebarLayout" | "getSidebarPins" | "setSidebarPins" | "seedSidebarPins"
  >;
  storage: Pick<TommyDesktopApi["storage"], "getDisk" | "getMachineMetrics">;
  hostAdmin: Pick<TommyDesktopApi["hostAdmin"], "getMachineAlerts">;
}

/** Read on each call: tests and stories replace `window.tommy` per case. */
export function sidebarPort(): SidebarPort {
  return window.tommy;
}
