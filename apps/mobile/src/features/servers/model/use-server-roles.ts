import { useQuery } from "@tanstack/react-query";
import { canAdministerServer } from "@tommy/contracts/ipc";
import { useQueryScope } from "@/features/auth/context/mobile-session-context";
import {
  useMobileWorkspaceActions,
  useMobileWorkspaceSelector,
} from "@/features/workspace/context/mobile-workspace-context";
import { queryKeys } from "@/features/workspace/model/query-keys";

/**
 * True when the roles let this person only view `agentId`. The host sends each change of the roles as
 * `agents-changed` too, and that event reads the levels again. Unknown levels do not limit: the host
 * checks each write.
 */
export function useAgentViewOnly(serverId: string, agentId: string): boolean {
  const limited = useMobileWorkspaceSelector((workspace) => workspace.hasAgentAccessLimits(serverId));
  // An owner or admin can use all agents, also with levels read before a promotion.
  const role = useMobileWorkspaceSelector(
    (workspace) => workspace.servers.find((server) => server.id === serverId)?.role,
  );
  const { loadServerRoles } = useMobileWorkspaceActions();
  const queryScope = useQueryScope();
  const access = useQuery({
    queryKey: queryKeys.serverRoles(queryScope, serverId),
    enabled: limited,
    // Kept while the app runs: offline, the last levels that the host sent still apply. After a
    // restart offline, the levels are unknown until the host answers.
    gcTime: Number.POSITIVE_INFINITY,
    queryFn: () => loadServerRoles(serverId),
  });
  return !canAdministerServer(role) && access.data?.mine[agentId] === "view";
}
