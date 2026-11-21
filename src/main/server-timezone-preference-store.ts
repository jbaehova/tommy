import type { HostTimezoneSettings } from "@tommy/contracts/ipc";
import { isDynamicRecord, isString } from "@tommy/contracts/runtime-values";

import { Effect, Result } from "effect";
import { localTimezone } from "../backend/agent/routine-tools";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile } from "./preference-file";
import { validTimezone } from "./valid-timezone";

/**
 * The server timezone. A routine that an agent creates with no zone from the tool call or the
 * sender's message runs on it, so a server on a UTC computer can keep its members' clock across a
 * restart. `null` is automatic: the system zone of this computer, which every such routine used
 * before the setting existed.
 *
 * A file that is missing, unreadable as JSON, or names a zone this runtime cannot resolve reads as
 * automatic.
 */
export class ServerTimezonePreferenceStore {
  readonly #path: string;
  #timezone: string | null = null;

  constructor(path: string) {
    this.#path = path;
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      const loaded = yield* Effect.result(
        readPreferenceFile(this.#path, (parsed): string | null =>
          isDynamicRecord(parsed) && parsed.version === 1 && isString(parsed.timezone) && validTimezone(parsed.timezone)
            ? parsed.timezone
            : null,
        ),
      );
      if (Result.isSuccess(loaded)) this.#timezone = loaded.success;
      else if (!isMissingFileError(loaded.failure.cause) && !(loaded.failure.cause instanceof SyntaxError))
        return yield* loaded.failure;
    });
  }

  get(): HostTimezoneSettings {
    return { timezone: this.#timezone, systemTimezone: localTimezone() };
  }

  /** The zone that applies now: the chosen one, or the system zone. */
  effective(): string {
    return this.#timezone ?? localTimezone();
  }
}
