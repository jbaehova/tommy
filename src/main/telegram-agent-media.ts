import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { AttachmentSummary } from "@tommy/contracts/ipc";
import { Effect } from "effect";
import type { MailboxStore } from "../backend/mailbox-store";
import { remoteCall } from "./remote-service-effects";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PHOTO_BYTES = 10_000_000;

/** Send only the bytes of a generated PNG that the host committed to this agent and thread. */
export const readTelegramImage = Effect.fn("TelegramAgentHost.readImage")(function* (
  mailbox: Pick<MailboxStore, "resolveAttachment" | "generatedImageDigest">,
  agentId: string,
  threadId: string,
  attachment: AttachmentSummary,
) {
  if (
    attachment.mimeType !== "image/png" ||
    attachment.size < PNG_SIGNATURE.length ||
    attachment.size > MAX_PHOTO_BYTES
  )
    return null;
  const digest = mailbox.generatedImageDigest(attachment.id, agentId, threadId);
  if (!digest) return null;
  const file = yield* mailbox.resolveAttachment(attachment.id);
  if (file?.mimeType !== "image/png") return null;
  return yield* remoteCall(async () => {
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== attachment.size) return null;
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) return null;
        offset += bytesRead;
      }
      if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
      // resolveAttachment checked the on-disk file. Check the bytes that will actually leave the host too.
      return createHash("sha256").update(bytes).digest("hex") === digest ? bytes : null;
    } finally {
      await handle.close();
    }
  });
});

const MAX_FILE_BYTES = 49 * 1024 * 1024;

export interface TelegramFile {
  name: string;
  mimeType: string;
  bytes: Buffer;
}

/** A file that the agent attached to its answer, read as the host stored it. Null when it is gone or too large. */
export const readTelegramFile = Effect.fn("TelegramAgentHost.readFile")(function* (
  mailbox: Pick<MailboxStore, "resolveAttachment">,
  attachment: AttachmentSummary,
) {
  if (attachment.size > MAX_FILE_BYTES) return null;
  const file = yield* mailbox.resolveAttachment(attachment.id);
  if (!file) return null;
  return yield* remoteCall(async (): Promise<TelegramFile | null> => {
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) return null;
        offset += bytesRead;
      }
      return { name: attachment.name || file.name, mimeType: file.mimeType, bytes };
    } finally {
      await handle.close();
    }
  });
});
