import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/team";

export const messages = {
  "error.team.logoInvalid": "512 KB 이하의 올바른 PNG, JPEG 또는 WebP 이미지를 선택해 주세요.",
  "error.team.agentNotFound": "에이전트를 찾을 수 없어요.",
} as const satisfies PartialTranslation<typeof source>;
