import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/voice";

export const messages = {
  "error.voice.transcriptionFailed": "Tommy가 이 녹음을 받아쓰지 못했어요.",
  "error.voice.cloud.keyRequired": "설정 → 음성에서 OpenAI API 키를 추가해 주세요.",
  "error.voice.cloud.keyRejected": "OpenAI가 API 키를 거부했어요. 설정 → 음성에서 키를 확인해 주세요.",
  "error.voice.cloud.quotaExceeded": "OpenAI 사용 한도를 다 썼어요.",
  "error.voice.cloud.rateLimited": "OpenAI가 바빠요. 잠시 뒤에 다시 시도해 주세요.",
  "error.voice.cloud.streamEnded": "받아쓰기 스트림이 종료되었어요. 다시 녹음해 주세요.",
  "error.voice.live.unavailable": "이 호스트는 실시간 음성을 지원하지 않아요. 사용하려면 호스트를 업데이트해 주세요.",
  "error.voice.live.disconnected": "실시간 음성 연결이 끊어졌어요.",
  "error.voice.live.signIn": "실시간 음성을 사용하려면 ChatGPT 계정으로 Codex에 로그인해 주세요.",
  "error.voice.live.timedOut": "Codex 실시간 음성이 제시간에 시작되지 않았어요. 다시 시도해 주세요.",
  "error.voice.live.cannotStart":
    "실시간 음성을 시작하지 못했어요. Codex 로그인을 확인하고 Codex를 업데이트한 뒤 다시 시도해 주세요.",
  "error.voice.live.busy": "에이전트가 작업 중이에요. 작업이나 음성 통화가 끝나면 다시 시도해 주세요.",
  "error.voice.live.codexOnly": "실시간 음성은 Codex를 사용하는 에이전트에서 이용할 수 있어요.",
} as const satisfies PartialTranslation<typeof source>;
