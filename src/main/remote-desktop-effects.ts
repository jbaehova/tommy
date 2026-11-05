import { Effect, Schema } from "effect";

/** Preserves remote desktop failures at the existing Promise interfaces. */
export class RemoteDesktopOperationError extends Schema.TaggedError<RemoteDesktopOperationError>()(
  "RemoteDesktopOperationError",
  {
    cause: Schema.Defect(),
  },
) {}

function desktopFailure(cause: unknown): RemoteDesktopOperationError {
  return cause instanceof RemoteDesktopOperationError ? cause : new RemoteDesktopOperationError({ cause });
}
export function desktopCall<A>(operation: () => A | Promise<A>): Effect.Effect<A, RemoteDesktopOperationError> {
  return Effect.tryPromise({ try: () => Promise.resolve(operation()), catch: desktopFailure });
}
