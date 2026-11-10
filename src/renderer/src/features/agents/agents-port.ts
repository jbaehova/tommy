import type { TommyDesktopApi } from "@tommy/contracts/ipc";

/**
 * What the agents domain reaches in main: agent records, their models and read state, and the agent
 * event stream.
 */
export interface AgentsPort {
  agent: Pick<
    TommyDesktopApi["agent"],
    | "createAgent"
    | "deleteAgent"
    | "duplicateAgent"
    | "getAgentAdminSettings"
    | "getAgentHostSettings"
    | "updateAgentHostSettings"
    | "getAgentBackupModels"
    | "updateAgentBackupModels"
    | "getAgentTaskLimit"
    | "updateAgentTaskLimit"
    | "getAgentNewChat"
    | "updateAgentNewChat"
    | "getAgentPlanCard"
    | "updateAgentPlanCard"
    | "getAgentFastMode"
    | "getAgentSpeed"
    | "updateAgentSpeed"
    | "getAgentSpeedModels"
    | "updateAgentFastMode"
    | "listAgents"
    | "listConversationReads"
    | "listModels"
    | "onEvent"
    | "getRuntimeSnapshot"
    | "setAgentHidden"
    | "setAvatar"
    | "updateAgent"
    | "updateAgentAdminSettings"
  >;
  /** The accounts of a joined server's providers, which its released agent routes do not carry. */
  providerAdmin: Pick<TommyDesktopApi["providerAdmin"], "accounts" | "accountUsage">;
}

/** Read on each call: tests and stories replace `window.tommy` per case. */
export function agentsPort(): AgentsPort {
  return window.tommy;
}
