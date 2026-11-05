import type { AgentProviderId } from "@tommy/contracts/agent-providers";
import type { CauseCode } from "@tommy/contracts/failure-cause";

/** Local analytics context. This is not an IPC or Team API payload. */
export interface FailureContext {
  causeCode?: CauseCode;
  provider?: AgentProviderId;
  model?: string | null;
  turnId?: string | null;
  severity?: "error" | "warning";
}
export interface FailureSignal extends FailureContext {
  code: string;
  causeCode: CauseCode;
  agentId?: string;
}
