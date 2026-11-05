import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/mobile/link";

export const messages = {
  "mobile.link.template.error.unsupported":
    "이 서버는 공유된 에이전트를 추가할 수 없어요. 서버를 실행하는 컴퓨터에서 Tommy를 업데이트해 주세요.",
} as const satisfies PartialTranslation<typeof source>;
