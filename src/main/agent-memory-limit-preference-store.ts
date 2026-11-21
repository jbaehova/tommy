import { type AgentMemoryLimitPreference, DEFAULT_AGENT_MEMORY_LIMIT, isAgentMemoryLimit } from "@tommy/contracts/ipc";
import { isDynamicRecord } from "@tommy/contracts/runtime-values";
import { Effect, Result } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile } from "./preference-file";

/**
 * How many memories one agent can hold. The backend reads it each time a memory is added, so it is
 * held in memory after `load` rather than read from disk each time.
 *
 * A file that is missing, unreadable as JSON or names a value that is not a choice reads as the
 * default.
 */
export class AgentMemoryLimitPreferenceStore {
  readonly #path: string;
  #preference: AgentMemoryLimitPreference = { limit: DEFAULT_AGENT_MEMORY_LIMIT };

  constructor(path: string) {
    this.#path = path;
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      const loaded = yield* Effect.result(
        readPreferenceFile(this.#path, (parsed): AgentMemoryLimitPreference | null =>
          isDynamicRecord(parsed) && parsed.version === 1 && isAgentMemoryLimit(parsed.limit)
            ? { limit: parsed.limit }
            : null,
        ),
      );
      if (Result.isSuccess(loaded)) {
        if (loaded.success) this.#preference = loaded.success;
      } else if (!isMissingFileError(loaded.failure.cause) && !(loaded.failure.cause instanceof SyntaxError))
        return yield* loaded.failure;
    });
  }

  get(): AgentMemoryLimitPreference {
    return { ...this.#preference };
  }
}
