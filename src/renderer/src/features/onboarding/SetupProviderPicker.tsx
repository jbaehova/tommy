import {
  AGENT_PROVIDER_DESCRIPTORS,
  type AgentProviderId,
  type AgentStatus,
  type ProviderRuntimeStatus,
} from "@tommy/contracts/ipc";
import type { AppTextKey } from "@tommy/i18n";
import {
  type ProviderConnection,
  ProviderPicker,
  type ProviderPickerOption,
} from "@tommy/ui/components/ProviderPicker";
import { freeModelsReady } from "@tommy/ui/components/provider-row";
import {
  isKeyDialogProvider,
  type KeyDialogProvider,
  OpenCodeKeyDialog,
  type ProviderKeyApi,
} from "@tommy/ui/features/settings/OpenCodeKeyDialog";
import { useText } from "@tommy/ui/text";
import { errorReference, type UserErrorDetails } from "@tommy/user-errors";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { ProviderSignInDialogs } from "../../components/ProviderSignInDialogs";
import type { ProviderConnectionApi } from "../../components/provider-connection-api";
import { onboardingProviderRows } from "./onboarding-provider-rows";
import { fallbackProviderState } from "./onboarding-provider-state";

/** The providers of this computer, and the actions on them, as both setup screens take them. */
export interface SetupProviderProps {
  agentStatus: AgentStatus;
  /**
   * The providers are those of a joined server's host. A provider that stays on its computer, such
   * as Cursor, then has a row only when the host's status lists it, as in Settings.
   */
  hostProviders?: boolean | undefined;
  refreshingProviders?: boolean | undefined;
  providerRuntimeStatuses?: Partial<Record<AgentProviderId, ProviderRuntimeStatus>> | undefined;
  /** The newer runtime main offers per provider; the row's actions menu offers it as in Settings. */
  providerAvailableVersions?: Partial<Record<AgentProviderId, string | null>> | undefined;
  onUpdateProvider?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  onCancelProviderSignIn?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  onDownloadProvider?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  onCancelProviderDownload?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  onInstallProvider?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  onSignInProvider?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  /**
   * Saves the optional OpenCode Go key. OpenCode runs free models without it, so its Connect row
   * button opens the key dialog rather than gating the step.
   */
  providerKeys?: ProviderKeyApi | undefined;
  /**
   * How each row signs in. First run needs its ⋯ menu most: the browser this computer opens is the
   * part of the hand-off that is most likely to be missing or wrong here.
   */
  connection?: ProviderConnectionApi | undefined;
  onRefreshProviders?: (() => void | Promise<void>) | undefined;
}

/** How a screen shows the providers. */
/** The choice a screen opens with. A review opens with the saved one; the first run with none. */
export interface SetupProviderChoice {
  provider: AgentProviderId | null;
}

// The line that the plan providers share. It tells nothing about one row, so those rows show their
// version there.
const INCLUDED_DESCRIPTION = "Included with Tommy";

const SETUP_PROVIDERS: Array<{ id: AgentProviderId; name: string; description: string | null }> =
  AGENT_PROVIDER_DESCRIPTORS.map((descriptor) => ({
    id: descriptor.id,
    name: descriptor.displayName,
    description: descriptor.onboardingDescription === INCLUDED_DESCRIPTION ? null : descriptor.onboardingDescription,
  }));

/**
 * The provider registry carries its onboarding line in English. A line that has no key here, such
 * as one a newer registry adds, shows as it is.
 */
const PROVIDER_DESCRIPTION_KEYS: Readonly<Record<string, AppTextKey>> = {
  "Free models, no account needed": "onboarding.provider.freeModels",
  "Google AI Pro or Ultra plan": "onboarding.provider.googlePlan",
  "Cursor plan or API key": "onboarding.provider.cursorPlan",
  "Free models with a Cline account": "onboarding.provider.clineAccount",
  "Kimi models with a Kimi Code account": "onboarding.provider.kimiAccount",
  "Mercury models with an Inception API key": "onboarding.provider.inceptionKey",
  "DeepSeek models with a DeepSeek API key": "onboarding.provider.deepseekKey",
  "Many models with an OpenRouter API key": "onboarding.provider.openrouterKey",
  "Nous Portal plan or your Hermes setup": "onboarding.provider.hermesNous",
};

