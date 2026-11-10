import { Schema } from "effect";

/** Access belongs to the authenticated host boundary. A renderer request cannot set it. */
export interface MessageDeleteAccess {
  memberId: string | null;
  deleteAny: boolean;
}

export class MessageDeleteRefused extends Schema.TaggedError<MessageDeleteRefused>()("MessageDeleteRefused", {
  reason: Schema.Literals(["not-found", "busy", "forbidden"]),
}) {}
