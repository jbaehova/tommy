import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/update";

export const messages = {
  // Updater state the user reads.
  "error.update.unsupported": "설치된 데스크톱 빌드에서만 업데이트할 수 있어요.",
  "error.update.managedByHost":
    "이 Mac의 업데이트는 호스트가 설치해요. 호스트의 유지 관리가 실행될 때까지 업데이트는 준비된 상태로 남아요.",
  // A joined server's admin reads these from the host.
  "error.update.remoteDisabled": "이 컴퓨터에서는 서버 관리자의 업데이트가 꺼져 있어요.",
  "error.update.restartStarted": "Tommy가 업데이트를 설치하기 위해 이미 다시 시작하고 있어요.",
} as const satisfies PartialTranslation<typeof source>;
