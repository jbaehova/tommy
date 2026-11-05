import type { ComponentProps } from "@solidjs/web";
import type { BrowserPreview } from "@tommy/contracts/ipc";
import SharedBrowserPreviewSidebar from "@tommy/ui/features/conversation/BrowserPreviewSidebar";
import { readPanelWidth, savePanelWidth } from "../../components/panel-width-storage";
import { conversationPort } from "./conversation-port";

const STORAGE_KEY = "tommy:browser-preview-panel-width";

export default function BrowserPreviewSidebar(
  props: Omit<
    ComponentProps<typeof SharedBrowserPreviewSidebar>,
    "capturePreview" | "readWidth" | "readCustomWidth" | "saveWidth" | "resetWidth"
  > & { capturePreview?: ((tabId: string) => Promise<BrowserPreview>) | null | undefined },
) {
  return (
    <SharedBrowserPreviewSidebar
      {...props}
      capturePreview={
        props.capturePreview === null
          ? undefined
          : (props.capturePreview ?? ((id) => conversationPort().browser.capturePreview(id)))
      }
      readWidth={(fallback, min, max) => readPanelWidth(STORAGE_KEY, fallback, min, max)}
      readCustomWidth={() => Number.parseFloat(window.localStorage.getItem(STORAGE_KEY) ?? "")}
      saveWidth={(width) => savePanelWidth(STORAGE_KEY, width)}
      resetWidth={() => window.localStorage.removeItem(STORAGE_KEY)}
    />
  );
}
