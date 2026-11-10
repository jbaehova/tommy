import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/vault";

export const messages = {
  "error.vault.unavailable": "이 컴퓨터에는 비밀정보 저장소가 없어 보관함에 항목을 저장할 수 없어요.",
  "error.vault.unreadable": "보관함 파일을 읽을 수 없어요. 다시 사용하려면 보관함을 초기화해 주세요.",
  "error.vault.tooLarge": "보관함이 가득 찼어요. 일부 항목을 삭제한 뒤 다시 시도해 주세요.",
  "error.vault.itemMissing": "이 항목은 보관함에 더 이상 없어요.",
  "error.vault.valueTooLong": "입력한 값이 너무 길어요.",
  "error.vault.websiteInvalid": "HTTPS 웹사이트 주소를 입력해 주세요.",
  "error.vault.passwordRequired": "비밀번호를 입력해 주세요.",
  "error.vault.cardNumberInvalid": "올바른 카드 번호를 입력해 주세요.",
  "error.vault.securityCodeInvalid": "3자리 또는 4자리 보안 코드를 입력해 주세요.",
  "error.vault.expiryInvalid": "올바른 만료 월과 연도를 입력해 주세요.",
  "error.vault.contactEmpty": "이름이나 주소, 전화번호 또는 이메일 주소를 입력해 주세요.",
  "error.vault.contactMissing": "청구지 연락처는 보관함에 더 이상 없어요.",
  "error.vault.apiKeyRequired": "API 키를 입력해 주세요.",
  "error.vault.apiKeyNameInvalid":
    "OPENAI_API_KEY처럼 영문 대문자로 시작하고 영문 대문자, 숫자, 밑줄(_)로 된 변수 이름을 입력해 주세요.",
  "error.vault.apiKeyNameTaken": "이 변수 이름의 API 키가 보관함에 이미 있어요.",
  "error.vault.csvInvalid": "비밀번호를 내보낸 CSV 파일이 아니에요.",
  "error.vault.csvTooLarge": "CSV 파일이 너무 커요.",
  "error.vault.twoStepKeyInvalid":
    "올바른 2단계 인증 키가 아니에요. 사이트의 설정 키 또는 otpauth:// 링크를 입력해 주세요.",
} as const satisfies PartialTranslation<typeof source>;
