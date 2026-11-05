import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/remote";

export const messages = {
  "status.remote.stagePreferences": "로컬 채팅 환경설정 불러오는 중: {reason}",
  "status.remote.stageConnection": "데스크톱에 연결 중: {reason}",
  "status.remote.stageCompatibility": "데스크톱 호환성 확인 중: {reason}",
  "status.remote.stageAgents": "에이전트 불러오는 중: {reason}",
  "status.remote.stageReads": "읽음 상태 불러오는 중: {reason}",
  "status.remote.suspendedDetail": "연결하기 전에 Tommy Mobile 또는 데스크톱 앱을 업데이트해 주세요.\n{detail}",
  "status.remote.cooldownDetail":
    "{limit}번 시도했지만 연결하지 못했어요. {minutes}:{seconds} 후 다시 시도해요.\n{detail}",
  "status.remote.cooldown": "{limit}번 시도했지만 연결하지 못했어요. {minutes}:{seconds} 후 다시 시도해요.",
  "status.remote.connectionLostDetail": { other: "연결이 끊어졌어요. {count}초 후 다시 시도해요.\n{detail}" },
  "status.remote.connectionLost": { other: "연결이 끊어졌어요. {count}초 후 다시 시도해요." },
  "status.remote.attemptFailedDetail": { other: "연결 시도에 실패했어요. {count}초 후 다시 시도해요.\n{detail}" },
  "status.remote.attemptFailed": { other: "연결 시도에 실패했어요. {count}초 후 다시 시도해요." },
  "status.remote.reconnectingDetail": { other: "다시 연결 중 {attempt}/{count}\n{detail}" },
  "status.remote.reconnecting": { other: "다시 연결 중 {attempt}/{count}" },
} as const satisfies PartialTranslation<typeof source>;
