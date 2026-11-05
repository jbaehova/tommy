import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/voice";

export const messages = {
  "error.voice.transcriptionFailed": "Tommy가 이 녹음을 받아쓰지 못했어요.",
  "error.voice.cloud.keyRequired": "설정 → 음성에서 OpenAI API 키를 추가해 주세요.",
  "error.voice.cloud.keyRejected": "OpenAI가 API 키를 거부했어요. 설정 → 음성에서 키를 확인해 주세요.",
  "error.voice.cloud.quotaExceeded": "OpenAI 사용 한도를 다 썼어요.",
  "error.voice.cloud.rateLimited": "OpenAI가 바빠요. 잠시 뒤에 다시 시도해 주세요.",
  "error.voice.cloud.streamEnded": "받아쓰기 스트림이 종료되었어요. 다시 녹음해 주세요.",
} as const satisfies PartialTranslation<typeof source>;
