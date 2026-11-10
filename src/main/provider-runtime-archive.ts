import { execFile } from "node:child_process";
import { readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { sourceText } from "@tommy/i18n/source";
import { Effect } from "effect";
import { childProcessEnvironment } from "../backend/child-process-environment";
import { ProviderRuntimeFailure, runtimeIO } from "./provider-runtime-effects";

const execFileAsync = promisify(execFile);

const MAX_ARCHIVE_LIST_BYTES = 16 * 1024 * 1024;
/** tar writes `./` before each name when the archive was made from `.`. */
function archiveEntryName(name: string): string {
  return name.replace(/^(?:\.\/)+/u, "");
}

/**
 * Whether a link in a runtime points inside the folder that holds it. Only a relative target with no
 * `..` is safe, so a chain of links cannot leave that folder either.
 */
export function isSafeLinkTarget(target: string): boolean {
  return (
    target !== "" &&
    !target.includes("\0") &&
    !target.includes("\\") &&
    !target.startsWith("/") &&
    !/^[A-Za-z]:/u.test(target) &&
    target.split("/").every((part) => part !== "..")
  );
}

/**
 * Refuses an archive with a path outside `allowedRoots`, or with an entry that is not a file or a
 * folder. With `links`, a symbolic link is allowed when `isSafeLinkTarget` accepts its target: a
 * macOS framework must keep its links, or its code signature breaks.
 */
export const assertSafeArchive = Effect.fn("ProviderArchive.assertSafeArchive")(function* (
  path: string,
  allowedRoots: readonly string[],
  message: string,
  options: { links?: boolean } = {},
): Effect.fn.Return<void, ProviderRuntimeFailure> {
  const [{ stdout: namesValue }, { stdout: detailsValue }] = yield* Effect.all(
    [
      runtimeIO((signal) =>
        execFileAsync("tar", ["-tzf", path], {
          encoding: "utf8",
          maxBuffer: MAX_ARCHIVE_LIST_BYTES,
          signal,
          env: childProcessEnvironment(),
        }),
      ),
      runtimeIO((signal) =>
        execFileAsync("tar", ["-tvzf", path], {
          encoding: "utf8",
          maxBuffer: MAX_ARCHIVE_LIST_BYTES,
          signal,
          env: childProcessEnvironment(),
        }),
      ),
    ],
    { concurrency: "unbounded" },
  );
  const names = namesValue.split(/\r?\n/u).filter(Boolean);
  const details = detailsValue.split(/\r?\n/u).filter(Boolean);
  // Both listings have one line per entry, in the same order, so a link line holds its own name.
  const unsafeEntry = (line: string, index: number) => {
    const type = line.trimStart().charAt(0);
    if (type === "-" || type === "d") return false;
    if (type !== "l" || !options.links || details.length !== names.length) return true;
    const marker = ` ${names[index]} -> `;
    const at = line.indexOf(marker);
    return at < 0 || !isSafeLinkTarget(line.slice(at + marker.length));
  };
  if (details.some(unsafeEntry)) {
    return yield* new ProviderRuntimeFailure({ cause: new Error(sourceText("error.provider.archiveSpecialFile")) });
  }
  for (const name of names) {
    if (name.includes("\0") || name.includes("\\"))
      return yield* new ProviderRuntimeFailure({ cause: new Error(sourceText("error.provider.archiveUnsafePath")) });
    const relative = archiveEntryName(name);
    if (!relative) continue;
    const normalized = relative.replace(/\/+$/u, "");
    const parts = normalized.split("/");
    if (
      !normalized ||
      normalized.startsWith("/") ||
      /^[A-Za-z]:/u.test(normalized) ||
      parts.some((part) => !part || part === "." || part === "..")
    ) {
      return yield* new ProviderRuntimeFailure({ cause: new Error(sourceText("error.provider.archiveUnsafePath")) });
    }
    if (!allowedRoots.includes(parts[0] ?? "")) return yield* new ProviderRuntimeFailure({ cause: new Error(message) });
  }
});
export const extractArchive = Effect.fn("ProviderArchive.extractArchive")(function* (
  archive: string,
  destination: string,
): Effect.fn.Return<void, ProviderRuntimeFailure> {
  yield* runtimeIO((signal) =>
    execFileAsync("tar", ["-xzf", archive, "-C", destination, "--no-same-owner"], {
      encoding: "utf8",
      maxBuffer: MAX_ARCHIVE_LIST_BYTES,
      signal,
      env: childProcessEnvironment(),
    }),
  );
});
/**
 * Refuses anything under `root` that is not a file or a folder. With `links`, a symbolic link is
 * allowed when `isSafeLinkTarget` accepts its target.
 */
export const rejectNonRegularFiles = Effect.fn("ProviderArchive.rejectNonRegularFiles")(function* (
  root: string,
  options: { links?: boolean } = {},
): Effect.fn.Return<void, ProviderRuntimeFailure> {
  const entries = yield* runtimeIO(() => readdir(root, { withFileTypes: true }));
  yield* Effect.forEach(
    entries,
    (entry) =>
      Effect.gen(function* () {
        const path = join(root, entry.name);
        const safeLink =
          entry.isSymbolicLink() && options.links && isSafeLinkTarget(yield* runtimeIO(() => readlink(path)));
        if (!safeLink && (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())))
          return yield* new ProviderRuntimeFailure({
            cause: new Error(sourceText("error.provider.runtimeSpecialFile")),
          });
        if (entry.isDirectory()) yield* rejectNonRegularFiles(path, options);
      }),
    { concurrency: "unbounded", discard: true },
  );
});
