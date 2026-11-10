import { createHash } from "node:crypto";
import { type FileHandle, lstat, mkdir, open, realpath, rm, stat, statfs } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createInflateRaw } from "node:zlib";
import { AGENT_IMPORT_LIMITS } from "@tommy/contracts/ipc";
import { sourceText } from "@tommy/i18n/source";
import { Effect, Schema } from "effect";
import { strFromU8, zipSync } from "fflate";
import { isPathInside } from "../backend/path-containment";
import { type ArchiveLimits, isUnsafeEntry } from "./agent-archive";
import { type ArchiveOperationError, archiveCall, archiveFailure, archiveResult, archiveSync } from "./archive-effects";
import { inspectArchive, SKILL_MAX_BYTES } from "./skill-package";

/** A file entry, as the central directory of the archive describes it. */
export interface StreamArchiveEntry {
  /** The name in the archive, with `/` between folders. */
  name: string;
  /** Expanded size. */
  size: number;
  compressedSize: number;
  /** 0 is stored and 8 is deflated; the reader refuses other methods. */
  method: number;
  crc: number;
  localHeaderOffset: number;
  /** A Unix or macOS zip tool saved the file with an execute bit. */
  executable: boolean;
  /** Compressed data must finish before the central directory starts. */
  dataEnd: number;
}

/**
 * A checked `.zip` on disk. Only its central directory is read into memory: each entry is inflated
 * when it is used, so the size of an archive is limited by the disk, not by memory.
 */
export interface StreamArchiveFile {
  path: string;
  entries: Map<string, StreamArchiveEntry>;
  /** SHA-256 of all compressed bytes, streamed with bounded memory. */
  fingerprint: string;
  /** Files in `.git` and `node_modules` folders, which are left out. */
  skipped: number;
  size: number;
}

const END = 0x06054b50;
const END_BYTES = 22;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_END = 0x06064b50;
const ZIP64_END_BYTES = 56;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_EXTRA = 0x0001;
/** The end record can follow a comment of up to 65,535 bytes. */
const TAIL_BYTES = ZIP64_LOCATOR_BYTES + END_BYTES + 0xffff;
const READ_CHUNK_BYTES = 1024 * 1024;
const SKIPPED_FOLDERS = new Set([".git", "node_modules"]);
/** A central directory is about 100 bytes for each entry; more than this is not an export. */
const MAX_DIRECTORY_BYTES = 256 * 1024 * 1024;

/** Reads and checks the central directory of the archive at `path`, without inflating anything. */
export const readStreamArchiveEffect = Effect.fn("Archive.readArchive")(function* (
  path: string,
  limits: ArchiveLimits,
): Effect.fn.Return<StreamArchiveFile, ArchiveOperationError> {
  const info = yield* archiveCall(() => stat(path));
  if (!info.isFile()) return yield* archiveFailure(new Error(sourceText("error.import.chooseZip")));
  if (info.size > limits.archiveBytes) return yield* archiveFailure(new Error(limits.tooLarge));
  // An unfinished archive has no central directory.
  if (info.size < END_BYTES) return yield* archiveFailure(new Error(limits.invalid));
  return yield* withStreamArchive(path, (handle) =>
    Effect.gen(function* () {
      const directory = yield* readDirectoryEffect(handle, info.size, limits);
      const { entries, skipped } = yield* Effect.try({
        try: () => directoryEntries(directory.bytes, limits, directory.offset),
        catch: (error) =>
          archiveFailure(
            error instanceof UnsafeEntry
              ? new Error(
                  error.entry ? sourceText("error.import.unsafeFile", { name: error.entry }) : limits.expandedTooLarge,
                )
              : error instanceof EmptyArchive
                ? new Error(sourceText("error.import.empty"))
                : new Error(limits.invalid),
          ),
      });
      const hash = createHash("sha256");
      yield* archiveCall(async () => {
        for await (const chunk of readRange(handle, 0, info.size)) hash.update(chunk);
      });
      return { path, entries, fingerprint: hash.digest("hex"), skipped, size: info.size };
    }),
  );
});

