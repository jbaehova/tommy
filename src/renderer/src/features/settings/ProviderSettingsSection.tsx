import {
  type AgentModelId,
  type AgentProviderId,
  type AgentStatus,
  type AppSetupState,
  agentProviderName,
  type ProviderApiKeyStatus,
  type ProviderRuntimeDownload,
  type ProviderRuntimeStatus,
} from "@tommy/contracts/ipc";
import { Text } from "@tommy/ui";
import type { ProviderAccountActions } from "@tommy/ui/components/provider-accounts";
import type { AccountUsageProviderRow } from "@tommy/ui/features/account/account-usage-view";
import {
  isKeyDialogProvider,
  type KeyDialogProvider,
  OpenCodeKeyDialog,
  type ProviderKeyApi,
} from "@tommy/ui/features/settings/OpenCodeKeyDialog";
import {
  type ProviderDefaultChoice,
  type ProviderPromptCache,
  type ProviderSettingsDetail,
  ProviderSettingsPage,
} from "@tommy/ui/features/settings/ProviderSettingsPage";
import { useText } from "@tommy/ui/text";
import { createEffect, createSignal, createStore, Show, untrack } from "solid-js";
import { ProviderSignInDialogs } from "../../components/ProviderSignInDialogs";
import type { ProviderConnectionApi } from "../../components/provider-connection-api";
import { createProviderPromptCache, type ProviderPromptCacheSource } from "./provider-prompt-cache";
import { createSettingsGeneralStore, type SettingsGeneralStore } from "./stores/general-store";

interface DefaultProviderSettings extends Pick<AppSetupState, "preferredProvider" | "preferredModel"> {
  save: (provider: AgentProviderId, model?: AgentModelId | null) => Promise<void>;
}

interface ProviderSettingsSectionProps {
  defaultProvider?: DefaultProviderSettings | undefined;
  store: SettingsGeneralStore;
  /** The dialog element the Select popovers portal into, captured when the section was created. */
  selectMount: HTMLElement | undefined;
  onDownloadProvider?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  onCancelProviderDownload?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  onUpdateProvider?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  onRestartProvider?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  onCancelProviderRestart?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  onSetProviderOn?: ((provider: AgentProviderId, on: boolean) => void | Promise<void>) | undefined;
  onMeasureProviderDownload?: ((provider: AgentProviderId) => Promise<ProviderRuntimeDownload>) | undefined;
  onRemoveProviderDownload?: ((provider: AgentProviderId) => Promise<void>) | undefined;
  onInstallProvider?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  onCancelProviderSignIn?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  onSignInProvider?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  /** Adds, names and removes the accounts of each provider that can hold more than one. */
  accountActions?: ProviderAccountActions | undefined;
  /** The sign-ins that a row's Connect and ⋯ menu run. Absent in the stories, where no provider answers it. */
  connection?: ProviderConnectionApi | undefined;
  usage?: readonly AccountUsageProviderRow[] | undefined;
  onDetailChange?: ((detail: ProviderSettingsDetail | null) => void) | undefined;
  promptCache?: ProviderPromptCache | undefined;
}

/** The provider list of the computer the agents run on. */
function ProviderSettingsSection(props: ProviderSettingsSectionProps) {
  const i18n = useText();
  const [saving, setSaving] = createStore<{ pending: { provider: AgentProviderId } | null; error: string }>({
    pending: null,
    error: "",
  });
  const [downloadError, setDownloadError] = createSignal("");
  async function selectProvider(provider: AgentProviderId): Promise<void> {
    if (saving.pending) return;
    const choice = props.defaultProvider;
    if (!choice) return;
    setSaving(() => ({ pending: { provider }, error: "" }));
    try {
      await choice.save(provider, undefined);
    } catch (error) {
      setSaving((state) => {
        state.error = i18n.errorMessage(error, i18n.t("onboarding.setup.saveFailed"));
      });
    } finally {
      setSaving((state) => {
        state.pending = null;
      });
    }
  }
  /** A first download that fails rejects with no notification of its own, so its reason is shown here. */
  async function downloadProvider(provider: AgentProviderId): Promise<void> {
    const download = props.onDownloadProvider;
    if (!download) return;
    setDownloadError("");
    try {
      await download(provider);
    } catch (error) {
      setDownloadError(
        i18n.errorMessage(error, i18n.t("onboarding.error.download", { provider: agentProviderName(provider) })),
      );
    }
  }

  return (
    // The tab title already names this list, so it has no heading of its own.
    <div class="settings-provider-section">
      <ProviderSettingsPage
        options={props.store.providerOptions()}
        defaultProvider={
          props.defaultProvider
            ? {
                get value(): ProviderDefaultChoice | null {
                  return saving.pending?.provider ?? props.defaultProvider?.preferredProvider ?? null;
                },
                get pending() {
                  return Boolean(saving.pending);
                },
                onChange: (choice: ProviderDefaultChoice) => void selectProvider(choice),
              }
            : undefined
        }
        disabled={Boolean(saving.pending)}
        usage={props.usage}
        onDownloadProvider={props.onDownloadProvider ? downloadProvider : undefined}
        onCancelProviderDownload={props.onCancelProviderDownload}
        onUpdateProvider={props.onUpdateProvider}
        onRestartProvider={props.onRestartProvider}
        onCancelProviderRestart={props.onCancelProviderRestart}
        onSetProviderOn={props.onSetProviderOn}
        onMeasureProviderDownload={props.onMeasureProviderDownload}
        onRemoveProviderDownload={props.onRemoveProviderDownload}
        connection={props.connection}
        onCancelProviderSignIn={props.onCancelProviderSignIn}
        onInstallProvider={props.onInstallProvider}
        onSignInProvider={props.onSignInProvider}
        accountActions={props.accountActions}
        menuMount={props.selectMount}
        onDetailChange={props.onDetailChange}
        promptCache={props.promptCache}
      />
      <Show when={saving.error}>
        <Text role="alert">{saving.error}</Text>
      </Show>
      <Show when={downloadError()}>
        <Text role="alert">{downloadError()}</Text>
      </Show>
    </div>
  );
}

