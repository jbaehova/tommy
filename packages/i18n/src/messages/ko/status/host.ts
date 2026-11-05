import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/host";

export const messages = {
  // Status lines of the server.
  "status.host.registered": "이 Tommy를 접속용으로 등록했어요.",
  "status.host.identityUpdated": "서버 ID를 업데이트했어요.",
  "status.host.starting": "서버를 시작하는 중…",
  "status.host.ready": "이 Tommy는 연결을 받을 준비가 됐어요.",
  "status.host.stopping": "이 Tommy를 비공개로 전환하는 중…",
  "status.host.private": "이 Tommy는 비공개예요.",
} as const satisfies PartialTranslation<typeof source>;
