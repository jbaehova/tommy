import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/mcp";

export const messages = {
  "error.mcp.redirectByName": "이 주소는 이름으로 접근할 수 없어요.",
  "error.mcp.redirectGetOnly": "이 주소는 GET 요청에만 응답해요.",
  "error.mcp.redirectNotSignIn": "이 주소는 로그인 과정에 속하지 않아요.",
  "error.mcp.redirectRefused": "로그인이 거부되었어요. Tommy로 돌아가 다시 시도해 주세요.",
  "error.mcp.redirectNoSignIn": "대기 중인 로그인이 없어요. 이미 종료되었을 수 있어요.",
  "error.mcp.redirectSignedIn": "Tommy에 로그인했어요. 이 창을 닫아도 돼요.",
  "error.mcp.signInFileUnreadable": "MCP 로그인 파일을 읽을 수 없어요.",
  "error.mcp.signInFileTooLarge": "MCP 로그인 파일이 너무 커요.",
  "error.mcp.redirectRelayed": "Tommy가 로그인 정보를 서버로 보냈어요. 이 창을 닫아도 돼요.",
} as const satisfies PartialTranslation<typeof source>;
