import {
  type AttachmentSupport,
  attachmentFileExtension,
  attachmentMimeTypeForName,
  isSupportedAttachmentName,
  isSupportedAttachmentNameFor,
} from "@tommy/contracts/attachment-files";
import { INPUT_LIMITS } from "@tommy/contracts/input-limits";
import { MOBILE_ATTACHMENT_BYTES, type RemoteFileUpload } from "@tommy/team-client/remote-peer";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { useMemo, useRef, useState } from "react";
import { showFailureAlert } from "@/features/analytics/failure-reports";
import { haptics } from "@/shared/lib/haptics";
import { readFileBase64 } from "@/shared/lib/read-file-base64";
import { useText } from "@/shared/lib/text";
import { type ImageDimensions, imageDimensions } from "../model/image-dimensions";

/**
 * Where the plus is drawn, from the screen's left and bottom edges. Measuring
 * it is not an option: `measureInWindow` reads the layout tree, and both the
 * plus and the composer around it carry Reanimated transforms that never reach
 * it. The composer computes this from the same numbers it draws with.
 */
export interface ChatAttachmentAnchor {
  left: number;
  bottom: number;
  size: number;
}

export interface ChatAttachment extends RemoteFileUpload {
  id: string;
  size: number;
  uri?: string;
  /** Read from the image header when the file is chosen, so every view reserves its shape. */
  dimensions?: ImageDimensions;
}

/** Longer pasted or shared text goes in as a text file, not into the composer. */
const LARGE_TEXT_LENGTH = 4_000;

