import type { SaveStoredFileInput, TommyDesktopApi } from "@tommy/contracts/ipc";

/**
 * What the storage panels reach in main: the stored files of a server, and the agent names that
 * label them.
 */
export interface FilesPort {
  agent: Pick<TommyDesktopApi["agent"], "listAgents">;
  /**
   * The old provider CLI versions and the machine use are optional: a client with no store of its
   * own, such as the web client, has none.
   */
  storage: Pick<TommyDesktopApi["storage"], "clear" | "deleteFile" | "getUsage" | "openFile"> & {
    saveFile?: (input: SaveStoredFileInput, serverId: string) => Promise<boolean>;
  } & Partial<
      Pick<TommyDesktopApi["storage"], "getRemovableRuntimes" | "removeRemovableRuntimes" | "getMachineMetrics">
    >;
  /** The machine alert settings, beside `storage.getMachineMetrics`. */
  hostAdmin?: Pick<TommyDesktopApi["hostAdmin"], "getMachineAlerts" | "setMachineAlerts">;
}

/** Read on each call: tests and stories replace `window.tommy` per case. */
export function filesPort(): FilesPort {
  return window.tommy;
}
