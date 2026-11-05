import {
  AGENT_PROVIDERS,
  type AgentProviderId,
  type AgentProviderStatus,
  type AgentStatus,
  agentProviderDescriptor,
  agentProviderName,
  type HostProviderAccounts,
  isAgentStatus,
  loopbackCallback,
  MANAGED_RUNTIME_PROVIDERS,
  type ManagedProviderId,
  type ProviderApiKeyStatus,
  type ProviderCodeLoginStart,
  type ProviderRuntimeSnapshot,
  type ProviderRuntimeStatus,
  type SignInRelayStatus,
} from "@tommy/contracts/ipc";
import { isOneOf } from "@tommy/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@tommy/contracts/team-api-routes";
import { providerAccountRelay } from "@tommy/contracts/team-protocol/provider-account-relays";
import { PROVIDER_ACCOUNTS_CAPABILITY } from "@tommy/contracts/team-protocol/provider-accounts-v1";
import { PROVIDER_DEFAULT_CAPABILITY } from "@tommy/contracts/team-protocol/provider-default-v1";
import {
  PROVIDERS_ADMIN_CODE_SIGN_IN_PROVIDERS,
  PROVIDERS_ADMIN_ROUTES,
} from "@tommy/contracts/team-protocol/providers-v1";
import {
  PROVIDERS_RUNTIMES_V2_CAPABILITY,
  PROVIDERS_RUNTIMES_V2_ROUTES,
} from "@tommy/contracts/team-protocol/providers-v2";
import {
  PROVIDERS_SIGN_IN_V3_CAPABILITY,
  PROVIDERS_SIGN_IN_V3_PROVIDERS,
  PROVIDERS_SIGN_IN_V3_ROUTES,
} from "@tommy/contracts/team-protocol/providers-v3";
import {
  PROVIDERS_V4_CAPABILITY,
  PROVIDERS_V4_ROUTES,
  PROVIDERS_V4_SIGN_IN_PROVIDERS,
} from "@tommy/contracts/team-protocol/providers-v4";
import { PROVIDERS_V5_CAPABILITY, PROVIDERS_V5_ROUTES } from "@tommy/contracts/team-protocol/providers-v5";
import { PROVIDERS_V8_CAPABILITY, PROVIDERS_V8_ROUTES } from "@tommy/contracts/team-protocol/providers-v8";
import { SIGN_IN_RELAY_CAPABILITY, SIGN_IN_RELAY_PROVIDERS } from "@tommy/contracts/team-protocol/sign-in-relay-v1";
import type { MobileTextKey } from "@tommy/i18n/mobile";
import {
  cancelProviderCodeLogin,
  cancelProviderRuntime,
  cancelProviderSignInRelay,
  checkProviderRuntimeUpdates,
  clearProviderApiKey,
  completeSignInRelay,
  downloadProviderRuntime,
  getHostProviderDefault,
  getProviderApiKeyState,
  getProviderRuntimes,
  type HostProviderDefault,
  listProviderAccounts,
  removeProviderAccount,
  renameProviderAccount,
  setHostProviderDefault,
  setProviderApiKey,
  signInRelayStatus,
  startProviderAccountSignInRelay,
  startProviderCodeLogin,
  startProviderSignInRelay,
  submitProviderCodeLogin,
} from "@tommy/team-client/team-admin-requests";
import type { TeamApiRequest } from "@tommy/team-client/team-api-requests";
import { runTeamRequest } from "@/features/workspace/model/team-request";
import { currentText } from "@/shared/lib/text";

/** The runtimes that `providers-v1` reads and downloads. Later route sets add providers. */

/**
 * How Connect signs in a provider of the host. A phone cannot take a sign-in callback.
 *
 * - `code`: the host's code route. The host shows a device code, a page for a pasted code, or a link.
 * - `relay`: the host starts the sign-in and the phone opens the page (`sign-in-relay-v1`). A page that
 *   returns to the host's loopback address needs that address pasted back.
 */
type ProviderSignInMethod = "code" | "relay";

function codeSignInProviders(capabilities: readonly string[]): readonly AgentProviderId[] {
  if (capabilities.includes(PROVIDERS_V4_CAPABILITY)) {
    const paste = capabilities.includes(PROVIDERS_SIGN_IN_V3_CAPABILITY);
    return AGENT_PROVIDERS.filter(
      (provider) =>
        isOneOf(PROVIDERS_V4_SIGN_IN_PROVIDERS, provider) &&
        (paste || agentProviderDescriptor(provider).localCodeSignIn !== "paste"),
    );
  }
  if (capabilities.includes(PROVIDERS_SIGN_IN_V3_CAPABILITY))
    return AGENT_PROVIDERS.filter((provider) => isOneOf(PROVIDERS_SIGN_IN_V3_PROVIDERS, provider));
  return AGENT_PROVIDERS.filter((provider) => isOneOf(PROVIDERS_ADMIN_CODE_SIGN_IN_PROVIDERS, provider));
}

