import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/app";

export const messages = {
  "error.app.secretStorageUnavailable": "시스템 비밀 저장소를 사용할 수 없어요.",
} as const satisfies PartialTranslation<typeof source>;
