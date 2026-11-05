import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/host";

export const messages = {
  "error.host.webRtcNotConfigured": "서버 서비스가 설정되어 있지 않아요.",
  "error.host.nameBeforePublish": "이 Tommy를 게시하기 전에 이름을 지정해 주세요.",
  "error.host.publishFailed": "이 Tommy를 게시할 수 없어요.",
  "error.host.noServer": "이 컴퓨터에는 변경할 서버가 없어요.",
  "error.host.identityLocalOnly": "서버 이름과 로고는 서버를 실행하는 컴퓨터에서만 변경할 수 있어요.",
  "error.host.timezoneInvalid": "알 수 없는 시간대예요.",
} as const satisfies PartialTranslation<typeof source>;