/**
 * The one sign-in that Connect runs, or null when the phone cannot sign the provider in: the code
 * route first, because it needs nothing pasted back, then the relayed page. The host's own browser
 * page needs the live view, which the phone does not show.
 */
function providerSignInMethod(provider: AgentProviderId, capabilities: readonly string[]): ProviderSignInMethod | null {
  if (codeSignInProviders(capabilities).includes(provider)) return "code";
  return capabilities.includes(SIGN_IN_RELAY_CAPABILITY) && isOneOf(SIGN_IN_RELAY_PROVIDERS, provider) ? "relay" : null;
}

function runtimeProviders(capabilities: readonly string[]): readonly ManagedProviderId[] {
  return MANAGED_RUNTIME_PROVIDERS;
}

/** The providers whose API key the host saves. */
function providerHasApiKey(provider: AgentProviderId): boolean {
  return provider === "claude";
}

export interface ProviderRow {
  id: AgentProviderId;
  name: string;
  status: AgentProviderStatus | undefined;
  /** Absent when the host's route set does not download this provider. */
  runtime: (ProviderRuntimeStatus & { provider: ManagedProviderId }) | undefined;
  /** Installed, idle, and the host has a different version. */
  updatable: boolean;
  signIn: ProviderSignInMethod | null;
  apiKey: boolean;
}

/**
 * The rows of the Providers page, as the desktop Providers tab builds them for a joined server: a
 * provider that only newer protocols carry is listed only when the host's status names it.
 */
export function providerRows(
  status: AgentStatus | undefined,
  snapshot: ProviderRuntimeSnapshot | undefined,
  capabilities: readonly string[],
): ProviderRow[] {
  const runtimes = runtimeProviders(capabilities);
  return [...AGENT_PROVIDERS]
    .sort((left, right) => agentProviderDescriptor(left).pickerOrder - agentProviderDescriptor(right).pickerOrder)
    .map((provider) => {
      const agent = status?.providers?.find((candidate) => candidate.id === provider);
      const managed = isOneOf(runtimes, provider) ? provider : undefined;
      const raw = managed && snapshot ? snapshot.providers[managed] : undefined;
      // As on desktop: a CLI that the user installed reads as ready on its own version, while its
      // managed runtime is idle.
      const runtime =
        raw &&
        (raw.phase === "ready" || raw.phase === "not-downloaded") &&
        (agent?.state === "available" || agent?.state === "sign-in-required") &&
        (agent.cliSource === "system" || (raw.phase === "not-downloaded" && !raw.availableVersion))
          ? { ...raw, phase: "ready" as const, version: agent.version ?? null }
          : raw;
      const availableVersion = runtime?.availableVersion ?? null;
      return {
        id: provider,
        name: agentProviderName(provider),
        status: agent,
        runtime: managed && runtime ? { ...runtime, provider: managed } : undefined,
        updatable: Boolean(
          runtime &&
            (runtime.phase === "ready" || (runtime.phase === "not-downloaded" && runtime.version !== null)) &&
            availableVersion !== null &&
            availableVersion !== runtime.version,
        ),
        signIn: providerSignInMethod(provider, capabilities),
        apiKey: providerHasApiKey(provider),
      };
    });
}

/** The status text of a row, in the order of the desktop badge. A download shows its percentage. */
export function providerStatusText(row: ProviderRow): { key: MobileTextKey } | { percent: number } {
  const { runtime, updatable } = row;
  const state = row.status?.state ?? "not-installed";
  if (runtime?.phase === "downloading" && runtime.message)
    return { key: "mobile.server.providers.status.updateWaiting" };
  if (runtime?.phase === "downloading") return { percent: Math.max(0, Math.min(100, runtime.progress ?? 0)) / 100 };
  if (runtime?.phase === "finishing") return { key: "mobile.server.providers.status.settingUp" };
  if (row.status?.connectionState === "connecting" && state !== "available")
    return { key: "mobile.server.providers.status.connecting" };
  if (updatable) return { key: "mobile.server.providers.status.updateAvailable" };
  if (runtime?.phase === "download-error")
    return {
      key: runtime.version
        ? "mobile.server.providers.status.updateFailed"
        : "mobile.server.providers.status.setupFailed",
    };
  if (state === "available") return { key: "mobile.server.providers.status.connected" };
  if (runtime?.phase === "not-downloaded") return { key: "mobile.server.providers.status.notDownloaded" };
  if (state === "sign-in-required") return { key: "mobile.server.providers.status.notConnected" };
  if (state === "outdated") return { key: "mobile.server.providers.status.updateRequired" };
  if (state === "error") return { key: "mobile.server.providers.status.unavailable" };
  if (runtime?.phase === "ready") return { key: "mobile.server.providers.status.ready" };
  if (state === "not-installed") return { key: "mobile.server.providers.status.notInstalled" };
  return { key: "mobile.server.providers.status.checking" };
}