function base64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function useChatAttachments(
  initialItems: ChatAttachment[] = [],
  persist?: (items: ChatAttachment[]) => Promise<void>,
  /** What the receiving host accepts. Read on each selection, because it loads with the connection. */
  support?: () => AttachmentSupport,
) {
  const { t, errorMessage } = useText();
  const limitMessage = () => t("mobile.chat.attachment.limit", { limit: INPUT_LIMITS.attachments });
  // The plus's rect while the attachment card is open, and null while it is
  // not: one value, so the card can never be open without an anchor to grow
  // out of and collapse back into.
  const [menuAnchor, setMenuAnchor] = useState<ChatAttachmentAnchor | null>(null);
  const [items, setItems] = useState<ChatAttachment[]>(initialItems);
  const itemsRef = useRef<ChatAttachment[]>(initialItems);
  // Selection reads files one by one while persistence runs per file. A plain
  // flag cleared by an inner persist would report idle during the next read,
  // so count nested preparation instead.
  const preparingCount = useRef(0);
  const [preparing, setPreparing] = useState(false);
  function beginPreparing() {
    preparingCount.current += 1;
    if (preparingCount.current === 1) setPreparing(true);
  }
  function endPreparing() {
    preparingCount.current = Math.max(0, preparingCount.current - 1);
    if (preparingCount.current === 0) setPreparing(false);
  }
  const sequence = useRef(initialItems.reduce((max, item) => Math.max(max, Number(item.id.split("-").at(-1)) || 0), 0));
  function replace(next: ChatAttachment[]) {
    itemsRef.current = next;
    setItems(next);
  }
  async function persistItems(next: ChatAttachment[]) {
    if (persist) {
      beginPreparing();
      try {
        await persist(next);
      } finally {
        endPreparing();
      }
    }
    replace(next);
  }
  // The same checks as desktop, named per file: one selection can hold several, and the user
  // needs to know which one to fix.
  function assertSupported(name: string) {
    if (!isSupportedAttachmentName(name)) throw new Error(t("mobile.chat.attachment.unsupported", { name }));
    if (support && !isSupportedAttachmentNameFor(name, support())) {
      const type = attachmentFileExtension(name)?.toUpperCase();
      throw new Error(
        type
          ? t("mobile.chat.attachment.hostRejectsType", { name, type })
          : t("mobile.chat.attachment.hostRejects", { name }),
      );
    }
  }
  function prepare(input: RemoteFileUpload & { uri?: string }): ChatAttachment {
    assertSupported(input.name);
    if (!input.name.trim() || input.name.length > INPUT_LIMITS.attachmentName)
      throw new Error(t("mobile.chat.attachment.nameTooLong"));
    if (input.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(input.base64))
      throw new Error(t("mobile.chat.attachment.damaged"));
    const size =
      Math.floor((input.base64.length * 3) / 4) -
      (input.base64.endsWith("==") ? 2 : input.base64.endsWith("=") ? 1 : 0);
    if (size > MOBILE_ATTACHMENT_BYTES) throw new Error(t("mobile.chat.attachment.tooLarge", { name: input.name }));
    const dimensions = input.mimeType.startsWith("image/") ? imageDimensions(input.base64) : null;
    return {
      ...input,
      size,
      id: `mobile-draft-attachment-${++sequence.current}`,
      ...(dimensions ? { dimensions } : {}),
    };
  }
  function add(input: RemoteFileUpload & { uri?: string }) {
    if (itemsRef.current.length >= INPUT_LIMITS.attachments) throw new Error(limitMessage());
    const item = prepare(input);
    const saved = persistItems([...itemsRef.current, item]);
    return saved;
  }
  async function readFile(uri: string, name: string): Promise<RemoteFileUpload & { uri: string }> {
    const file = new File(uri);
    const safeName = name.replace(/[/\\]/gu, "_");
    // Check before reading: a rejected file should not be copied into memory first.
    if (file.size > MOBILE_ATTACHMENT_BYTES) throw new Error(t("mobile.chat.attachment.tooLarge", { name: safeName }));
    assertSupported(safeName);
    return { name: safeName, mimeType: attachmentMimeTypeForName(safeName), base64: await readFileBase64(file), uri };
  }
  async function addFile(uri: string, name: string) {
    if (itemsRef.current.length >= INPUT_LIMITS.attachments) throw new Error(limitMessage());
    await add(await readFile(uri, name));
  }
  function photoName(asset: ImagePicker.ImagePickerAsset) {
    const extension = attachmentFileExtension(asset.uri.split(/[?#]/u)[0] ?? "");
    const video = asset.type === "video";
    return asset.fileName && isSupportedAttachmentName(asset.fileName)
      ? asset.fileName
      : `${video ? "video" : "photo"}.${extension ?? (video ? "mov" : "jpg")}`;
  }
  /** Swap one file in place. The rest keep their order, and a cancelled picker changes nothing. */
  async function replaceItem(id: string) {
    const current = itemsRef.current.find((item) => item.id === id);
    if (!current) return;
    let picked: { uri: string; name: string } | null = null;
    // The photo library has no SVG files, so an SVG is replaced from the files.
    if (current.mimeType.startsWith("image/") && current.mimeType !== "image/svg+xml") {
      const accepted = support?.();
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: !accepted || accepted.media || accepted.mp4 ? ["images", "videos"] : ["images"],
        quality: 1,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      });
      const asset = result.canceled ? undefined : result.assets[0];
      if (asset) picked = { uri: asset.uri, name: photoName(asset) };
    } else {
      const result = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
      const asset = result.canceled ? undefined : result.assets[0];
      if (asset) picked = { uri: asset.uri, name: asset.name };
    }
    if (!picked) {
      return;
    }
    const item = prepare(await readFile(picked.uri, picked.name));
    // The list can change while the picker is open; replace the file where it is now.
    const next = itemsRef.current.map((candidate) => (candidate.id === id ? item : candidate));
    if (!next.includes(item)) return;
    await persistItems(next);
  }
  async function chooseFiles() {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (!result.canceled) for (const asset of result.assets) await addFile(asset.uri, asset.name);
  }
  // Answers whether the card may become the camera. It reports its own refusal
  // rather than throwing: the card stays open on a refusal, so there is nothing
  // for the caller's error path to unwind.
  async function requestCamera(): Promise<boolean> {
    try {
      if (itemsRef.current.length >= INPUT_LIMITS.attachments) throw new Error(limitMessage());
      if (!(await ImagePicker.requestCameraPermissionsAsync()).granted)
        throw new Error(t("mobile.chat.attachment.cameraPermission"));
    } catch (error) {
      void haptics.notification("error");
      showFailureAlert(error, t("mobile.chat.attachment.addFailed"), errorMessage(error, t("mobile.chat.tryAgain")));
      return false;
    }
    return true;
  }
  async function choosePhotos() {
    if (itemsRef.current.length >= INPUT_LIMITS.attachments) throw new Error(limitMessage());
    const accepted = support?.();
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: !accepted || accepted.media || accepted.mp4 ? ["images", "videos"] : ["images"],
      allowsMultipleSelection: true,
      quality: 1,
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      selectionLimit: INPUT_LIMITS.attachments - itemsRef.current.length,
    });
    if (!result.canceled) for (const asset of result.assets) await addFile(asset.uri, photoName(asset));
  }
  function pasteText(text: string, onText: (text: string) => void) {
    if (text.length > LARGE_TEXT_LENGTH)
      return add({
        name: "pasted-text.txt",
        mimeType: "text/plain",
        base64: base64(new TextEncoder().encode(text)),
      });
    onText(text);
  }
  function reportFailures(failures: unknown[]) {
    void haptics.notification("error");
    showFailureAlert(
      failures[0],
      t("mobile.chat.attachment.addFailed"),
      // Each file over the limit gives the same message, so it shows once.
      [...new Set(failures.map((error) => errorMessage(error, t("mobile.chat.tryAgain"))))].join("\n"),
    );
  }
  /**
   * Adds what another app shared. Long text becomes a file, as a paste does. Each file is read on its
   * own, so a refused file does not stop the others, and one alert names each refused file.
   */
  async function addShared(
    text: string,
    files: readonly { uri: string; name: string }[],
    onText: (text: string) => void,
  ) {
    const large = text.length > LARGE_TEXT_LENGTH;
    if (text && !large) onText(text);
    if (!large && files.length === 0) return;
    const failures: unknown[] = [];
    beginPreparing();
    try {
      if (large) {
        try {
          await add({
            name: "shared-text.txt",
            mimeType: "text/plain",
            base64: base64(new TextEncoder().encode(text)),
          });
        } catch (error) {
          failures.push(error);
        }
      }
      for (const file of files) {
        try {
          if (itemsRef.current.length >= INPUT_LIMITS.attachments) throw new Error(limitMessage());
          // The caller deletes the copy after this read, so the item keeps the bytes, not the address.
          const { name, mimeType, base64 } = await readFile(file.uri, file.name);
          await add({ name, mimeType, base64 });
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      endPreparing();
    }
    if (failures.length > 0) reportFailures(failures);
  }
  const busyRef = useRef(false);
  function report(operation: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    beginPreparing();
    return operation()
      .catch((error) => reportFailures([error]))
      .finally(() => {
        busyRef.current = false;
        endPreparing();
      });
  }
  const actions = {
    openMenu: (anchor: ChatAttachmentAnchor) => setMenuAnchor(anchor),
    closeMenu: () => setMenuAnchor(null),
    // Held after the card has left, so the file read, the base64 encode and
    // the composer's re-render do not land on the frames of its exit. It
    // reports its own failure, because by then there is no card to show one in.
    addPhoto: (uri: string) => report(() => addFile(uri, "photo.jpg")),
    choosePhotos: () => report(choosePhotos),
    requestCamera,
    chooseFiles: () => report(chooseFiles),
    replace: (id: string) => report(() => replaceItem(id)),
    pasteText,
    addShared,
    remove: (id: string) => {
      void report(() => persistItems(itemsRef.current.filter((item) => item.id !== id)));
    },
    clear: () => replace([]),
    /** Puts back the files of a message that the person takes back to edit, after any files chosen since. */
    restore: (files: readonly ChatAttachment[]) =>
      replace([
        ...itemsRef.current,
        ...files.map((file) => ({ ...file, id: `mobile-draft-attachment-${++sequence.current}` })),
      ]),
  };
  const latestActions = useRef(actions);
  latestActions.current = actions;
  const [stableActions] = useState(() => ({
    openMenu: (anchor: ChatAttachmentAnchor) => latestActions.current.openMenu(anchor),
    closeMenu: () => latestActions.current.closeMenu(),
    addPhoto: (uri: string) => latestActions.current.addPhoto(uri),
    choosePhotos: () => latestActions.current.choosePhotos(),
    requestCamera: () => latestActions.current.requestCamera(),
    chooseFiles: () => latestActions.current.chooseFiles(),
    replace: (id: string) => latestActions.current.replace(id),
    pasteText: (text: string, onText: (text: string) => void) => latestActions.current.pasteText(text, onText),
    addShared: (text: string, files: readonly { uri: string; name: string }[], onText: (text: string) => void) =>
      latestActions.current.addShared(text, files, onText),
    remove: (id: string) => latestActions.current.remove(id),
    clear: () => latestActions.current.clear(),
    restore: (files: readonly ChatAttachment[]) => latestActions.current.restore(files),
  }));
  return useMemo(
    () => ({ items, preparing, menuAnchor, menuOpen: menuAnchor !== null, ...stableActions }),
    [items, preparing, menuAnchor, stableActions],
  );
}

export type ChatAttachments = ReturnType<typeof useChatAttachments>;
