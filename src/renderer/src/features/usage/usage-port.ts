import type { TommyDesktopApi } from "@tommy/contracts/ipc";

/**
 * What the usage panel reaches in main: the analytics of a server, its agents, and the events that
 * make the report stale.
 */
export interface UsagePort {
  storage?: Pick<TommyDesktopApi["storage"], "getMachineMetrics">;
  hostAdmin?: Pick<TommyDesktopApi["hostAdmin"], "setMachineAlerts">;
  agent: Pick<TommyDesktopApi["agent"], "getHostAnalytics" | "listAgents" | "onScopedEvent">;
  servers: Pick<TommyDesktopApi["servers"], "onEvent">;
}

/** Read on each call: tests and stories replace `window.tommy` per case. */
export function usagePort(): UsagePort {
  return window.tommy;
}