/** The status text of an account. A newer host can send a state that this phone shows as an error. */
export function providerAccountStateKey(state: string): MobileTextKey {
  if (state === "connected") return "mobile.server.providers.status.connected";
  if (state === "connecting") return "mobile.server.providers.status.connecting";
  if (state === "checking") return "mobile.server.providers.status.checking";
  if (state === "signed-out") return "mobile.server.providers.status.notConnected";
  return "mobile.server.providers.status.unavailable";
}

/** A download or its setup step runs on the host. */
export function providerRuntimeBusy(row: ProviderRow): boolean {
  return row.runtime?.phase === "downloading" || row.runtime?.phase === "finishing";
}

function decodeAgentStatus(value: unknown): AgentStatus {
  if (!isAgentStatus(value)) throw new Error("The host returned an invalid status.");
  return value;
}

/**
 * The page of a relayed sign-in that the phone can open, or the key of why it cannot. The host
 * chose the page, so only a web page opens, and a page that returns to a loopback address must carry
 * `state`, which the pasted address must repeat.
 */
export function relayPage(
  address: string,
): { url: string; state: string | null; paste: boolean } | { error: MobileTextKey } {
  let page: URL;
  try {
    page = new URL(address);
  } catch {
    return { error: "mobile.server.providers.relayNotWebPage" };
  }
  if (page.protocol !== "https:") return { error: "mobile.server.providers.relayNotWebPage" };
  const state = page.searchParams.get("state");
  const returns = loopbackCallback(page.toString()) !== null;
  if (!state && returns) return { error: "mobile.server.providers.relayNoState" };
  return { url: page.toString(), state, paste: returns || state !== null };
}

/**
 * The Providers admin of one host (`providers-v1` to `providers-v5`, the `providers-v8` key routes,
 * `sign-in-relay-v1`, `provider-default-v1`, `custom-provider-harness-v1`, `provider-accounts-v1`,
 * the account relays, `acp-registry-v1` and `custom-agents-v1`), with the newest route set that the host serves. The
 * host checks the role on every route.
 */
