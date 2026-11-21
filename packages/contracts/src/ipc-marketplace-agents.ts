import type { ReleasedRoutineSchedule } from "./ipc-routines";

export interface MarketplaceAgentSkill {
  skillId: string;
  versionId: string;
  slug: string;
  name: string;
  version: number;
}

export interface MarketplaceAgentRoutine {
  name: string;
  instruction: string;
  active: boolean;
  schedule: ReleasedRoutineSchedule;
}

export interface InstallMarketplaceAgentInput {
  listingId: string;
  agentId?: string;
  timezone: string;
  receiptId: string;
}
