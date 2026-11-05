/// <reference types="vite/client" />

import type { TommyDesktopApi } from "@tommy/contracts/ipc";

declare global {
  interface HighlightRegistry {
    set(name: string, highlight: Highlight): this;
    delete(name: string): boolean;
  }

  interface Window {
    tommy: TommyDesktopApi;
  }
}