export function createProviderAdmin(request: TeamApiRequest, capabilities: readonly string[]) {
  const has = (capability: string) => capabilities.includes(capability);
  const runtimeRoutes = has(PROVIDERS_V5_CAPABILITY)
    ? PROVIDERS_V5_ROUTES
    : has(PROVIDERS_V4_CAPABILITY)
      ? PROVIDERS_V4_ROUTES
      : has(PROVIDERS_RUNTIMES_V2_CAPABILITY)
        ? PROVIDERS_RUNTIMES_V2_ROUTES
        : PROVIDERS_ADMIN_ROUTES;
  const signInRoutes = has(PROVIDERS_V4_CAPABILITY)
    ? PROVIDERS_V4_ROUTES
    : has(PROVIDERS_SIGN_IN_V3_CAPABILITY)
      ? PROVIDERS_SIGN_IN_V3_ROUTES
      : PROVIDERS_ADMIN_ROUTES;
  // As on the web client: `providers-v8` keeps every key that `providers-v5` keeps, and the key-only providers.
  const keyRoutes = has(PROVIDERS_V8_CAPABILITY)
    ? PROVIDERS_V8_ROUTES
    : has(PROVIDERS_V5_CAPABILITY)
      ? PROVIDERS_V5_ROUTES
      : PROVIDERS_ADMIN_ROUTES;
  // As on the web client: the harness routes also name the provider that runs each endpoint.
  const accountRelay = providerAccountRelay(has);
  const ignore = () => undefined;
  return {
    capabilities,
    readStatus: (): Promise<AgentStatus> => request("GET", TEAM_API_ROUTES.agents.status, decodeAgentStatus),
    readRuntimes: (): Promise<ProviderRuntimeSnapshot> => runTeamRequest(getProviderRuntimes(request, runtimeRoutes)),
    download: (provider: ManagedProviderId) =>
      runTeamRequest(downloadProviderRuntime(request, provider, runtimeRoutes)),
    /** The host asks for the newest version of each runtime that it manages. */
    checkUpdates: () => runTeamRequest(checkProviderRuntimeUpdates(request, runtimeRoutes)),
    cancelDownload: (provider: ManagedProviderId) =>
      runTeamRequest(cancelProviderRuntime(request, provider, runtimeRoutes)),
    startCodeSignIn: (provider: AgentProviderId): Promise<ProviderCodeLoginStart> =>
      runTeamRequest(startProviderCodeLogin(request, provider, signInRoutes)),
    /** The code is a credential: it goes to the host in the body, and no reply carries it. */
    submitCode: (provider: AgentProviderId, code: string): Promise<AgentStatus> =>
      runTeamRequest(
        submitProviderCodeLogin(
          request,
          { provider, code },
          signInRoutes === PROVIDERS_V4_ROUTES ? signInRoutes : PROVIDERS_SIGN_IN_V3_ROUTES,
        ),
      ),
    cancelCodeSignIn: (provider: AgentProviderId): Promise<AgentStatus> =>
      runTeamRequest(cancelProviderCodeLogin(request, provider, signInRoutes)),
    startRelay: async (provider: AgentProviderId): Promise<string> => {
      if (!isOneOf(SIGN_IN_RELAY_PROVIDERS, provider))
        throw new Error(currentText().t("mobile.server.providers.signInUnsupported"));
      return (await runTeamRequest(startProviderSignInRelay(request, provider))).flowId;
    },
    relayStatus: (flowId: string): Promise<SignInRelayStatus> => runTeamRequest(signInRelayStatus(request, flowId)),
    /** `query` holds a grant. It goes only to the host, on the encrypted Team channel. */
    completeRelay: (flowId: string, query: string): Promise<SignInRelayStatus> =>
      runTeamRequest(completeSignInRelay(request, flowId, query)),
    cancelRelay: (flowId: string): Promise<AgentStatus> => runTeamRequest(cancelProviderSignInRelay(request, flowId)),
    keyState: async (provider: AgentProviderId): Promise<ProviderApiKeyStatus> =>
      (await runTeamRequest(getProviderApiKeyState(request, provider, keyRoutes))).status,
    /** Only the key's state comes back. The phone does not keep the key. */
    setKey: (provider: AgentProviderId, key: string): Promise<AgentStatus> =>
      runTeamRequest(setProviderApiKey(request, { provider, key }, keyRoutes)),
    clearKey: (provider: AgentProviderId): Promise<AgentStatus> =>
      runTeamRequest(clearProviderApiKey(request, provider, keyRoutes)),
    /** The endpoints of the host. A list says only whether an endpoint has a key. */
    /**
     * The key and the header values go to the host in the body, and no reply carries them. The host
     * has no edit route: a save adds an endpoint, and the host runs it on OpenCode.
     */
    /**
     * The accounts of the host's providers (`provider-accounts-v1`), or null when the host has none. A
     * new account signs in on the page that the host relays (`provider-account-relay-v1` or `-v2`); the
     * released `sign-in-relay-v1` routes then run the flow, as Connect does.
     */
    accounts: has(PROVIDER_ACCOUNTS_CAPABILITY)
      ? {
          list: (): Promise<HostProviderAccounts> => runTeamRequest(listProviderAccounts(request)),
          rename: (provider: AgentProviderId, accountId: string, label: string | null): Promise<void> =>
            runTeamRequest(renameProviderAccount(request, { provider, accountId, label })),
          remove: (provider: AgentProviderId, accountId: string): Promise<void> =>
            runTeamRequest(removeProviderAccount(request, { provider, accountId })),
          /** The phone signs in an account of the provider only on a page that the host relays. */
          canSignIn: (provider: AgentProviderId): boolean =>
            accountRelay !== null && isOneOf(accountRelay.providers, provider),
          /** `accountId: null` adds an account. A cancel removes a new account that did not sign in. */
          startRelay: async (provider: AgentProviderId, accountId: string | null): Promise<string> => {
            if (!accountRelay || !isOneOf(accountRelay.providers, provider))
              throw new Error(currentText().t("mobile.server.providers.signInUnsupported"));
            return (
              await runTeamRequest(startProviderAccountSignInRelay(request, accountRelay, { provider, accountId }))
            ).flowId;
          },
        }
      : null,
    /** Null when the host does not serve `provider-default-v1`. */
    defaultProvider: has(PROVIDER_DEFAULT_CAPABILITY)
      ? {
          read: (): Promise<HostProviderDefault> => runTeamRequest(getHostProviderDefault(request)),
          /** The provider's own default model, as the desktop Settings choice of a provider. */
          set: (provider: AgentProviderId): Promise<HostProviderDefault> =>
            runTeamRequest(setHostProviderDefault(request, provider, null)),
        }
      : null,
  };
}

export type ProviderAdmin = ReturnType<typeof createProviderAdmin>;