/**
 * Inflates the named entries into memory. Use it for small entries: a manifest, an avatar, a skill.
 * An entry larger than `maxBytes` is left out of the result, as a missing entry is.
 */
export const readStreamEntriesEffect = Effect.fn("Archive.readEntries")(function* (
  archive: StreamArchiveFile,
  names: Iterable<string>,
  maxBytes: number,
): Effect.fn.Return<Record<string, Uint8Array>, ArchiveOperationError> {
  const wanted = [...new Set(names)].flatMap((name) => {
    const entry = archive.entries.get(name);
    return entry && entry.size <= maxBytes ? [entry] : [];
  });
  if (wanted.reduce((total, entry) => total + entry.size, 0) > maxBytes)
    return yield* archiveFailure(new Error(sourceText("error.import.entryDamaged")));
  if (!wanted.length) return {};
  return yield* withStreamArchive(archive.path, (handle) =>
    Effect.gen(function* () {
      const files: Record<string, Uint8Array> = {};
      for (const entry of wanted) {
        const chunks: Buffer[] = [];
        const sink = new Writable({
          write(chunk: Buffer, _encoding, callback) {
            chunks.push(chunk);
            callback();
          },
        });
        yield* inflateEntryEffect(handle, entry, sink);
        Object.defineProperty(files, entry.name, { value: new Uint8Array(Buffer.concat(chunks)), enumerable: true });
      }
      return files;
    }),
  );
});

/** The most a manifest can be. A manifest with 100 agents and all their memories is a few MB. */
export const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Reads one skill folder into memory and checks it, before its agent exists. A folder larger than a
 * skill can be is refused before it is read.
 */
export const readStreamSkillEffect = Effect.fn("Archive.readSkill")(function* (
  archive: StreamArchiveFile,
  files: ReadonlyArray<readonly [string, StreamArchiveEntry]>,
): Effect.fn.Return<{ files: Array<readonly [string, Uint8Array]>; slug: string }, ArchiveOperationError> {
  if (files.reduce((total, [, entry]) => total + entry.size, 0) > SKILL_MAX_BYTES)
    return yield* archiveFailure(new Error(sourceText("error.skill.expandedTooLarge")));
  const data = yield* readStreamEntriesEffect(
    archive,
    files.map(([, entry]) => entry.name),
    SKILL_MAX_BYTES,
  );
  const read = files.map(([name, entry]) => [name, data[entry.name] ?? new Uint8Array()] as const);
  const slug = yield* archiveSync(() => inspectArchive(zipSync(Object.fromEntries(read))).slug);
  return { files: read, slug };
});

/** Opens the archive once for a group of reads, and closes it after them. */
export function withStreamArchive<A>(
  path: string,
  use: (handle: FileHandle) => Effect.Effect<A, ArchiveOperationError>,
): Effect.Effect<A, ArchiveOperationError> {
  return Effect.acquireUseRelease(
    archiveCall(() => open(path, "r")),
    use,
    (handle) => archiveCall(() => handle.close()).pipe(Effect.ignore),
  );
}

/**
 * Streams one entry into a new file at `target`. `wx` refuses to replace a file, so the `EEXIST`
 * failure leaves what is there. A file that this call made and could not finish is removed.
 */
export const extractStreamEntryEffect = Effect.fn("Archive.extractEntry")(function* (
  handle: FileHandle,
  entry: StreamArchiveEntry,
  target: string,
  mode = 0o666,
): Effect.fn.Return<void, ArchiveOperationError> {
  let complete = false;
  yield* Effect.acquireUseRelease(
    archiveCall(() => open(target, "wx", mode)),
    (output) =>
      Effect.gen(function* () {
        const sink = new Writable({
          write(chunk: Buffer, _encoding, done) {
            void output.writeFile(chunk).then(() => done(), done);
          },
        });
        yield* inflateEntryEffect(handle, entry, sink);
        complete = true;
      }),
    (output) =>
      archiveCall(async () => {
        try {
          await output.close();
        } finally {
          if (!complete) await rm(target, { force: true });
        }
      }).pipe(Effect.ignore),
  );
});