/**
 * Whether setup can continue with this provider. A signed-in provider can; so can a downloaded
 * provider that runs free models, because it has no sign-in to wait for.
 */
function providerReady(option: ProviderPickerOption): boolean {
  return option.state === "available" || freeModelsReady(option);
}

export type SetupProviders = ReturnType<typeof createSetupProviders>;

/**
 * The provider step of setup: its rows, its choice, the actions on a row, and the errors those
 * actions leave. The first-run flow and the setup dialog both hold one, so a provider is chosen,
 * connected and added the same way on each.
 */
export function createSetupProviders(props: SetupProviderProps, initial?: SetupProviderChoice) {
  const { t } = useText();
  const [selectedProvider, setSelectedProvider] = createSignal<AgentProviderId | null>(initial?.provider ?? null);
  // A saved choice is the user's own, so the automatic choice below does not replace it.
  const [providerSelectedByUser, setProviderSelectedByUser] = createSignal(Boolean(initial?.provider));
  const [keyProvider, setKeyProvider] = createSignal<KeyDialogProvider | null>(null);
  const [error, setErrorText] = createSignal("");
  const [errorCode, setErrorCode] = createSignal<UserErrorDetails | null>(null);
  /** Shows `message`, with the code of `cause` when a failure gave one. */
  const setError = (message: string, cause?: unknown) => {
    setErrorText(message);
    const reference = cause === undefined ? null : errorReference(cause);
    setErrorCode(reference ? { message, reference } : null);
  };
  const [providerErrors, setProviderErrors] = createSignal<Partial<Record<AgentProviderId, string>>>({});
  const visibleError = createMemo(
    () => error() || SETUP_PROVIDERS.map((provider) => providerErrors()[provider.id]).find(Boolean) || "",
  );
  const previousConnectionStates = new Map<AgentProviderId, boolean>();
  const connectionStartingMessages = new Map<AgentProviderId, string | null>();
  const refreshedConnectionStates = new Set<AgentProviderId>();
  const providersAwaitingFocusRefresh = new Set<AgentProviderId>();
  let blurredAfterProviderConnect = false;
  let focusRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  const providerOptions = createMemo<ProviderPickerOption[]>(() =>
    SETUP_PROVIDERS.map((provider) => {
      const status = props.agentStatus.providers?.find((candidate) => candidate.id === provider.id);
      const runtime = props.providerRuntimeStatuses?.[provider.id];
      const descriptionKey = provider.description ? PROVIDER_DESCRIPTION_KEYS[provider.description] : undefined;
      return {
        ...provider,
        description: descriptionKey ? t(descriptionKey) : provider.description,
        state: status?.state ?? fallbackProviderState(props.agentStatus),
        message: status?.message,
        email: status?.email,
        connectionState: status?.connectionState,
        signInPending: status?.signInPending,
        checkError: status?.checkError,
        availableVersion: props.providerAvailableVersions?.[provider.id] ?? null,
        freeModels: false,
        callout: null,
        runtimeStatus:
          runtime?.phase === "not-downloaded" && (status?.state === "available" || status?.state === "sign-in-required")
            ? { ...runtime, phase: "ready", version: status.version }
            : runtime,
      };
    }),
  );
  /**
   * The plan rows that stay in the list, in their order, or `null` until the user first acts on the
   * list. Until then the row rule can change the list when the provider status arrives. After that,
   * a row never moves or goes away under the pointer.
   */
  const [keptProviders, setKeptProviders] = createSignal<AgentProviderId[] | null>(null);
  const providerRows = createMemo(() => {
    const kept = keptProviders();
    const rows = onboardingProviderRows(providerOptions(), kept ?? []);
    // A saved choice that the row rule hides still shows, after the rows the rule gives.
    const saved = initial?.provider;
    if (kept || !saved || rows.listed.some((option) => option.id === saved)) return rows;
    return onboardingProviderRows(providerOptions(), [...planRowIds(rows.listed), saved]);
  });

  /** Keeps the rows that the user sees now, and adds `provider` after them if it is not a row. */
  function keepProviderRows(provider?: AgentProviderId): void {
    const kept = keptProviders() ?? planRowIds(providerRows().listed);
    const next = provider && !kept.includes(provider) ? [...kept, provider] : kept;
    if (next !== keptProviders()) setKeptProviders(next);
  }

  /** Chooses a row, or a provider in "More providers", which then becomes a row. */
  function chooseProvider(provider: AgentProviderId): void {
    keepProviderRows(provider);
    setProviderSelectedByUser(true);
    setSelectedProvider(provider);
  }

  const selectedProviderConnected = createMemo(() => {
    const selected = selectedProvider();
    return Boolean(
      selected && providerOptions().some((provider) => provider.id === selected && providerReady(provider)),
    );
  });

  createEffect(
    () => ({
      options: providerOptions(),
      selected: selectedProvider(),
      selectedByUser: providerSelectedByUser(),
    }),
    ({ options, selected, selectedByUser }) => {
      if (selectedByUser && selected && options.some((provider) => provider.id === selected)) return;
      if (selected && options.some((provider) => provider.id === selected && providerReady(provider))) return;
      // A signed-in provider comes first, then one whose CLI is on the computer.
      const ready =
        options.find((provider) => provider.state === "available") ??
        options.find((provider) => provider.state === "sign-in-required" && !provider.freeModels) ??
        options.find((provider) => providerReady(provider));
      setSelectedProvider(ready?.id ?? null);
    },
  );

  createEffect(
    () => props.agentStatus.providers,
    (providers) => {
      for (const provider of SETUP_PROVIDERS) {
        const status = providers?.find((candidate) => candidate.id === provider.id);
        const connecting = status?.connectionState === "connecting";
        const wasConnecting = previousConnectionStates.get(provider.id) ?? false;
        if (wasConnecting && !connecting) {
          const startingMessage = connectionStartingMessages.get(provider.id) ?? null;
          if (refreshedConnectionStates.delete(provider.id)) {
            setProviderErrors((current) => ({ ...current, [provider.id]: undefined }));
          } else {
            setProviderErrors((current) => ({
              ...current,
              [provider.id]: status?.message && status.message !== startingMessage ? status.message : undefined,
            }));
          }
          connectionStartingMessages.delete(provider.id);
          if (status?.state === "available") providersAwaitingFocusRefresh.delete(provider.id);
        }
        previousConnectionStates.set(provider.id, connecting);
      }
    },
  );

  const handleWindowBlur = (): void => {
    if (providersAwaitingFocusRefresh.size > 0) blurredAfterProviderConnect = true;
  };
  const handleWindowFocus = (): void => {
    if (!blurredAfterProviderConnect || providersAwaitingFocusRefresh.size === 0 || focusRefreshTimer) return;
    const synchronize = (): void => {
      focusRefreshTimer = undefined;
      if (props.refreshingProviders) {
        focusRefreshTimer = setTimeout(synchronize, 250);
        return;
      }
      // A refresh cancels a sign-in that Tommy runs, such as Gemini's Google sign-in. The browser
      // takes focus, so the user often comes back before the sign-in is complete. That sign-in
      // reports its own result.
      const signingIn = props.agentStatus.providers?.some(
        (status) => providersAwaitingFocusRefresh.has(status.id) && status.connectionState === "connecting",
      );
      if (signingIn) {
        blurredAfterProviderConnect = false;
        return;
      }
      providersAwaitingFocusRefresh.clear();
      blurredAfterProviderConnect = false;
      void refreshProviders();
    };
    focusRefreshTimer = setTimeout(synchronize, 250);
  };
  window.addEventListener("blur", handleWindowBlur);
  window.addEventListener("focus", handleWindowFocus);

  onCleanup(() => {
    window.removeEventListener("blur", handleWindowBlur);
    window.removeEventListener("focus", handleWindowFocus);
    if (focusRefreshTimer) clearTimeout(focusRefreshTimer);
  });

  function providerName(provider: AgentProviderId): string {
    return (
      SETUP_PROVIDERS.find((candidate) => candidate.id === provider)?.name ?? t("onboarding.provider.fallbackName")
    );
  }

  async function openProviderGuide(
    provider: AgentProviderId,
    action: ((provider: AgentProviderId) => void | Promise<void>) | undefined,
    kind: "install" | "sign-in",
  ): Promise<void> {
    if (!action) return;
    keepProviderRows();
    setError("");
    try {
      await action(provider);
    } catch (cause) {
      setError(
        kind === "install"
          ? t("onboarding.error.installGuide", { provider: providerName(provider) })
          : t("onboarding.error.signInGuide", { provider: providerName(provider) }),
        cause,
      );
    }
  }

  /**
   * OpenCode, Muse and Gemini sign in with a pasted key, so their rows open the key dialog; the rest
   * open a guide. Claude's and Codex's keys are an option on their Providers page, so their Sign in
   * stays the guide.
   */
  function signInProvider(provider: AgentProviderId): void {
    if (isKeyDialogProvider(provider) && provider !== "claude" && provider !== "codex" && props.providerKeys) {
      setKeyProvider(provider);
      return;
    }
    void openProviderGuide(provider, props.onSignInProvider, "sign-in");
  }

  /** Resolves `false` when the request failed; the error then says why. */
  function connectProvider(provider: AgentProviderId): Promise<boolean> {
    return followSignIn(provider, (connection) => connection.connect(provider));
  }

  async function followSignIn(
    provider: AgentProviderId,
    start: (connection: ProviderConnectionApi) => Promise<void>,
  ): Promise<boolean> {
    const connection = props.connection;
    const kind = connection?.connectKind(provider);
    if (!connection || !kind || props.refreshingProviders) return true;
    // A dialog sign-in reports itself in its dialog. The browser sign-in reports in the row.
    if (kind === "dialog") {
      await start(connection);
      return true;
    }
    keepProviderRows();
    setError("");
    setProviderErrors((current) => ({ ...current, [provider]: undefined }));
    providersAwaitingFocusRefresh.add(provider);
    refreshedConnectionStates.delete(provider);
    connectionStartingMessages.set(
      provider,
      props.agentStatus.providers?.find((candidate) => candidate.id === provider)?.message ?? null,
    );
    try {
      await start(connection);
      return true;
    } catch (cause) {
      providersAwaitingFocusRefresh.delete(provider);
      setError(t("onboarding.error.connect", { provider: providerName(provider) }), cause);
      return false;
    }
  }

  /** Resolves `false` when the request failed; the error then says why. */
  async function downloadProvider(provider: AgentProviderId): Promise<boolean> {
    if (!props.onDownloadProvider) return true;
    keepProviderRows();
    setError("");
    setProviderErrors((current) => ({ ...current, [provider]: undefined }));
    setProviderSelectedByUser(true);
    setSelectedProvider(provider);
    try {
      await props.onDownloadProvider(provider);
      return true;
    } catch (cause) {
      setError(t("onboarding.error.download", { provider: providerName(provider) }), cause);
      return false;
    }
  }

  async function cancelProviderDownload(provider: AgentProviderId): Promise<void> {
    if (!props.onCancelProviderDownload) return;
    setError("");
    try {
      await props.onCancelProviderDownload(provider);
    } catch (cause) {
      setError(t("onboarding.error.cancelDownload", { provider: providerName(provider) }), cause);
    }
  }

  async function refreshProviders(): Promise<void> {
    if (!props.onRefreshProviders || props.refreshingProviders) return;
    setError("");
    setProviderErrors({});
    for (const provider of SETUP_PROVIDERS) {
      if (previousConnectionStates.get(provider.id)) refreshedConnectionStates.add(provider.id);
      previousConnectionStates.set(provider.id, false);
      connectionStartingMessages.delete(provider.id);
    }
    try {
      await props.onRefreshProviders();
    } catch (cause) {
      setError(t("onboarding.error.refresh"), cause);
    }
  }

  return {
    props,
    options: providerOptions,
    rows: providerRows,
    selectedProvider,
    selectedProviderConnected,
    /** A provider action's error, or the message of a connection that ended without success. */
    error: visibleError,
    /** The code of the shown error, when a failure gave one. */
    errorReference: () => {
      const code = errorCode();
      return code && code.message === visibleError() ? code.reference : null;
    },
    setError,
    clearErrors: () => {
      setError("");
      setProviderErrors({});
    },
    keyProvider,
    closeKeyDialog: () => setKeyProvider(null),
    chooseProvider,
    signInProvider,
    connectProvider,
    downloadProvider,
    /** Forgets the user's choice, so the step chooses again from the rows it shows. */
    clearChoice: () => {
      setProviderSelectedByUser(false);
      setSelectedProvider(null);
    },
    cancelProviderDownload,
    refreshProviders,
    openProviderGuide,
  };
}

