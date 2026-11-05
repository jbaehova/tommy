import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/window";

export const messages = {
  "window.localHostTitle": "Tommy 로컬 호스트",
  "window.localClientTitle": "Tommy 로컬 클라이언트",
} as const satisfies PartialTranslation<typeof source>;