const readDirectoryEffect = Effect.fn("Archive.readDirectory")(function* (
  handle: FileHandle,
  size: number,
  limits: ArchiveLimits,
): Effect.fn.Return<{ bytes: Buffer; offset: number }, ArchiveOperationError> {
  const invalid = () => archiveFailure(new Error(limits.invalid));
  const tailStart = Math.max(0, size - TAIL_BYTES);
  const tail = yield* readAtEffect(handle, tailStart, size - tailStart, limits.invalid);
  let end = tail.length - END_BYTES;
  while (end >= 0 && (tail.readUInt32LE(end) !== END || end + END_BYTES + tail.readUInt16LE(end + 20) !== tail.length))
    end -= 1;
  if (end < 0 || tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0) return yield* invalid();
  let directoryBytes = tail.readUInt32LE(end + 12);
  let directoryOffset = tail.readUInt32LE(end + 16);
  // ZIP64 puts the real values in a second end record, which a locator before the first one names.
  // An archive over 4 GB, or with more than 65,535 entries, has one.
  const locator = end - ZIP64_LOCATOR_BYTES;
  if (locator >= 0 && tail.readUInt32LE(locator) === ZIP64_LOCATOR) {
    if (tail.readUInt32LE(locator + 4) !== 0 || tail.readUInt32LE(locator + 16) !== 1) return yield* invalid();
    const recordOffset = uint64(tail, locator + 8);
    if (recordOffset === null || recordOffset + ZIP64_END_BYTES > size) return yield* invalid();
    const record = yield* readAtEffect(handle, recordOffset, ZIP64_END_BYTES, limits.invalid);
    const wideBytes = uint64(record, 40);
    const wideOffset = uint64(record, 48);
    if (
      record.readUInt32LE(0) !== ZIP64_END ||
      record.readUInt32LE(16) !== 0 ||
      record.readUInt32LE(20) !== 0 ||
      wideBytes === null ||
      wideOffset === null
    )
      return yield* invalid();
    directoryBytes = wideBytes;
    directoryOffset = wideOffset;
  }
  if (
    directoryBytes > MAX_DIRECTORY_BYTES ||
    !Number.isSafeInteger(directoryOffset + directoryBytes) ||
    directoryOffset + directoryBytes > tailStart + end
  )
    return yield* invalid();
  const bytes = yield* readAtEffect(handle, directoryOffset, directoryBytes, limits.invalid);
  return { bytes, offset: directoryOffset };
});

/**
 * The checked file entries of a central directory. A folder entry holds no data and is left out.
 * A tool makes `.git` and `node_modules` again, so their files are counted and left out too. The
 * whole directory is read, not the count in the end record: some tools write only the low 16 bits
 * of a count over 65,535 and no ZIP64 record.
 */
