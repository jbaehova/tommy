import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/computerUse";

export const messages = {
  // Computer Use driver and permission window errors.
} as const satisfies PartialTranslation<typeof source>;
