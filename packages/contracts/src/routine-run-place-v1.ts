import {
  isRoutine,
  isRoutineFields,
  ROUTINE_RUN_PLACES,
  type Routine,
  type RoutineFields,
  type RoutineRunPlace,
} from "./ipc-routines";
import { isDynamicRecord, isOneOf } from "./runtime-values";

export { ROUTINE_RUN_PLACE_CAPABILITY } from "./team-protocol/routine-run-place-v1";

/** Additive host decoder. Released routine decoders keep their original behavior. */
export function isRoutineRunPlace(value: unknown): value is RoutineRunPlace {
  return isOneOf(ROUTINE_RUN_PLACES, value);
}

export function isRoutineFieldsWithRunPlace(value: unknown): value is RoutineFields {
  return (
    isDynamicRecord(value) && isRoutineFields(value) && (value.runIn === undefined || isRoutineRunPlace(value.runIn))
  );
}

export function isRoutineWithRunPlace(value: unknown): value is Routine {
  return isRoutine(value) && isRoutineFieldsWithRunPlace(value);
}