/**
 * Whether the OpenCode key dialog is open, and whether the key is saved, for the row's badge.
 *
 * The badge is read through the key API like the dialog does, on open and after the dialog closes
 * with a save or a removal. Absent until the first read, and on a read failure, so the row shows no
 * key badge rather than a wrong one.
 */
function createProviderKeyState(props: { readonly open: boolean; readonly providerKeys?: ProviderKeyApi | undefined }) {
  const [keyDialogOpen, setKeyDialogOpen] = createSignal(false);
  const [keyProvider, setKeyProvider] = createSignal<KeyDialogProvider>("claude");
  const [claudeKeyStatus, setClaudeKeyStatus] = createSignal<ProviderApiKeyStatus | undefined>(undefined);
  async function readKeyStatus(keys: ProviderKeyApi, provider: AgentProviderId) {
    try {
      return (await keys.getProviderApiKeyState(provider)).status;
    } catch {
      return undefined;
    }
  }
  async function refreshKeyStatus(): Promise<void> {
    const keys = props.providerKeys;
    if (!keys) return;
    const claude = keys.readsClaudeKey ? await readKeyStatus(keys, "claude") : undefined;
    // An answer from a source the modal has since left belongs to the other computer.
    if (keys !== props.providerKeys) return;
    setClaudeKeyStatus(claude);
  }
  // The badge has to answer on first paint: the key state arrives after the rows, so an open
  // without a read would show no badge until something else re-renders the list. The keys can move
  // to a joined server's host while the modal is open, when that host's admin role arrives, so a
  // new source is read again rather than keeping the other computer's answer.
  createEffect(
    () => (props.open ? props.providerKeys : undefined),
    (keys) => {
      setClaudeKeyStatus(undefined);
      if (keys) void untrack(refreshKeyStatus);
    },
  );
  return {
    keyDialogOpen,
    keyProvider,
    claudeKeyStatus,
    /**
     * Only the providers whose sign-in can be a pasted key are served: OpenCode, Muse, Gemini, Claude
     * and, on this computer, Codex. Claude's Sign in also lands here on an older host, which would
     * store the key and never read it.
     */
    openKeyDialog(provider: AgentProviderId): void {
      if (isKeyDialogProvider(provider) && (provider !== "claude" || props.providerKeys?.readsClaudeKey)) {
        setKeyProvider(provider);
        setKeyDialogOpen(true);
      }
    },
    closeKeyDialog(): void {
      setKeyDialogOpen(false);
      void refreshKeyStatus();
    },
  };
}

type ProviderKeyState = ReturnType<typeof createProviderKeyState>;

/** The key and sign-in dialogs the section opens. Both portal over the dialog they open from. */
function ProviderSettingsDialogs(props: {
  keys: ProviderKeyState;
  providerKeys?: ProviderKeyApi | undefined;
  connection?: ProviderConnectionApi | undefined;
}) {
  return (
    <>
      <Show when={props.keys.keyDialogOpen() && props.providerKeys}>
        {(api) => (
          <OpenCodeKeyDialog
            api={api()}
            provider={props.keys.keyProvider()}
            onClose={props.keys.closeKeyDialog}
            onReconnect={
              // The reconnect asks the provider again, which only this computer's browser sign-in does.
              props.connection?.connectKind(props.keys.keyProvider()) === "browser"
                ? () => props.connection?.connect(props.keys.keyProvider())
                : undefined
            }
          />
        )}
      </Show>
      <ProviderSignInDialogs api={props.connection} />
    </>
  );
}

