import type { ChildProcess } from "node:child_process";
import { Effect, Schema } from "effect";

class ProcessTreeFailed extends Schema.TaggedError<ProcessTreeFailed>()("ProcessTreeFailed", {
  cause: Schema.Defect(),
}) {}

/**
 * Ends a provider process and waits for it to exit. It sends SIGTERM, and SIGKILL when the process is still running after 2 seconds.
 */
export const endProcessTree = Effect.fn("ProcessTree.end")(function* (child: ChildProcess) {
  // A signal exit leaves `exitCode` null, and a failed spawn has no `pid` and may never emit `exit`.
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  yield* Effect.callback<void>((resume) => {
    const forceKill = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2_000);
    const exited = () => {
      clearTimeout(forceKill);
      resume(Effect.void);
    };
    child.once("exit", exited);
    child.kill("SIGTERM");
    return Effect.sync(() => {
      clearTimeout(forceKill);
      child.off("exit", exited);
    });
  });
});

/** Sends SIGTERM to a process and does not wait for it. */
export const stopProcessTree = Effect.fn("ProcessTree.stop")(function* (child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  yield* Effect.try({ try: () => child.kill("SIGTERM"), catch: (cause) => new ProcessTreeFailed({ cause }) });
});