function directoryEntries(
  directory: Buffer,
  limits: ArchiveLimits,
  dataEnd: number,
): { entries: Map<string, StreamArchiveEntry>; skipped: number } {
  const entries = new Map<string, StreamArchiveEntry>();
  let expanded = 0;
  let skipped = 0;
  let count = 0;
  let offset = 0;
  while (offset < directory.length) {
    if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== CENTRAL) throw new Error("Invalid.");
    const flags = directory.readUInt16LE(offset + 8);
    const nameBytes = directory.readUInt16LE(offset + 28);
    const extraBytes = directory.readUInt16LE(offset + 30);
    const commentBytes = directory.readUInt16LE(offset + 32);
    const next = offset + 46 + nameBytes + extraBytes + commentBytes;
    if (next > directory.length || directory.readUInt16LE(offset + 34) !== 0) throw new Error("Invalid.");
    // Bit 11 marks a UTF-8 name; other names are read as fflate reads them.
    const name = strFromU8(directory.subarray(offset + 46, offset + 46 + nameBytes), (flags & 0x800) === 0).replaceAll(
      "\\",
      "/",
    );
    const sizes = zip64Sizes(
      directory.subarray(offset + 46 + nameBytes, offset + 46 + nameBytes + extraBytes),
      directory.readUInt32LE(offset + 24),
      directory.readUInt32LE(offset + 20),
      directory.readUInt32LE(offset + 42),
    );
    // The high byte of "version made by" is the system: 3 is Unix and 19 is macOS.
    const system = directory.readUInt8(offset + 5);
    const mode = directory.readUInt32LE(offset + 38) >>> 16;
    const method = directory.readUInt16LE(offset + 10);
    const crc = directory.readUInt32LE(offset + 16);
    offset = next;
    const inner = name.endsWith("/") ? name.slice(0, -1) : name;
    const parts = inner.split("/");
    if (
      !inner ||
      inner.startsWith("/") ||
      inner.includes("\0") ||
      parts.some((part) => !part || part === "." || part === ".." || /^[a-z]:/iu.test(part))
    )
      throw new UnsafeEntry(name);
    if ((system === 3 || system === 19) && (mode & 0o170000) === 0o120000) throw new UnsafeEntry(name);
    if (name.endsWith("/")) continue;
    count += 1;
    if (count > limits.files || entries.has(name)) throw new UnsafeEntry(name);
    if (parts.some((part) => SKIPPED_FOLDERS.has(part))) {
      skipped += 1;
      continue;
    }
    if (isUnsafeEntry(name)) throw new UnsafeEntry(name);
    // Bit 0 marks an encrypted entry.
    if (
      (flags & (1 | 64)) !== 0 ||
      (method !== 0 && method !== 8) ||
      (method === 0 && sizes.size !== sizes.compressedSize)
    )
      throw new Error("Invalid.");
    expanded += sizes.size;
    if (!Number.isSafeInteger(expanded) || expanded > limits.archiveBytes) throw new UnsafeEntry(null);
    entries.set(name, {
      name,
      ...sizes,
      method,
      crc,
      executable: (system === 3 || system === 19) && (mode & 0o111) !== 0,
      dataEnd,
    });
  }
  if (!entries.size) throw new EmptyArchive();
  return { entries, skipped };
}

/** Each value that is `0xffffffff` in the directory comes, in this order, from the ZIP64 extra field. */
function zip64Sizes(
  extra: Buffer,
  size: number,
  compressedSize: number,
  localHeaderOffset: number,
): { size: number; compressedSize: number; localHeaderOffset: number } {
  const values = { size, compressedSize, localHeaderOffset };
  const fields = ["size", "compressedSize", "localHeaderOffset"] as const;
  const wide = fields.filter((key) => values[key] === 0xffffffff);
  if (!wide.length) return values;
  for (let offset = 0; offset + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(offset);
    const length = extra.readUInt16LE(offset + 2);
    if (id === ZIP64_EXTRA) {
      if (length < wide.length * 8 || offset + 4 + length > extra.length) break;
      for (const [index, key] of wide.entries()) {
        const value = uint64(extra, offset + 4 + index * 8);
        if (value === null) throw new Error("Invalid.");
        values[key] = value;
      }
      return values;
    }
    offset += 4 + length;
  }
  throw new Error("Invalid.");
}

function isZlibError(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("Z_");
}

