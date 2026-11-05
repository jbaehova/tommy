import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/import";

export const messages = {
  "import.count.agent": { other: "에이전트 {count}개" },
  "import.count.skill": { other: "스킬 {count}개" },
  "import.count.routine": { other: "루틴 {count}개" },
  "import.count.memory": { other: "메모리 {count}개" },
  "import.count.file": { other: "파일 {count}개" },
} as const satisfies PartialTranslation<typeof source>;
