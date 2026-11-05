import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/messaging";

export const messages = {
  "status.messaging.integrationsSection": "연동",
} as const satisfies PartialTranslation<typeof source>;
