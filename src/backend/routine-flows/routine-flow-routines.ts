import type { AgentRoutineStore } from "../agent-routine-store";
import type { OwnedRoutineRecord } from "../routine-store";
import type { RoutineFlowsDependencies } from "./routine-flows";

function flowRoutine({ id, ownerId, name, active }: OwnedRoutineRecord) {
  return { id, agentId: ownerId, name, active };
}

export function routineFlowRoutines(routines: AgentRoutineStore): RoutineFlowsDependencies["routines"] {
  return {
    list: (agentId) => routines.listRecords(agentId).map(flowRoutine),
    get: (agentId, routineId) => {
      const record = routines.getRecord(agentId, routineId);
      return record ? flowRoutine(record) : null;
    },
  };
}
