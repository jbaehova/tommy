import { Schema } from "effect";

export class CentralAuthOperationError extends Schema.TaggedError<CentralAuthOperationError>()(
  "CentralAuthOperationError",
  {
    cause: Schema.Defect(),
  },
) {}
