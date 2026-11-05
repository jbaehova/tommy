import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/update";

export const messages = {
  "update.provider.update": "업데이트",
  "update.provider.upToDate": "{name}은(는) 최신 상태예요",
  "update.provider.checking": "{name} 업데이트 확인 중",
  "update.provider.available": "{name} 업데이트 가능",
  "update.provider.updating": "{name} 업데이트 중",
  "update.provider.waiting": "{name} 업데이트 대기 중",
  "update.provider.failed": "{name} 업데이트 실패",
  "update.provider.settingUp": "설정 중",
  "update.provider.failedRetry": "업데이트에 실패했어요. 다시 시도해 주세요.",
  "update.provider.unknownVersion": "알 수 없는 버전",
  "update.provider.remoteHost": "제공자 CLI 업데이트는 해당 제공자를 호스팅하는 컴퓨터에서 실행돼요.",
  "update.provider.unavailable": "제공자 업데이트를 사용할 수 없어요.",
  "update.provider.downloadsUnavailable": "제공자 다운로드를 사용할 수 없어요.",
  "update.provider.startFailed": "업데이트를 시작하지 못했어요. 다시 시도해 주세요.",
  "update.provider.showDetails": "자세히 보기",
  "update.provider.hideDetails": "자세히 숨기기",
} as const satisfies PartialTranslation<typeof source>;
