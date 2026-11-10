// Drives the real archive reader and filesystem on a temporary profile. No user data is opened.
// Run: bun scripts/file-archive-e2e.ts
// Writes .tommy-build/file-archive-e2e/report.json.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { crc32 } from "node:zlib";
import { zipSync } from "fflate";
import { runCauseEffect } from "../src/backend/effect-boundary";
import type { ArchiveLimits } from "../src/main/agent-archive";
import {
  assertArchiveFreeSpaceEffect,
  readStreamArchiveEffect,
  readStreamEntriesEffect,
  writeStreamImportedFilesEffect,
} from "../src/main/agent-archive-reader";

const out = resolve(".tommy-build/file-archive-e2e");
const root = await mkdtemp(join(tmpdir(), "tommy-file-archive-"));
const report: { passed: boolean; checks: string[]; failure?: string } = { passed: false, checks: [] };
const limits: ArchiveLimits = {
  archiveBytes: 16 * 1024 * 1024,
  files: 100,
  tooLarge: "Packed size limit.",
  expandedTooLarge: "Expanded size limit.",
  invalid: "Invalid ZIP.",
};

/** ZIP64 with one stored file. Its 64-bit sizes and offsets fit in a small fixture. */
function zip64(name: string, bytes: Uint8Array): Buffer {
  const fileName = Buffer.from(name);
  const crc = crc32(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(45, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(bytes.byteLength, 18);
  local.writeUInt32LE(bytes.byteLength, 22);
  local.writeUInt16LE(fileName.length, 26);
  const payload = Buffer.concat([local, fileName, bytes]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(0x32d, 4);
  central.writeUInt16LE(45, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(0xffffffff, 20);
  central.writeUInt32LE(0xffffffff, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt16LE(28, 30);
  central.writeUInt32LE(0xffffffff, 42);
  const extra = Buffer.alloc(28);
  extra.writeUInt16LE(1);
  extra.writeUInt16LE(24, 2);
  extra.writeBigUInt64LE(BigInt(bytes.byteLength), 4);
  extra.writeBigUInt64LE(BigInt(bytes.byteLength), 12);
  extra.writeBigUInt64LE(0n, 20);
  const directory = Buffer.concat([central, fileName, extra]);
  const end64 = Buffer.alloc(56);
  end64.writeUInt32LE(0x06064b50);
  end64.writeBigUInt64LE(44n, 4);
  end64.writeUInt16LE(45, 12);
  end64.writeUInt16LE(45, 14);
  end64.writeBigUInt64LE(1n, 24);
  end64.writeBigUInt64LE(1n, 32);
  end64.writeBigUInt64LE(BigInt(directory.length), 40);
  end64.writeBigUInt64LE(BigInt(payload.length), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50);
  locator.writeBigUInt64LE(BigInt(payload.length + directory.length), 8);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([payload, directory, end64, locator, end]);
}

try {
  const archivePath = join(root, "source.zip");
  const content = Buffer.alloc(4 * 1024 * 1024, 0x61);
  const packed = zipSync({ "workspace/large.txt": content, "workspace/empty.txt": new Uint8Array() });
  await writeFile(archivePath, packed);
  const archive = await runCauseEffect(readStreamArchiveEffect(archivePath, limits));
  assert.equal(archive.entries.size, 2);
  assert.equal(archive.fingerprint, createHash("sha256").update(packed).digest("hex"));
  const destination = join(root, "workspace");
  await mkdir(destination);
  await writeFile(join(destination, "large.txt"), "keep");
  const warnings: string[] = [];
  await runCauseEffect(
    writeStreamImportedFilesEffect(
      destination,
      archive,
      [...archive.entries].map(([name, entry]) => [name.slice("workspace/".length), entry] as const),
      "Example",
      warnings,
      true,
    ),
  );
  assert.equal(await readFile(join(destination, "large.txt"), "utf8"), "keep");
  assert.deepEqual(await readFile(join(destination, "large (2).txt")), content);
  assert.equal((await stat(join(destination, "empty.txt"))).size, 0);
  assert.equal(warnings.length, 1);
  report.checks.push("Deflated and empty entries stream to disk; a collision preserves existing data.");

  const widePath = join(root, "wide.zip");
  await writeFile(widePath, zip64("notes/한국어.txt", Buffer.from("ZIP64")));
  const wide = await runCauseEffect(readStreamArchiveEffect(widePath, limits));
  const read = await runCauseEffect(readStreamEntriesEffect(wide, wide.entries.keys(), 100));
  assert.equal(Buffer.from(read["notes/한국어.txt"] ?? []).toString(), "ZIP64");
  report.checks.push("ZIP64 entry size, compressed size, offset and UTF-8 name decode correctly.");

  const bounded = await runCauseEffect(readStreamEntriesEffect(archive, archive.entries.keys(), 2));
  assert.equal(Object.hasOwn(bounded, "workspace/large.txt"), false);
  await assert.rejects(() => runCauseEffect(readStreamArchiveEffect(archivePath, { ...limits, archiveBytes: 1024 })));
  await assert.rejects(() =>
    runCauseEffect(readStreamArchiveEffect(archivePath, { ...limits, archiveBytes: 1024 * 1024 })),
  );
  await assert.rejects(() => runCauseEffect(assertArchiveFreeSpaceEffect(root, Number.MAX_SAFE_INTEGER)));
  report.checks.push("Packed, expanded, small-entry memory and free-space bounds refuse oversized work.");

  const outside = join(root, "outside");
  await mkdir(outside);
  const linkedRoot = join(root, "linked");
  await mkdir(linkedRoot);
  await symlink(outside, join(linkedRoot, "redirect"), "dir");
  const wideEntry = wide.entries.get("notes/한국어.txt");
  assert.ok(wideEntry);
  const unsafeWarnings: string[] = [];
  await runCauseEffect(
    writeStreamImportedFilesEffect(linkedRoot, wide, [["redirect/escape.txt", wideEntry]], "Example", unsafeWarnings),
  );
  assert.equal(unsafeWarnings.length, 1);
  await assert.rejects(() => stat(join(outside, "escape.txt")));
  await assert.rejects(() =>
    runCauseEffect(writeStreamImportedFilesEffect(linkedRoot, wide, [["../escape.txt", wideEntry]], "Example", [])),
  );
  report.checks.push("Traversal and existing directory symlinks cannot redirect an archive write.");

  const damaged = zip64("damaged.txt", Buffer.from("checksum"));
  damaged[30 + Buffer.byteLength("damaged.txt")] = 0;
  const damagedPath = join(root, "damaged.zip");
  await writeFile(damagedPath, damaged);
  const damagedArchive = await runCauseEffect(readStreamArchiveEffect(damagedPath, limits));
  const damagedRoot = join(root, "damaged");
  const damagedWarnings: string[] = [];
  await runCauseEffect(
    writeStreamImportedFilesEffect(
      damagedRoot,
      damagedArchive,
      [...damagedArchive.entries],
      "Example",
      damagedWarnings,
    ),
  );
  assert.equal(damagedWarnings.length, 1);
  await assert.rejects(() => stat(join(damagedRoot, "damaged.txt")));
  report.checks.push("CRC failure removes the partial output and reports the damaged item.");
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await rm(root, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
}
