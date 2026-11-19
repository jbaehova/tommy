import { Schema } from "effect";
import { causeHelpers } from "../backend/effect-boundary";

export class RemoteWorkflowError extends Schema.TaggedError<RemoteWorkflowError>()("RemoteWorkflowError", {
  cause: Schema.Defect(),
}) {}

export const { io: remoteCall } = causeHelpers(RemoteWorkflowError);