function uint64(buffer: Buffer, offset: number): number | null {
  const value = buffer.readBigUInt64LE(offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

/** Inflates one entry into `sink`, and fails when it has another size or CRC than the directory says. */
const inflateEntryEffect = Effect.fn("Archive.inflateEntry")(function* (
  handle: FileHandle,
  entry: StreamArchiveEntry,
  sink: Writable,
): Effect.fn.Return<void, ArchiveOperationError> {
  const damaged = () => archiveFailure(new Error(sourceText("error.import.entryDamaged")));
  const header = yield* readAtEffect(handle, entry.localHeaderOffset, 30, sourceText("error.import.entryDamaged"));
  if (
    header.readUInt32LE(0) !== LOCAL ||
    header.readUInt16LE(8) !== entry.method ||
    (header.readUInt16LE(6) & (1 | 64)) !== 0
  )
    return yield* damaged();
  const start = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const info = yield* archiveCall(() => handle.stat());
  if (
    !Number.isSafeInteger(start + entry.compressedSize) ||
    start + entry.compressedSize > Math.min(info.size, entry.dataEnd)
  )
    return yield* damaged();
  const nameBytes = yield* readAtEffect(handle, entry.localHeaderOffset + 30, header.readUInt16LE(26));
  const name = strFromU8(nameBytes, (header.readUInt16LE(6) & 0x800) === 0).replaceAll("\\", "/");
  if (name !== entry.name) return yield* damaged();
  let crc = 0;
  let bytes = 0;
  const check = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      crc = crc32(chunk, crc);
      bytes += chunk.length;
      // An entry that expands past its stated size stops here, so it cannot fill the disk.
      callback(bytes > entry.size ? new Error(sourceText("error.import.entryDamaged")) : null, chunk);
    },
  });
  if (entry.compressedSize === 0) {
    yield* archiveCall(() => new Promise<void>((done) => sink.end(done)));
  } else {
    const input = Readable.from(readRange(handle, start, entry.compressedSize));
    yield* archiveCall(() =>
      (entry.method === 8 ? pipeline(input, createInflateRaw(), check, sink) : pipeline(input, check, sink)).catch(
        (error: unknown) => {
          // zlib names a damaged deflate stream with a `Z_` code and English text.
          throw isZlibError(error) ? new Error(sourceText("error.import.entryDamaged")) : error;
        },
      ),
    );
  }
  if (bytes !== entry.size || crc >>> 0 !== entry.crc) return yield* damaged();
});

