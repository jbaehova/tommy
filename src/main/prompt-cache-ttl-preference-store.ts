import {
  DEFAULT_PROMPT_CACHE_TTL,
  isPromptCacheTtl,
  type PromptCacheTtl,
  type PromptCacheTtlSetting,
} from "@tommy/contracts/ipc";
import { isDynamicRecord } from "@tommy/contracts/runtime-values";
import { Effect, Result } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile } from "./preference-file";

/**
 * How long this server asks the provider to keep the prompt cache of its agents. A Claude process
 * reads it when it starts, so a change applies to the next process, not to a running turn.
 *
 * A file that is missing, unreadable as JSON or names a value that is not a choice reads as the
 * default.
 */
export class PromptCacheTtlPreferenceStore {
  readonly #path: string;
  #ttl: PromptCacheTtl = DEFAULT_PROMPT_CACHE_TTL.ttl;

  constructor(path: string) {
    this.#path = path;
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      const loaded = yield* Effect.result(
        readPreferenceFile(this.#path, (parsed): PromptCacheTtl | null =>
          isDynamicRecord(parsed) && parsed.version === 1 && isPromptCacheTtl(parsed.ttl) ? parsed.ttl : null,
        ),
      );
      if (Result.isSuccess(loaded)) {
        if (loaded.success) this.#ttl = loaded.success;
      } else if (!isMissingFileError(loaded.failure.cause) && !(loaded.failure.cause instanceof SyntaxError))
        return yield* loaded.failure;
    });
  }

  get(): PromptCacheTtlSetting {
    return { ttl: this.#ttl };
  }
}
