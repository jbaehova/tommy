import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/mobile/marketplace";

export const messages = {
  "mobile.marketplace.error.agentUnsupported":
    "마켓플레이스에서 에이전트를 추가하려면 서버의 Tommy를 업데이트해 주세요.",
  "mobile.marketplace.error.agentUpdateUnsupported":
    "마켓플레이스에서 에이전트를 업데이트하려면 서버의 Tommy를 업데이트해 주세요.",
  "mobile.marketplace.error.signInUnsupported": "휴대폰에서 앱에 로그인하려면 서버의 Tommy를 업데이트해 주세요.",
} as const satisfies PartialTranslation<typeof source>;
