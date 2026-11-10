import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { decodeHostVaultCodes, type VaultState } from "@tommy/contracts/ipc";
import { VAULT_V3_ROUTES } from "@tommy/contracts/team-protocol/vault-v3";
import { useRef } from "react";
import { useQueryScope } from "@/features/auth/context/mobile-session-context";
import { useMobileWorkspace, useMobileWorkspaceActions } from "@/features/workspace/context/mobile-workspace-context";
import { queryKeys } from "@/features/workspace/model/query-keys";
import { haptics } from "@/shared/lib/haptics";
import { currentText } from "@/shared/lib/text";

/**
 * The Vault of one joined server, including optional API keys and two-step codes, for an owner or admin.
 * The Vault page and the item page read one query, so a change on one shows on the other. The host
 * answers each change with the whole state, which carries no secret.
 */
export function useServerVault(serverId: string) {
  const { servers, canManageVault, canImportVault, canManageVaultApiKeys, canManageVaultTwoStep } =
    useMobileWorkspace();
  const { loadVault, hostRequest } = useMobileWorkspaceActions();
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const server = servers.find((candidate) => candidate.id === serverId);
  const canManage = canManageVault(serverId);
  const canManageTwoStep = canManageVaultTwoStep(serverId);
  const identity = JSON.stringify([...queryScope, serverId, server?.membershipId, server?.publicKey]);
  const key = [...queryKeys.serverVault(queryScope, serverId), canManageTwoStep ? "v3" : "legacy"];
  // An agent or another device can change the Vault, and the phone gets no event: each page reads it again.
  const query = useQuery({
    queryKey: key,
    enabled: canManage,
    retry: false,
    staleTime: 0,
    queryFn: () => loadVault(serverId),
  });
  const locked = useRef(false);
  const action = useMutation({
    mutationFn: (operation: () => Promise<void>) => operation(),
    onSuccess: () => {
      void haptics.notification("success");
    },
    onError: () => {
      void haptics.notification("error");
    },
    onSettled: () => {
      locked.current = false;
    },
  });
  return {
    server,
    canManage,
    canManageTwoStep,
    identity,
    async loadCodes() {
      if (!canManageTwoStep) throw new Error(currentText().t("mobile.server.vault.twoStep.unsupported"));
      return hostRequest(serverId, VAULT_V3_ROUTES.codes, decodeHostVaultCodes, {});
    },
    canImport: canImportVault(serverId),
    canManageApiKeys: canManageVaultApiKeys(serverId),
    query,
    action,
    /** Shows the state that the host answered. A read still in flight has the old state. */
    async setState(state: VaultState): Promise<void> {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      queryClient.setQueryData(key, state);
    },
    /** Runs one change at a time. Resolves true when it succeeds. */
    perform(operation: () => Promise<void>): Promise<boolean> {
      if (locked.current) return Promise.resolve(false);
      locked.current = true;
      return action.mutateAsync(operation).then(
        () => true,
        () => false,
      );
    },
  };
}
