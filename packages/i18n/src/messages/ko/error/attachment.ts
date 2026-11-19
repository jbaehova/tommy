import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/attachment";

export const messages = {
  "error.attachment.totalTooLarge": "첨부 파일이 전체 250 MB 제한을 넘어요.",
  "error.attachment.tooMany": "파일은 최대 {limit}개까지 선택할 수 있어요.",
} as const satisfies PartialTranslation<typeof source>;
