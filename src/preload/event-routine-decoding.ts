import { guardedDecoder, guardedListDecoder } from "@tommy/contracts/ipc-decoding";
import { isEventRoutineWithRunPlace, isSaveEventRoutineResultWithRunPlace } from "@tommy/contracts/ipc-events";

export const decodeEventRoutinesFromMain = guardedListDecoder(isEventRoutineWithRunPlace, "event routines from main");
export const decodeSavedEventRoutineFromMain = guardedDecoder(
  isSaveEventRoutineResultWithRunPlace,
  "saved event routine from main",
);
