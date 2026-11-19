import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/messaging";

export const messages = {
  "error.messaging.telegramExchangeUnavailable":
    "텔레그램 메시지 전달을 확인하지 못했어요. 두 에이전트가 연결되어 있고 다른 봇의 메시지를 허용하는지 확인하세요.",
  "error.messaging.telegramPeerTaskFailed":
    "상대 텔레그램 에이전트가 작업을 완료하지 못했어요. 재시도하기 전에 모델 연결을 확인하세요.",
  "error.messaging.telegramExchangeLimit":
    "이 텔레그램 작업이 메시지 전달 한도에 도달했어요. 소유자에게 새 작업을 시작해 달라고 요청하세요.",
} as const satisfies PartialTranslation<typeof source>;
