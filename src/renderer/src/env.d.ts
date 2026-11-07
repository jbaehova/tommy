/// <reference types="vite/client" />

import type { TommyDesktopApi } from "@tommy/contracts/ipc";

declare global {
  interface ImportMetaEnv {
    /** The server address that the pairing screen starts with. Set at build time. */
    readonly RENDERER_VITE_DEFAULT_SERVER_ADDRESS?: string;
  }

  interface HighlightRegistry {
    set(name: string, highlight: Highlight): this;
    delete(name: string): boolean;
  }

  interface Window {
    tommy: TommyDesktopApi;
  }
}
