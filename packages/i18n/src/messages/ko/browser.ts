import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/browser";

export const messages = {
  "browser.secret.title.password": "비밀번호를 입력해 주세요",
  "browser.secret.title.authenticator": "인증 앱 코드를 입력해 주세요",
  "browser.secret.title.code": "일회용 코드를 입력해 주세요",
  "browser.secret.notAddedToChat": "이 값은 채팅에 추가되지 않아요.",
  "browser.secret.codeLength": "{digits}자리 코드",
  "browser.secret.password": "비밀번호",
  "browser.secret.submit": "제출",
  "browser.secret.submitting": "제출 중…",
  "browser.secret.username": "아이디 또는 이메일",
  "browser.secret.failed": "요청을 완료할 수 없어요. 연결을 확인한 후 다시 시도해 주세요.",
  "browser.telegram.openFromManager": "세션이 끝났어요. Tommy를 닫고 채팅에서 다시 열어 주세요.",
  "browser.telegram.ready": "사용 가능",
  "browser.telegram.pending": "설정 대기",
  "browser.telegram.viewSnapshot": "화면 보기",
  "browser.telegram.refreshSnapshot": "새로고침",
  "browser.telegram.snapshotUnavailable": "이 페이지의 화면을 현재 볼 수 없습니다.",
  "browser.telegram.skip": "건너뛰기",
  "browser.telegram.promptTitle": "에이전트가 비공개 답을 기다려요",
  "browser.telegram.vaultTitle": "Vault에 저장",
  "browser.telegram.apiKeyTitle": "API 키 저장",
  "browser.telegram.refresh": "새로고침",
  "browser.telegram.mcpOpen": "로그인 페이지 열기",
  "browser.telegram.mcpReturn": "로그인 결과는 요청을 받은 Telegram 대화에서 확인해 주세요.",
} as const satisfies PartialTranslation<typeof source>;
