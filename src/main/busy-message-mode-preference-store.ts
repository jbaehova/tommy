import { type BusyMessageModePreference, DEFAULT_BUSY_MESSAGE_MODE, isBusyMessageMode } from "@tommy/contracts/ipc";
import { isDynamicRecord } from "@tommy/contracts/runtime-values";
import { Effect, Result } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile } from "./preference-file";

/**
 * The app default for a message sent to a busy agent. The backend reads it for each such message,
 * so it is held in memory after `load` rather than read from disk each time.
 *
 * A file that is missing, unreadable as JSON or names an unknown mode reads as
 * `DEFAULT_BUSY_MESSAGE_MODE`. A saved `queue` stays `queue`.
 */
export class BusyMessageModePreferenceStore {
  readonly #path: string;
  #preference: BusyMessageModePreference = { mode: DEFAULT_BUSY_MESSAGE_MODE };

  constructor(path: string) {
    this.#path = path;
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      const loaded = yield* Effect.result(
        readPreferenceFile(this.#path, (parsed): BusyMessageModePreference | null =>
          isDynamicRecord(parsed) && parsed.version === 1 && isBusyMessageMode(parsed.mode)
            ? { mode: parsed.mode }
            : null,
        ),
      );
      if (Result.isSuccess(loaded)) {
        if (loaded.success) this.#preference = loaded.success;
      } else if (!isMissingFileError(loaded.failure.cause) && !(loaded.failure.cause instanceof SyntaxError))
        return yield* loaded.failure;
    });
  }

  get(): BusyMessageModePreference {
    return { ...this.#preference };
  }
}
