import type { StoredFileRow } from "@tommy/contracts/ipc";
import type { RemoteFileUpload } from "@tommy/team-client/remote-peer";
import { type Directory, File } from "expo-file-system";

/** Writes one selected file at a time. Only this operation's partial file can be removed. */
export async function downloadLibraryFiles(
  directory: Directory,
  files: readonly StoredFileRow[],
  download: (fileId: string) => Promise<RemoteFileUpload>,
  active: () => boolean,
  completed: (fileId: string) => void,
) {
  const names = new Set(directory.list().map((file) => file.name));
  let failures = 0;
  for (const file of files) {
    if (!active()) break;
    let output: File | null = null;
    try {
      const data = await download(file.id);
      if (!active()) break;
      const safeName = file.name.replace(/[/\\\p{Cc}]/gu, "_").replace(/^\.+/u, "_") || "file";
      const dot = safeName.lastIndexOf(".");
      const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
      const extension = dot > 0 ? safeName.slice(dot) : "";
      let name = safeName;
      let suffix = 2;
      while (names.has(name)) name = `${stem} (${suffix++})${extension}`;
      names.add(name);
      if (directory.uri.startsWith("content://")) {
        // Android SAF creates a new document, and keeps an existing document on a name collision.
        output = directory.createFile(name, file.mimeType);
      } else {
        const candidate = new File(directory, name);
        candidate.create({ overwrite: false });
        output = candidate;
      }
      await output.write(data.base64, { encoding: "base64" });
      if (active()) completed(file.id);
      output = null;
    } catch {
      failures += 1;
    } finally {
      if (output?.exists) {
        try {
          output.delete();
        } catch {
          // Do not remove any other file if the document provider refuses cleanup.
        }
      }
    }
  }
  return failures;
}
