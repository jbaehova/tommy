import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/sidebar";

export const messages = {
  "sidebar.empty.noAgents": "아직 에이전트가 없어요",
  "sidebar.view.agents": "에이전트",
} as const satisfies PartialTranslation<typeof source>;
