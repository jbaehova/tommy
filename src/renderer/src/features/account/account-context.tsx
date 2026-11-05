import type { AccountUsage, AccountUsageLimit, CentralAuthState } from "@tommy/contracts/ipc";
import { currentText } from "@tommy/ui/text";
import { createMemo, createSignal, createStore, flush, onSettled } from "solid-js";
import { createSimpleContext } from "../../simple-context";
import { accountPort } from "./account-port";

/** The pairing with the one server: the connection state, plan usage, and the commands that change them. */
const Auth = createSimpleContext({
  name: "Auth",
  init: () => {
    const [centralAuth, setCentralAuth] = createSignal<CentralAuthState>({ status: "loading" });
    const [accountUsageState, setAccountUsageState] = createStore<{
      targetKey: string | null;
      data: AccountUsage | null;
      refreshRevision: number;
    }>({ targetKey: null, data: null, refreshRevision: 0 });
    let accountUsageRequestGeneration = 0;
    /** The providers an event updated while the current refresh runs. Their rows are newer than it. */
    let accountUsageEventIds = new Set<string>();
    function applyCentralAuthState(state: CentralAuthState): void {
      setCentralAuth(state);
    }

    onSettled(() => {
      const unsubscribe = accountPort().auth.onEvent((state) => {
        flush(() => applyCentralAuthState(state));
      });
      void accountPort()
        .auth.getState()
        .then(setCentralAuth)
        .catch(() =>
          setCentralAuth({
            status: "error",
            issue: {
              code: "auth_unavailable",
              message: currentText().t("account.login.loadFailed"),
            },
          }),
        );
      return unsubscribe;
    });

    async function retryCentralAccount(): Promise<void> {
      applyCentralAuthState({ status: "loading" });
      applyCentralAuthState(await accountPort().auth.retry());
    }

    async function pairDevice(address: string, code: string): Promise<void> {
      applyCentralAuthState(await accountPort().auth.pairDevice({ address, code }));
    }

    async function logoutCentralAccount(): Promise<void> {
      applyCentralAuthState(await accountPort().auth.logout());
    }

    const accountUsage = () => accountUsageState.data;
    const accountUsageRefreshRevision = () => accountUsageState.refreshRevision;
    const accountUsageTargetKey = () => accountUsageState.targetKey;

    /**
     * Selects the target of the reading. The reading stays until a refresh for the new target replaces it,
     * so the rail rings do not go away while providers finish their checks. `invalidateAccountUsage`
     * drops it.
     */
    function selectAccountUsageTarget(targetKey: string | null): void {
      if (accountUsageState.targetKey === targetKey) return;
      accountUsageRequestGeneration += 1;
      setAccountUsageState((state) => {
        state.targetKey = targetKey;
      });
    }

    function invalidateAccountUsage(): void {
      accountUsageRequestGeneration += 1;
      setAccountUsageState((state) => {
        state.data = null;
        state.refreshRevision += 1;
      });
    }

    function applyAccountUsage(usage: AccountUsage): void {
      if (usage.limits.length === 0) {
        accountUsageRequestGeneration += 1;
        setAccountUsageState((state) => {
          state.data = usage;
        });
        return;
      }
      for (const limit of usage.limits) accountUsageEventIds.add(usageLimitKey(limit));
      setAccountUsageState((state) => {
        const byId = new Map((state.data?.limits ?? []).map((limit) => [usageLimitKey(limit), limit]));
        for (const limit of usage.limits) byId.set(usageLimitKey(limit), limit);
        state.data = { limits: [...byId.values()] };
      });
    }

    async function refreshAccountUsage(targetKey: string): Promise<AccountUsage> {
      selectAccountUsageTarget(targetKey);
      const generation = ++accountUsageRequestGeneration;
      accountUsageEventIds = new Set();
      const usage = await accountPort().agent.getUsage();
      if (generation === accountUsageRequestGeneration && accountUsageState.targetKey === targetKey) {
        // The refresh reads every provider, so a row it omits has stopped reporting, such as a revoked
        // OpenCode Go key. It keeps only the rows an event updated after it started.
        setAccountUsageState((state) => {
          const byId = new Map(usage.limits.map((limit) => [usageLimitKey(limit), limit]));
          for (const limit of state.data?.limits ?? []) {
            const key = usageLimitKey(limit);
            if (accountUsageEventIds.has(key)) byId.set(key, limit);
          }
          state.data = { limits: [...byId.values()] };
        });
      }
      return usage;
    }

    const signedInAccount = createMemo(() => {
      const state = centralAuth();
      return state.status === "signed_in" ? state.user : null;
    });
    const visibleSignedInAccount = signedInAccount;

    return {
      centralAuth,
      signedInAccount,
      visibleSignedInAccount,
      accountUsage,
      accountUsageRefreshRevision,
      accountUsageTargetKey,
      selectAccountUsageTarget,
      invalidateAccountUsage,
      applyAccountUsage,
      refreshAccountUsage,
      retryCentralAccount,
      pairDevice,
      logoutCentralAccount,
    };
  },
});

export const AuthProvider = Auth.provider;
export const useAuth = Auth.use;

/** One row for each account of a provider: the provider's own sign-in has no account. */
function usageLimitKey(limit: AccountUsageLimit): string {
  return `${limit.id}\n${limit.accountId ?? ""}`;
}
