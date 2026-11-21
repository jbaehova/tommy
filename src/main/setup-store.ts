import { type AppSetupState, isAgentModel, isAgentProvider } from "@tommy/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@tommy/contracts/runtime-values";
import { Effect } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile } from "./preference-file";

const EMPTY_SETUP: AppSetupState = { completed: false, preferredProvider: null, preferredModel: null };

export function readSetupState(path: string): Effect.Effect<AppSetupState, PreferenceFileFailure> {
  return readPreferenceFile(path, (parsed): AppSetupState => {
    if (
      !isDynamicRecord(parsed) ||
      !isNumber(parsed.version) ||
      parsed.version !== 2 ||
      !isAgentProvider(parsed.preferredProvider) ||
      !isString(parsed.completedAt)
    ) {
      return { ...EMPTY_SETUP };
    }
    return {
      completed: true,
      preferredProvider: parsed.preferredProvider,
      // A malformed model is dropped rather than failing the whole read: the provider is still a
      // usable answer, and the model falls back to that provider's default.
      preferredModel: isAgentModel(parsed.preferredModel) ? parsed.preferredModel : null,
    };
  }).pipe(
    Effect.catch((failure) => {
      const error = failure.cause;
      if (isMissingFileError(error) || error instanceof SyntaxError) return Effect.succeed({ ...EMPTY_SETUP });
      return Effect.fail(failure);
    }),
  );
}