/** The providers of one server's computer, as its server settings section takes them. */
export interface HostProviderSettings {
  /** Saved default for new local agents. Remote host settings do not change this computer's default. */
  defaultProvider?: DefaultProviderSettings | undefined;
  agentStatus: AgentStatus;
  providerRuntimeStatuses?: Partial<Record<AgentProviderId, ProviderRuntimeStatus>> | undefined;
  providerAvailableVersions?: Partial<Record<AgentProviderId, string | null>> | undefined;
  onDownloadProvider?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  onCancelProviderDownload?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  onUpdateProvider?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  /** The provider restart is of this computer, so only its section has it. */
  onRestartProvider?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  onCancelProviderRestart?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  /**
   * The stories can supply off providers. Production reads the saved switches from agentStatus.
   */
  offProviders?: readonly AgentProviderId[] | undefined;
  /** The names of the agents that use each provider. A provider with one stays on. */
  providerUsers?: Partial<Record<AgentProviderId, readonly string[]>> | undefined;
  /** The names of the agents that use each account, by provider and account. */
  providerAccountUsers?: Partial<Record<AgentProviderId, Readonly<Record<string, readonly string[]>>>> | undefined;
  /** Adds, names and removes provider accounts on the computer that runs the providers. */
  accountActions?: ProviderAccountActions | undefined;
  onSetProviderOn?: ((provider: AgentProviderId, on: boolean) => void | Promise<void>) | undefined;
  onMeasureProviderDownload?: ((provider: AgentProviderId) => Promise<ProviderRuntimeDownload>) | undefined;
  onRemoveProviderDownload?: ((provider: AgentProviderId) => Promise<void>) | undefined;
  providerKeys?: ProviderKeyApi | undefined;
  /** How each row signs in, from where the user connects. */
  connection?: ProviderConnectionApi | undefined;
  /** The browser sign-in and the install guide open on this computer, so only its section has them. */
  onCancelProviderSignIn?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  onInstallProvider?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  /** Called each time the section is shown, for the scan of this computer. */
  onShown?: (() => void) | undefined;
  /** The usage readings of each account, for the badge of an account that is low. */
  usage?: readonly AccountUsageProviderRow[] | undefined;
}

/**
 * The whole Providers section for a server: its list, and the dialogs it opens. Without `hostName`
 * the providers are this computer's.
 */
export function HostProviderSettingsPanel(
  props: HostProviderSettings & {
    hostName?: string | undefined;
    selectMount: HTMLElement | undefined;
    onDetailChange?: ((detail: ProviderSettingsDetail | null) => void) | undefined;
    /** The Claude page's prompt cache time, for a host with `prompt-cache-ttl-v1` that this account administers. */
    promptCache?: ProviderPromptCacheSource | undefined;
  },
) {
  const promptCache = createProviderPromptCache(() => props.promptCache);
  const keys = createProviderKeyState({
    open: true,
    get providerKeys() {
      return props.providerKeys;
    },
  });
  const store = createSettingsGeneralStore({
    get agentStatus() {
      return props.agentStatus;
    },
    get providerRuntimeStatuses() {
      return props.providerRuntimeStatuses;
    },
    get providerAvailableVersions() {
      return props.providerAvailableVersions;
    },
    claudeKeyStatus: keys.claudeKeyStatus,
    get providerHostName() {
      return props.hostName;
    },
    get offProviders() {
      return props.offProviders;
    },
    get providerUsers() {
      return props.providerUsers;
    },
    get providerAccountUsers() {
      return props.providerAccountUsers;
    },
  });
  return (
    <>
      <ProviderSettingsSection
        defaultProvider={props.defaultProvider}
        store={store}
        selectMount={props.selectMount}
        onDownloadProvider={props.onDownloadProvider}
        onCancelProviderDownload={props.onCancelProviderDownload}
        onUpdateProvider={props.onUpdateProvider}
        onRestartProvider={props.onRestartProvider}
        onCancelProviderRestart={props.onCancelProviderRestart}
        onSetProviderOn={props.onSetProviderOn}
        onMeasureProviderDownload={props.onMeasureProviderDownload}
        onRemoveProviderDownload={props.onRemoveProviderDownload}
        connection={props.connection}
        onCancelProviderSignIn={props.onCancelProviderSignIn}
        onInstallProvider={props.onInstallProvider}
        accountActions={props.accountActions}
        onSignInProvider={props.providerKeys ? keys.openKeyDialog : undefined}
        usage={props.usage}
        onDetailChange={props.onDetailChange}
        promptCache={promptCache()}
      />
      <ProviderSettingsDialogs keys={keys} providerKeys={props.providerKeys} connection={props.connection} />
    </>
  );
}
