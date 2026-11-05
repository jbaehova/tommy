import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/auth";

export const messages = {
  // Errors from the Tommy account service.
  "error.auth.signInFirst": "먼저 Tommy에 로그인해 주세요.",
  "error.auth.hostCredentialUnavailable": "원격 호스트 자격 증명을 사용할 수 없어요. 호스트를 다시 등록해 주세요.",
} as const satisfies PartialTranslation<typeof source>;