function planRowIds(listed: readonly ProviderPickerOption[]): AgentProviderId[] {
  return listed.map((option) => option.id);
}

export interface SetupProviderPickerProps {
  providers: SetupProviders;
  ariaLabel: string;
  label: string;
  hint: string;
  disabled: boolean;
  /** Where the row menus mount. A screen on the dialog layer passes itself, or they paint behind it. */
  menuMount: HTMLElement | undefined;
}

/** The provider list of setup, with the dialogs its rows open. */
export function SetupProviderPicker(props: SetupProviderPickerProps) {
  const { t } = useText();
  const source = () => props.providers.props;
  const lazyProviderMode = () => Boolean(source().providerRuntimeStatuses || source().onDownloadProvider);
  /** The rows' Connect goes through the step, which follows the browser sign-in it starts. */
  const connection = createMemo((): ProviderConnection | undefined => {
    const api = source().connection;
    return api
      ? {
          connectKind: api.connectKind,
          alternativeKind: api.alternativeKind,
          alternative: api.alternative,
          connect: async (provider) => {
            await props.providers.connectProvider(provider);
          },
        }
      : undefined;
  });
  return (
    <>
      <ProviderPicker
        value={props.providers.selectedProvider()}
        options={props.providers.rows().listed}
        ariaLabel={props.ariaLabel}
        label={props.label}
        hint={props.hint}
        allowUnavailableSelection
        focusFirst
        disabled={props.disabled}
        refreshingProviders={source().refreshingProviders}
        connection={connection()}
        onCancelProviderSignIn={source().onCancelProviderSignIn}
        onDownloadProvider={
          source().onDownloadProvider
            ? async (provider) => {
                await props.providers.downloadProvider(provider);
              }
            : undefined
        }
        onCancelProviderDownload={
          source().onCancelProviderDownload ? props.providers.cancelProviderDownload : undefined
        }
        onInstallProvider={
          source().onInstallProvider
            ? (provider) => props.providers.openProviderGuide(provider, source().onInstallProvider, "install")
            : undefined
        }
        onSignInProvider={
          source().onSignInProvider || source().providerKeys ? props.providers.signInProvider : undefined
        }
        onUpdateProvider={source().onUpdateProvider}
        menuMount={props.menuMount}
        onRefreshProviders={
          !lazyProviderMode() && source().onRefreshProviders ? props.providers.refreshProviders : undefined
        }
        moreProviders={props.providers.rows().hidden}
        versionInDetail
        moreCallout={{
          title: t("onboarding.provider.moreTitle"),
          detail: t("onboarding.provider.moreDetail"),
        }}
        onChooseMoreProvider={props.providers.chooseProvider}
        onChange={props.providers.chooseProvider}
      />
      <Show when={props.providers.keyProvider()} keyed>
        {(provider) => (
          <Show when={source().providerKeys}>
            {(api) => (
              <OpenCodeKeyDialog
                api={api()}
                provider={provider}
                onClose={props.providers.closeKeyDialog}
                onReconnect={
                  source().connection?.connectKind(provider) === "browser"
                    ? async () => {
                        await props.providers.connectProvider(provider);
                      }
                    : undefined
                }
              />
            )}
          </Show>
        )}
      </Show>
      {/* Sits beside the picker it was started from, so the code covers the row rather
          than a step the user has not reached. */}
      <ProviderSignInDialogs api={source().connection} />
    </>
  );
}
