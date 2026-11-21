import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import { redactText } from "@tommy/logging";
import { Deferred, Effect } from "effect";

const MAX_LOG_BYTES = 1024 * 1024;

/** The appends for each file run one at a time, so a rotation never races a write. */
const queues = new Map<string, Deferred.Deferred<void>>();

export const appendDiagnosticLog = Effect.fn("Host.appendDiagnosticLog")(function* (
  directory: string,
  name: string,
  message: string | Uint8Array,
) {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/gu, "-").slice(0, 80);
  const path = join(directory, `${safeName}.log`);
  const clean = Buffer.from(message).toString("utf8").split("\n").map(redactDiagnosticLine).join("\n");
  const previous = queues.get(path);
  const pending = Deferred.makeUnsafe<void>();
  queues.set(path, pending);
  yield* Effect.gen(function* () {
    if (previous) yield* Deferred.await(previous);
    if (clean) yield* writeDiagnosticEffect(directory, path, clean).pipe(Effect.ignore);
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        if (queues.get(path) === pending) queues.delete(path);
        yield* Deferred.succeed(pending, undefined);
      }),
    ),
  );
}, Effect.uninterruptible);

// Logs can contain a token separated from its value by a space.
function redactDiagnosticLine(line: string): string {
  return redactText(line).replace(/token[=: ]+[A-Za-z0-9._-]{8,}/giu, "[redacted]");
}

const writeDiagnosticEffect = Effect.fn("Host.writeDiagnostic")(function* (
  directory: string,
  path: string,
  clean: string,
) {
  yield* Effect.tryPromise(() => mkdir(directory, { recursive: true }));
  yield* Effect.gen(function* () {
    if ((yield* Effect.tryPromise(() => stat(path))).size >= MAX_LOG_BYTES)
      yield* Effect.tryPromise(() => rename(path, `${path}.1`));
  }).pipe(Effect.catch(() => Effect.void));
  yield* Effect.tryPromise(() => appendFile(path, clean, { encoding: "utf8", mode: 0o600 }));
});
