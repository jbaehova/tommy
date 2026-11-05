import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/webClient";

export const messages = {
  "webClient.loading": "Tommy 불러오는 중…",
  "webClient.loadingLine.wake": "에이전트들을 깨우는 중…",
  "webClient.loadingLine.coffee": "에이전트들에게 커피를 따르는 중…",
  "webClient.loadingLine.tokens": "손가락으로 토큰을 세는 중…",
  "webClient.loadingLine.prompts": "엉킨 프롬프트를 푸는 중…",
  "webClient.loadingLine.sleepy": "졸린 친구를 살살 달래는 중…",
  "webClient.loadingLine.almost": "거의 다 됐어요. 아마도요.",
} as const satisfies PartialTranslation<typeof source>;
