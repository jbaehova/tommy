import { matchingSourceKeys } from "@tommy/i18n/source";
import { Schema } from "effect";

/** The safe error boundary shared by local and Team API event management. */
export class HostEventsFailure extends Schema.TaggedError<HostEventsFailure>()("HostEventsFailure", {
  cause: Schema.Defect(),
}) {}

/**
 * Returns the catalog text that the user can act on, or `null` for an internal failure. The wrapped
 * cause can contain private backend details.
 */
export function hostEventsFailureMessage(failure: HostEventsFailure): string | null {
  const cause = failure.cause;
  return cause instanceof Error && matchingSourceKeys(cause.message).length > 0 ? cause.message : null;
}
