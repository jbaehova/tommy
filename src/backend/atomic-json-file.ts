import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { sourceText } from "@tommy/i18n/source";
import { Effect, Schema } from "effect";

/** Every stored JSON file carries a schema version, so a later release can read an older one. */
export interface VersionedJsonFile {
  version: number;
}

export interface WriteJsonFileOptions {
  /** Creates the parent directory, readable only by the user, when it is missing. */
  createDirectory?: boolean;
}

/** Replaces `path` with `value` as one line of JSON, readable only by the user. */
export function writeJsonFileAtomically<Content extends VersionedJsonFile>(
  path: string,
  value: Content,
  options: WriteJsonFileOptions = {},
): Effect.Effect<void, AtomicFileWriteError> {
  return writeFileAtomically(path, `${JSON.stringify(value)}\n`, options);
}

/**
 * True when the file is empty, or has its size but none of its content. A power loss can leave a
 * file this way on NTFS, which records the size before the data. Nothing in such a file can be
 * recovered.
 */
export function isEmptyStoredFile(contents: string): boolean {
  return contents.replaceAll("\0", "").trim() === "";
}

/**
 * Parses the JSON text of the stored file at `path` and gives it to `decode`. A byte order mark that
 * an editor added is ignored. A parse error names the file and quotes nothing from it: the V8 message
 * quotes the text, and a stored file can hold tokens.
 */
export function parseStoredJson<Value>(path: string, contents: string, decode: (value: unknown) => Value): Value {
  let value: unknown;
  try {
    value = JSON.parse(contents.startsWith("\uFEFF") ? contents.slice(1) : contents);
  } catch {
    throw new Error(sourceText("error.storage.unreadableFile", { path }));
  }
  return decode(value);
}

/**
 * Moves a damaged file to `<path>.corrupt-<time>`, where it stays for diagnosis. A failed move is
 * ignored: the next write replaces the file, and the file holds nothing to keep.
 */
export const setAsideDamagedFile = Effect.fn("AtomicFile.setAsideDamaged")(function* (path: string) {
  yield* Effect.promise(() => rename(path, `${path}.corrupt-${Date.now()}`).catch(() => undefined));
});

/** The native cause stays at the adapter; callers must not export it without redaction. */
export class AtomicFileWriteError extends Schema.TaggedError<AtomicFileWriteError>()("AtomicFileWriteError", {
  operation: Schema.Literals(["directory", "write", "rename"]),
  cause: Schema.Defect(),
}) {}

/**
 * Replaces `path` with `content`, readable only by the user.
 *
 * The content goes to a temporary sibling first and is renamed over `path`, so a crash leaves the
 * previous file or the new one, never a truncated one. The content is flushed to the disk before the
 * rename, so a power loss cannot leave `path` filled with zeros. Each call has its own temporary name, so
 * overlapping writes never share a file, and a failed write removes its temporary file.
 *
 * The write and rename stay together even when the caller interrupts the operation.
 */
export const writeFileAtomically = Effect.fn("AtomicFile.write")(function* (
  path: string,
  content: string | Uint8Array,
  options: WriteJsonFileOptions = {},
) {
  if (options.createDirectory) {
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(path), { recursive: true, mode: 0o700 }),
      catch: (cause) => new AtomicFileWriteError({ operation: "directory", cause }),
    });
  }
  yield* Effect.acquireUseRelease(
    Effect.sync(() => `${path}.${randomUUID()}.tmp`),
    (temporaryPath) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: async () => {
            const handle = await open(temporaryPath, "w", 0o600);
            try {
              await handle.writeFile(content);
              await handle.sync();
            } catch (cause) {
              // A close failure must not replace the write failure.
              await handle.close().catch(() => undefined);
              throw cause;
            }
            await handle.close();
          },
          catch: (cause) => new AtomicFileWriteError({ operation: "write", cause }),
        });
        yield* Effect.tryPromise({
          try: () => rename(temporaryPath, path),
          catch: (cause) => new AtomicFileWriteError({ operation: "rename", cause }),
        });
      }),
    // Cleanup failure must not replace the write failure, as in the native adapter.
    (temporaryPath) => Effect.promise(() => rm(temporaryPath, { force: true }).catch(() => undefined)),
  );
}, Effect.uninterruptible);
