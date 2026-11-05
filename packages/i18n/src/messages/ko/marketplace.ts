import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/marketplace";

export const messages = {
  "marketplace.app.notConnected": "연결 안 됨",
} as const satisfies PartialTranslation<typeof source>;
