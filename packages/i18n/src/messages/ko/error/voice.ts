import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/voice";

export const messages = {
  "error.voice.live.disconnected": "실시간 음성 연결이 끊어졌어요.",
  "error.voice.live.signIn": "실시간 음성을 사용하려면 ChatGPT 계정으로 Codex에 로그인해 주세요.",
  "error.voice.live.timedOut": "Codex 실시간 음성이 제시간에 시작되지 않았어요. 다시 시도해 주세요.",
  "error.voice.live.cannotStart":
    "실시간 음성을 시작하지 못했어요. Codex 로그인을 확인하고 Codex를 업데이트한 뒤 다시 시도해 주세요.",
  "error.voice.live.busy": "에이전트가 작업 중이에요. 작업이나 음성 통화가 끝나면 다시 시도해 주세요.",
  "error.voice.live.codexOnly": "실시간 음성은 Codex를 사용하는 에이전트에서 이용할 수 있어요.",
} as const satisfies PartialTranslation<typeof source>;
