import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/host";

export const messages = {
  "status.host.telegramDisconnectUsage": "이 관리 봇 채팅에서 /disconnect @사용자이름을 보내세요.",
  "status.host.telegramDisconnectAmbiguous":
    "여러 연결에 @{username}이 지정되어 있습니다. BotFather에서 현재 사용자 이름을 확인하세요.",
  "status.host.telegramDisconnectedAlready": "@{username}은 이 Tommy 서버에 연결되어 있지 않습니다.",
  "status.host.telegramDisconnectConfirm":
    "@{username} 연결을 해제하려면 5분 안에 아래 명령을 보내세요. Tommy는 에이전트와 작업공간을 보관합니다.\n\n/disconnect @{username} {code}",
  "status.host.telegramDisconnectExpired": "/disconnect @{username}을 보내 연결 해제를 다시 확인하세요.",
  "status.host.telegramDisconnected":
    "@{username}의 연결을 해제했습니다. Tommy에 에이전트와 작업공간이 보관됩니다. 텔레그램 봇 계정을 영구 삭제하려면 @BotFather에서 /deletebot을 사용하세요.",
} as const satisfies PartialTranslation<typeof source>;
