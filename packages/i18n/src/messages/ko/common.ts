import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/common";

export const messages = {
  "common.cancel": "취소",
} as const satisfies PartialTranslation<typeof source>;
