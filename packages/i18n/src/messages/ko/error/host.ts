import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/host";

export const messages = {
  "error.host.timezoneInvalid": "알 수 없는 시간대예요.",
} as const satisfies PartialTranslation<typeof source>;