/** Reads `length` bytes from `start` in chunks. A stream from the handle would add a listener to it for each entry. */
async function* readRange(handle: FileHandle, start: number, length: number): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < length; ) {
    const size = Math.min(READ_CHUNK_BYTES, length - offset);
    // Only the bytes read are used, so the buffer does not need to be zero-filled.
    const { bytesRead, buffer } = await handle.read(Buffer.allocUnsafe(size), 0, size, start + offset);
    if (bytesRead === 0) throw new Error(sourceText("error.import.entryDamaged"));
    offset += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

const readAtEffect = Effect.fn("Archive.readAt")(function* (
  handle: FileHandle,
  position: number,
  length: number,
  invalid = sourceText("error.import.zipInvalid"),
): Effect.fn.Return<Buffer, ArchiveOperationError> {
  const buffer = Buffer.alloc(length);
  for (let offset = 0; offset < length; ) {
    const { bytesRead } = yield* archiveCall(() => handle.read(buffer, offset, length - offset, position + offset));
    if (bytesRead === 0) return yield* archiveFailure(new Error(invalid));
    offset += bytesRead;
  }
  return buffer;
});

class EmptyArchive extends Schema.TaggedError<EmptyArchive>()("EmptyArchive", {}) {}

class UnsafeEntry extends Schema.TaggedError<UnsafeEntry>()("UnsafeEntry", {
  entry: Schema.NullOr(Schema.String),
  message: Schema.String,
}) {
  constructor(entry: string | null) {
    super({ entry, message: "Unsafe archive entry." });
  }
}

/**
 * Streams the workspace files of one agent from the archive and never replaces a file. When a file
 * is already there, for example `README.md` and `readme.md` on a disk that ignores case, the entry is
 * saved beside it as `README (2).md`. A file that still cannot be written is skipped. Each case adds
 * a warning. With `keepExecutable`, an entry saved with an execute bit gets the execute bits that the
 * umask allows, and never setuid or setgid.
 */
export const writeStreamImportedFilesEffect = Effect.fn("Archive.writeImportedFiles")(function* (
  root: string,
  archive: StreamArchiveFile,
  files: ReadonlyArray<readonly [string, StreamArchiveEntry]>,
  agentName: string,
  warnings: string[],
  keepExecutable = false,
): Effect.fn.Return<void, ArchiveOperationError> {
  yield* archiveCall(() => mkdir(root, { recursive: true }));
  const base = yield* archiveCall(() => realpath(root));
  yield* assertArchiveFreeSpaceEffect(
    base,
    files.reduce((total, [, entry]) => total + entry.size, 0),
  );
  for (const [name] of files) {
    const target = resolve(base, name);
    if (isAbsolute(name) || isUnsafeEntry(name) || target === base || !isPathInside(base, target))
      return yield* archiveFailure(new Error(sourceText("error.import.unsafeFile", { name })));
  }
  if (!files.length) return;
  yield* withStreamArchive(archive.path, (handle) =>
    Effect.gen(function* () {
      for (const [name, entry] of files) {
        const mode = keepExecutable && entry.executable ? 0o777 : 0o666;
        const target = resolve(base, name);
        try {
          archiveResult(
            yield* Effect.result(ensureArchiveDirectoryEffect(base, dirname(target)).pipe(Effect.uninterruptible)),
          );
          let saved = false;
          for (let copy = 1; copy <= 10_000; copy += 1) {
            try {
              archiveResult(
                yield* Effect.result(
                  extractStreamEntryEffect(handle, entry, copy === 1 ? target : copyName(target, copy), mode).pipe(
                    Effect.uninterruptible,
                  ),
                ),
              );
              if (copy > 1)
                warnings.push(
                  sourceText("error.import.fileRenamed", { name: agentName, file: name, saved: copyName(name, copy) }),
                );
              saved = true;
              break;
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
            }
          }
          if (!saved) throw new Error(sourceText("error.import.entryDamaged"));
        } catch (error) {
          warnings.push(
            sourceText("error.import.fileSkipped", { name: agentName, file: name, reason: errorText(error) }),
          );
        }
      }
    }),
  );
});

/** `notes/plan.md` becomes `notes/plan (2).md`. */
function copyName(path: string, copy: number): string {
  const extension = extname(path);
  return `${path.slice(0, path.length - extension.length)} (${copy})${extension}`;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : "The import failed.";
  return text.slice(0, AGENT_IMPORT_LIMITS.message);
}

/** Refuse extraction before disk space is used. A filesystem that cannot report space fails closed. */
export const assertArchiveFreeSpaceEffect = Effect.fn("Archive.assertFreeSpace")(function* (
  root: string,
  bytes: number,
) {
  const disk = yield* archiveCall(() => statfs(root, { bigint: true }));
  if (!Number.isSafeInteger(bytes) || bytes < 0 || disk.bavail * disk.bsize < BigInt(bytes))
    return yield* archiveFailure(new Error(sourceText("error.import.notEnoughSpace")));
});

/** Existing folders must remain real folders, so a symlink cannot redirect an archive write. */
export const ensureArchiveDirectoryEffect = Effect.fn("Archive.ensureDirectory")(function* (
  root: string,
  directory: string,
) {
  const base = yield* archiveCall(() => realpath(root));
  const target = resolve(directory);
  if (target !== base && !isPathInside(base, target))
    return yield* archiveFailure(new Error(sourceText("error.import.unsafeFile", { name: directory })));
  let current = base;
  for (const part of relative(base, target).split(/[\\/]/u).filter(Boolean)) {
    current = resolve(current, part);
    const path = current;
    yield* archiveCall(() => mkdir(path)).pipe(
      Effect.catch((error) => {
        const cause = error.cause;
        return cause instanceof Error && "code" in cause && cause.code === "EEXIST" ? Effect.void : Effect.fail(error);
      }),
    );
    const info = yield* archiveCall(() => lstat(path));
    if (!info.isDirectory() || info.isSymbolicLink())
      return yield* archiveFailure(new Error(sourceText("error.import.unsafeFile", { name: directory })));
  }
});
