import type { DraftAttachment } from "@tommy/contracts/ipc";
import { Button, ImageRemoveButton, Spinner } from "@tommy/ui";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../text";
import { fileBadge } from "./AttachmentCards";
import { attachmentReferenceTone } from "./AttachmentReference";
import { ImageLightbox, type ImageLightboxOpening, isLightboxImage } from "./ImageLightbox";

/** A pasted image that is still importing, with its local preview. */
export interface ComposerPendingImage {
  id: string;
  name: string;
  url: string;
}

/** The files of a message box that its text does not name, and the pasted images that still import. */
export function ComposerAttachmentRow(props: {
  attachments: readonly DraftAttachment[];
  pending?: readonly ComposerPendingImage[] | undefined;
  removeDisabled?: boolean | undefined;
  onRemove: (attachment: DraftAttachment) => void;
  /** Leave room for the macOS window controls above the image viewer. */
  macWindowControls?: boolean | undefined;
}) {
  const { t, format } = useText();
  const [lightbox, setLightbox] = createSignal<ImageLightboxOpening | null>(null);
  let row: HTMLDivElement | undefined;
  const thumbnail = (attachment: DraftAttachment) =>
    row?.querySelector<HTMLElement>(`[data-attachment-id="${CSS.escape(attachment.id)}"]`) ?? undefined;
  const openImage = (attachment: DraftAttachment, origin: HTMLElement) => {
    const images = props.attachments.filter(opensInViewer);
    setLightbox({ images, index: images.findIndex((image) => image.id === attachment.id), origin });
  };
  return (
    <Show when={props.attachments.length > 0 || (props.pending?.length ?? 0) > 0}>
      <div ref={(element) => (row = element)} class="composer-attachments">
        <For each={props.attachments}>
          {(attachment) => {
            // An image with no preview (the web client) shows as a file, with its name.
            const chip = () => (attachment.kind === "image" && attachment.previewUrl ? "image" : "file");
            return (
              <div class="composer-attachment ui-removable-image" data-kind={chip()}>
                <Show
                  when={opensInViewer(attachment)}
                  fallback={
                    <span
                      class="composer-attachment-preview"
                      data-file-tone={chip() === "file" ? attachmentReferenceTone(attachment.name) : undefined}
                    >
                      <Show when={chip() === "image"} fallback={fileBadge(attachment)}>
                        <img src={attachment.previewUrl ?? ""} alt="" />
                      </Show>
                    </span>
                  }
                >
                  <Button
                    variant="ghost"
                    type="button"
                    class="composer-attachment-preview"
                    data-attachment-id={attachment.id}
                    aria-label={t("chat.image.preview", { name: attachment.name })}
                    data-cuelume-tap="open"
                    onClick={(event) => openImage(attachment, event.currentTarget)}
                  >
                    <img src={attachment.previewUrl ?? ""} alt="" />
                  </Button>
                </Show>
                <Show when={chip() === "file"}>
                  <span class="composer-attachment-copy">
                    <strong title={attachment.name}>{attachment.name}</strong>
                    <small>{format.fileSize(attachment.size)}</small>
                  </span>
                </Show>
                <ImageRemoveButton
                  label={t("composer.attachment.remove", { name: attachment.name })}
                  disabled={props.removeDisabled === true}
                  onClick={() => props.onRemove(attachment)}
                />
              </div>
            );
          }}
        </For>
        <For each={props.pending ?? []}>
          {(image) => (
            <div class="composer-attachment" data-kind="image" data-pending="">
              <span class="composer-attachment-preview">
                <img src={image.url} alt="" />
              </span>
              <Spinner size="sm" label={t("composer.attachment.adding", { name: image.name })} />
            </div>
          )}
        </For>
        <Show when={lightbox()}>
          {(opening) => (
            <ImageLightbox
              opening={opening()}
              thumbnail={thumbnail}
              macWindowControls={props.macWindowControls}
              onClose={() => setLightbox(null)}
            />
          )}
        </Show>
      </div>
    </Show>
  );
}

/** An SVG can have a preview, but it remains a file chip. */
function opensInViewer(attachment: DraftAttachment): boolean {
  return attachment.kind === "image" && isLightboxImage(attachment);
}
