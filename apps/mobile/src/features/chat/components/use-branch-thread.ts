import { useQueryClient } from "@tanstack/react-query";
import type { AgentTasksSnapshot, ConversationMessage } from "@tommy/contracts/ipc";
import * as Crypto from "expo-crypto";
import { router, useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { showFailureAlert } from "@/features/analytics/failure-reports";
import { useQueryScope } from "@/features/auth/context/mobile-session-context";
import { useAgentViewOnly } from "@/features/servers/model/use-server-roles";
import {
  useMobileWorkspaceReader,
  useMobileWorkspaceSelector,
} from "@/features/workspace/context/mobile-workspace-context";
import { queryKeys } from "@/features/workspace/model/query-keys";
import { haptics } from "@/shared/lib/haptics";
import { currentText } from "@/shared/lib/text";
import { useAppForeground } from "@/shared/lib/use-app-foreground";
import { branchPointIds } from "../model/branch-points";

const NO_IDS: ReadonlySet<string> = new Set();

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

/**
 * "Branch from here" in a conversation of an agent, as on desktop: the agent's own chat when
 * `sourceTaskId` is null, else a thread. A branch copies the conversation through the turn of the
 * chosen answer into a new thread, which then opens. No turn starts. The host must serve
 * `agent-thread-branches-v1` and be online. While a turn runs, no message offers a branch: the
 * host refuses a source with a running turn.
 */
export function useBranchThread({
  serverId,
  agentId,
  sourceTaskId,
  messages,
  activeTurnId,
}: {
  serverId: string;
  agentId: string;
  sourceTaskId: string | null;
  messages: readonly ConversationMessage[] | undefined;
  activeTurnId: string | null;
}) {
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const workspace = useMobileWorkspaceReader();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const host = useMobileWorkspaceSelector((current) => current.servers.find((server) => server.id === serverId));
  // The host branches only for a member who can write to the agent.
  const viewOnly = useAgentViewOnly(serverId, agentId);
  const enabled =
    useMobileWorkspaceSelector(
      (current) =>
        current.servers.some((server) => server.id === serverId && server.state === "online") &&
        current.canUseTasks(serverId) &&
        current.canBranchThreads(serverId),
    ) && !viewOnly;
  const scope = JSON.stringify([
    ...queryScope,
    serverId,
    agentId,
    sourceTaskId,
    host?.publicKey,
    host?.membershipId,
    host?.role,
  ]);
  const active = enabled && focused && foreground;
  const latest = useRef({ scope, active, epoch: 0 });
  if (latest.current.scope !== scope || latest.current.active !== active)
    latest.current = { scope, active, epoch: latest.current.epoch + 1 };
  const epoch = latest.current.epoch;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // One set while its ids stay, so a streamed chunk does not draw every row of the chat again.
  const stable = useRef(NO_IDS);
  const branchPoints = useMemo(() => {
    const next = enabled && messages && !activeTurnId ? branchPointIds(messages, null) : NO_IDS;
    if (!sameIds(next, stable.current)) stable.current = next;
    return stable.current;
  }, [enabled, messages, activeTurnId]);

  // One branch at a time. A second touch while the first request runs does nothing.
  const pending = useRef(false);
  const attempt = useRef<{ key: string; requestId: string } | null>(null);
  const branch = useCallback(
    async (messageId: string) => {
      const current = () =>
        mounted.current && latest.current.scope === scope && latest.current.epoch === epoch && latest.current.active;
      if (pending.current || !current() || !branchPoints.has(messageId)) return;
      pending.current = true;
      const key = JSON.stringify([scope, messageId]);
      if (attempt.current?.key !== key) attempt.current = { key, requestId: Crypto.randomUUID() };
      const requestId = attempt.current.requestId;
      void haptics.impact("light");
      try {
        const task = await workspace().branchAgentThread(
          { agentId, taskId: sourceTaskId, messageId, requestId },
          serverId,
        );
        if (!current()) return;
        // The thread shows in the menu before its list event arrives.
        queryClient.setQueryData<AgentTasksSnapshot>(queryKeys.agentTasks(queryScope, serverId, agentId), (stored) =>
          stored && !stored.tasks.some((entry) => entry.id === task.id)
            ? { ...stored, tasks: [task, ...stored.tasks] }
            : stored,
        );
        attempt.current = null;
        void haptics.notification("success");
        // From a thread, the branch replaces it on the screen, so Back still returns to the agent's chat.
        if (sourceTaskId === null)
          router.push({ pathname: "/task/[taskId]", params: { serverId, agentId, taskId: task.id } });
        else router.setParams<"/task/[taskId]">({ taskId: task.id, messageId: undefined });
      } catch (cause) {
        if (!current()) return;
        void haptics.notification("error");
        const text = currentText();
        const title = text.t("mobile.chat.message.branchFailed");
        showFailureAlert(cause, title, text.errorMessage(cause, title));
      } finally {
        pending.current = false;
      }
    },
    [workspace, agentId, sourceTaskId, serverId, queryClient, queryScope, scope, epoch, branchPoints],
  );

  return { branchPoints, branch: enabled ? branch : undefined };
}
