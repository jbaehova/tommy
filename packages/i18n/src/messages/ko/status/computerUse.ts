import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/computerUse";

export const messages = {
  "status.computerUse.progressActing": "이 컴퓨터의 앱을 사용하는 중…",
  "status.computerUse.progressDeciding": "앱에서 다음 단계를 결정하는 중…",
} as const satisfies PartialTranslation<typeof source>;
