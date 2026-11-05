import type { ServerSummary } from "@tommy/contracts/ipc";
import { BROWSER_PROFILES_CAPABILITY } from "@tommy/contracts/team-protocol/browser-profiles-v1";
import { VAULT_CAPABILITY } from "@tommy/contracts/team-protocol/vault-v1";
import { VAULT_V2_CAPABILITY } from "@tommy/contracts/team-protocol/vault-v2";
import { isAgentAccount } from "@tommy/ui/components/provider-accounts";
import { sidebarAgentOrder } from "@tommy/ui/features/sidebar/sidebar-agent-order";
import { currentText } from "@tommy/ui/text";
import { createMemo, Loading, onSettled, Show, untrack } from "solid-js";
import { actionToast } from "./action-toast";
import { appPort } from "./app-port";
import { useAgents } from "./features/agents/agents-context";
import { desktopBrowserProfileCalls } from "./features/browser/browser-profiles-port";
import { createBrowserProfilesStore } from "./features/browser/stores/browser-profiles-store";
import { conversationPort } from "./features/conversation/conversation-port";
import type { ServerStorageOptions } from "./features/files/ServerStoragePanel";
import { useSetup } from "./features/onboarding/onboarding-context";
import { mcpToolRuntimeNote } from "./features/servers/mcp-servers";
import { remoteMcpSignIn, serverCanAdminister, serverSupportsCapability } from "./features/servers/server-capabilities";
import { useServerSelection } from "./features/servers/server-selection";
import { useServerSettings } from "./features/servers/server-settings";
import { useServerSwitch } from "./features/servers/server-switch";
import { useServers } from "./features/servers/servers-context";
import type { HostProviderSettings } from "./features/settings/ProviderSettingsSection";
import { useSettings } from "./features/settings/settings-context";
import { useSidebar } from "./features/sidebar/sidebar-context";
import { usePlanLimitRows } from "./features/usage/plan-limit-rows";
import { createVaultStore } from "./features/vault/stores/vault-store";
import { desktopVaultCalls, hostVaultCalls } from "./features/vault/vault-port";
import { useWindowPage } from "./features/window/window-page-context";
import { useGlobalSearchSources } from "./global-search-sources";
import { SettingsModal } from "./lazy-views";
import { useNavigation } from "./navigation";
import { usePlatform } from "./platform";
import { useProviders } from "./providers";
import { ChannelCreateOverlay, GlobalSearchOverlay, ServerSettingsOverlay } from "./WorkspaceOverlayViews";

/**
 * Everything the workspace raises over itself: modals, dialogs and the two
 * full-window takeovers.
 *
 * They are one module because they share a shape rather than a domain - each is
 * one open flag over one lazily loaded chunk, none of them is laid out by the
 * frame, and none of them reads another - and separate components inside it for
 * the same reason the panes are separate files: an overlay should see the
 * domains it opens over and no others. They stay here rather than in seven
 * single-use modules at the renderer root because each is a dozen lines of
 * wiring, and the list of what can cover the workspace is worth reading in one
 * place.
 *
 * The overlays the web client also raises are views in `WorkspaceOverlayViews`, which take props:
 * the components here read the desktop contexts and pass them on.
 */
export function WorkspaceOverlays() {
  return (
    <>
      <ServerSettings />
      <AppSettings />
      <GlobalMessageSearch />
      <ChannelCreateOverlay />
    </>
  );
}

/**
 * Settings for one server, which is any server on the rail rather than the
 * active one - hence the target held by the domain instead of `activeServer()`.
 */
function ServerSettings() {
  const windowPage = useWindowPage();
  const usageRows = usePlanLimitRows();
  const platform = usePlatform();
  const { hostStatus } = useServers();
  const { selectAgent, selectGlobalSearchMessage } = useNavigation();
  const { selectServer } = useServerSelection();
  const { setPendingAgentSelection } = useServerSwitch();
  const { agentList, agentStatus } = useAgents();
  const { setupState, saveSetup } = useSetup();
  const {
    toolRuntimeStatuses,
    providerAdminServerId,
    providerRuntimeStatuses,
    providerAvailableVersions,
    providerRuntimeDownloadsAvailable,
    downloadProviderRuntime,
    startProviderUpdate,
    cancelProviderRuntimeDownload,
    cancelProviderSignIn,
    openProviderInstallGuide,
    setProviderOn,
    measureProviderDownload,
    removeProviderDownload,
    providerAccounts,
    restartProvider,
    cancelProviderRestart,
    connection,
    providerKeys,
  } = useProviders();
  /**
   * Whether the tool runtimes the providers context holds are this server's: this computer's, or,
   * over `providers-v1`, those of the host of the joined server on screen.
   */
  const holdsToolRuntimes = (server: ServerSummary) =>
    server.kind === "local" ? providerAdminServerId() === undefined : server.id === providerAdminServerId();
  const {
    openServerSettings,
    serverSettingsTarget,
    serverSettingsSection,
    serverSettingsOpen,
    setServerSettingsOpen,
    serverSettingsRestoreTarget,
    serverSettingsLoading,
    serverSettingsError,
    refreshServerSettings,
    saveServerIdentity,
    serverSettingsMcp,
    serverSettingsMcpError,
    serverSettingsMcpSignIns,
    serverSettingsMcpSignInRequest,
    clearMcpSignInRequest,
    serverSettingsMcpAddRequest,
    clearMcpAddRequest,
    serverSettingsMcpSignInPages,
    serverSettingsMcpSignInRelays,
    openMcpSignInRelay,
    pasteMcpSignInRelay,
    signInMcpServer,
    cancelMcpSignIn,
    signOutMcpServer,
    mcpSignInApp,
    saveMcpSignInApp,
    removeMcpSignInApp,
    refreshMcpServers,
    saveMcpServer,
    removeMcpServer,
    setMcpServerEnabled,
    testMcpServer,
  } = useServerSettings();
  /**
   * The named browser profiles of the selected server: this computer, or a joined server whose host
   * serves `browser-profiles-v1` to this owner or admin. One store per server, so the list of the
   * last server never shows for the next. The section lists them each time it opens.
   */
  const browserProfileServerId = createMemo(() => serverSettingsTarget()?.id);
  const browserProfiles = createMemo(() => {
    const calls = desktopBrowserProfileCalls(browserProfileServerId());
    return createBrowserProfilesStore(() => calls);
  });
  /**
   * The Vault of the selected server: this computer, or a joined server whose host serves `vault-v1`
   * to this owner or admin. One store per server, so the items of the last server never show for the next.
   */
  const vaultServerId = createMemo(() => {
    const target = serverSettingsTarget();
    return serverCanAdminister(target, VAULT_CAPABILITY) ? target.id : undefined;
  });
  // A host that updates or rolls back keeps its id, so the API key kind follows this capability too.
  const vaultApiKeys = createMemo(() => serverCanAdminister(serverSettingsTarget(), VAULT_V2_CAPABILITY));
  const vault = createMemo(() => {
    const serverId = vaultServerId();
    if (serverId === undefined) return undefined;
    const local = untrack(serverSettingsTarget)?.kind === "local";
    return {
      store: createVaultStore(local ? desktopVaultCalls() : hostVaultCalls(serverId)),
      apiKeys: vaultApiKeys(),
    };
  });
  // The workspace belongs to the selected server. For another server, the switch comes first and
  // the agent is published for the scope it lands in; a message there opens as its agent's chat.
  const openOnServer = (server: ServerSummary, agentId: string, open: () => void) => {
    setServerSettingsOpen(false);
    if (server.active) return open();
    void selectServer(server.id).then((selected) => {
      if (selected) setPendingAgentSelection(agentId);
    });
  };

  /**
   * The providers of the computer the agents of `server` run on: this one, or the host of a joined
   * server that the account administers over `providers-v1`. The provider state belongs to the
   * selected server only, so it is read only while `server` is the selected one.
   */
  const providerSettings = (server: ServerSummary): HostProviderSettings | undefined => {
    const local = server.kind === "local";
    if (!server.active || (!local && server.id !== providerAdminServerId())) return undefined;
    /**
     * A named endpoint merges into the `opencode acp` process of that computer. This does not need
     * `providerRuntimeDownloadsAvailable()`: a build without managed runtime downloads still has custom endpoints.
     */
    return {
      get defaultProvider() {
        const state = setupState();
        return local && state ? { ...state, save: saveSetup } : undefined;
      },
      get agentStatus() {
        return agentStatus();
      },
      get providerRuntimeStatuses() {
        return providerRuntimeDownloadsAvailable() ? providerRuntimeStatuses() : undefined;
      },
      get providerAvailableVersions() {
        return providerRuntimeDownloadsAvailable() ? providerAvailableVersions() : undefined;
      },
      get onUpdateProvider() {
        return providerRuntimeDownloadsAvailable() ? startProviderUpdate : undefined;
      },
      get onDownloadProvider() {
        return providerRuntimeDownloadsAvailable() ? downloadProviderRuntime : undefined;
      },
      get onCancelProviderDownload() {
        return providerRuntimeDownloadsAvailable() ? cancelProviderRuntimeDownload : undefined;
      },
      get providerKeys() {
        return providerRuntimeDownloadsAvailable() ? providerKeys() : undefined;
      },
      get connection() {
        return providerRuntimeDownloadsAvailable() ? connection : undefined;
      },
      // The browser sign-in, the install guide, the scan and custom agents are of this computer.
      get onCancelProviderSignIn() {
        return local && providerRuntimeDownloadsAvailable() ? cancelProviderSignIn : undefined;
      },
      get onInstallProvider() {
        return local && providerRuntimeDownloadsAvailable() ? openProviderInstallGuide : undefined;
      },
      onSetProviderOn: local ? setProviderOn : undefined,
      onMeasureProviderDownload: local ? measureProviderDownload : undefined,
      onRemoveProviderDownload: local ? removeProviderDownload : undefined,
      get providerUsers() {
        return Object.fromEntries(
          (agentStatus().providers ?? []).map((provider) => [
            provider.id,
            agentList()
              .filter((agent) => agent.provider === provider.id)
              .map((agent) => agent.name),
          ]),
        );
      },
      get providerAccountUsers() {
        return Object.fromEntries(
          (agentStatus().providers ?? []).map((provider) => [
            provider.id,
            Object.fromEntries(
              (provider.accounts ?? []).map((account) => [
                account.id,
                agentList()
                  .filter(
                    (agent) => agent.provider === provider.id && isAgentAccount(agent.providerAccountId, account.id),
                  )
                  .map((agent) => agent.name),
              ]),
            ),
          ]),
        );
      },
      // The active server's accounts: a joined host offers them only with `provider-accounts-v1`.
      get accountActions() {
        return providerAccounts();
      },
      // The readings are of the active server, which is the only server with a Providers tab.
      get usage() {
        return usageRows();
      },
      onRestartProvider: local ? restartProvider : undefined,
      onCancelProviderRestart: local ? cancelProviderRestart : undefined,
    };
  };

  /**
   * Another server's providers are managed after a switch to it, in its own Providers section. A
   * failed switch shows the error and opens the section again, with its switch button.
   */
  const switchToManageProviders = (server: ServerSummary) => {
    setServerSettingsOpen(false);
    void selectServer(server.id).then(
      (selected) => {
        if (selected) openServerSettings(server.id, null, "providers");
      },
      (error: unknown) => {
        const text = currentText();
        actionToast.error(text.t("server.select.failedTitle"), {
          ...{
            description: text.errorMessage(error, text.t("server.select.failedDescription")),
          },
        });
        openServerSettings(server.id, null, "providers");
      },
    );
  };

  const storageOptions = (server: ServerSummary): Omit<ServerStorageOptions, "canManage"> => ({
    hostName:
      server.kind === "local"
        ? platform.appInfo()?.platform === "darwin"
          ? currentText().t("app.host.thisMac")
          : currentText().t("app.host.thisComputer")
        : server.name,
    onOpenAgent: (agentId) => openOnServer(server, agentId, () => selectAgent(agentId)),
    onShowMessage: (agentId, messageId) =>
      openOnServer(server, agentId, () => selectGlobalSearchMessage(agentId, messageId)),
  });

  return (
    <Show when={serverSettingsTarget()}>
      {(server) => (
        <ServerSettingsOverlay
          // The settings show only as a page of the window, so they wait for the page.
          open={serverSettingsOpen() && windowPage.settingsPlacement("server") !== undefined}
          page={windowPage.settingsPlacement("server")}
          restoreFocusTarget={serverSettingsRestoreTarget()}
          platform={platform.appInfo()?.platform ?? "darwin"}
          server={server()}
          hostStatus={server().kind === "local" ? hostStatus() : null}
          loading={serverSettingsLoading()}
          loadError={serverSettingsError()}
          onRetry={() => refreshServerSettings(server().id)}
          onSaveIdentity={saveServerIdentity}
          mcpServers={serverSettingsMcp()}
          // Only for the computer whose runtimes this window holds: another host starts its servers
          // with its own runtime, which this window has not read.
          mcpToolRuntimeNote={holdsToolRuntimes(server()) ? mcpToolRuntimeNote(toolRuntimeStatuses().bun) : null}
          mcpLoadError={serverSettingsMcpError()}
          onMcpSectionShown={() => void refreshMcpServers()}
          onRetryMcpServers={() => void refreshMcpServers()}
          onSaveMcpServer={saveMcpServer}
          onRemoveMcpServer={removeMcpServer}
          onSetMcpServerEnabled={setMcpServerEnabled}
          onTestMcpServer={testMcpServer}
          mcpAddRequest={serverSettingsMcpAddRequest()}
          onMcpAddRequestHandled={clearMcpAddRequest}
          // A remote host with `sign-in-relay-v1` opens the page in this computer's browser. An older
          // host's page shows here through the live view, which streams the active server only.
          mcpSignInRequest={serverSettingsMcpSignInRequest()}
          onMcpSignInRequestHandled={clearMcpSignInRequest}
          mcpSignIn={
            server().kind === "local" || remoteMcpSignIn(server())
              ? {
                  states: serverSettingsMcpSignIns(),
                  remote:
                    server().kind === "remote"
                      ? {
                          hostName: server().name,
                          runtime: conversationPort().browser,
                          clipboard: serverSupportsCapability(server(), "browser-view-clipboard"),
                          pages: serverSettingsMcpSignInPages(),
                          relay: serverSupportsCapability(server(), "sign-in-relay-v1")
                            ? {
                                pages: serverSettingsMcpSignInRelays(),
                                open: openMcpSignInRelay,
                                paste: pasteMcpSignInRelay,
                              }
                            : undefined,
                        }
                      : undefined,
                  start: signInMcpServer,
                  cancel: cancelMcpSignIn,
                  signOut: signOutMcpServer,
                  app: serverSupportsCapability(server(), "mcp-sign-in-app-v1")
                    ? { load: mcpSignInApp, save: saveMcpSignInApp, remove: removeMcpSignInApp }
                    : undefined,
                }
              : undefined
          }
          storage={storageOptions(server())}
          providers={providerSettings(server())}
          onSwitchToManageProviders={
            !server().active && serverCanAdminister(server(), "providers-v1")
              ? () => switchToManageProviders(server())
              : undefined
          }
          hostTimezone={{}}
          hostMemoryLimit={{}}
          memoryReview={{}}
          hostPromptCacheTtl={{}}
          initialSection={serverSettingsSection()}
          // Owners and admins move this computer's server, or a remote host with `instance-transfer-v1`.
          instanceTransfer={
            server().kind === "local"
              ? { onSignIn: (provider) => void connection.connect(provider) }
              : serverCanAdminister(server(), "instance-transfer-v1")
                ? {}
                : undefined
          }
          // The feed listens on this computer, so a calendar app on another one cannot read it.
          routineFeed={
            server().kind === "local"
              ? { api: appPort().routineFeed, listAgents: () => appPort().agent.listAgents(server().id) }
              : undefined
          }
          browserProfiles={
            serverCanAdminister(server(), BROWSER_PROFILES_CAPABILITY)
              ? { store: browserProfiles(), listAgents: () => appPort().agent.listAgents(server().id) }
              : undefined
          }
          vault={vault()}
        />
      )}
    </Show>
  );
}

/**
 * Application settings, shown as a page of the window. The only overlay without a
 * `<Show>`: the settings own their open state and wait for the page placement.
 */
function AppSettings() {
  const windowPage = useWindowPage();
  const platform = usePlatform();
  const { servers, setServerMuted, setServerNotificationLevel } = useServers();
  const {
    appSettingsOpen,
    notificationFocusRequest,
    appSettingsTab,
    generalSettings,
    builtInDisplayGeometry,
    updateGeneralSettings,
    appSettingsRestoreTarget,
    sendTestNotification,
    openNotificationSettings,
    preferencesLoadFailed,
    reloadPreferences,
  } = useSettings();
  return (
    <Loading>
      <SettingsModal
        // The settings show only as a page of the window, so they wait for the page.
        open={appSettingsOpen() && windowPage.settingsPlacement("personal") !== undefined}
        page={windowPage.settingsPlacement("personal")}
        value={generalSettings()}
        onValueChange={updateGeneralSettings}
        preferencesLoadFailed={preferencesLoadFailed()}
        onRetryPreferencesLoad={reloadPreferences}
        appInfo={platform.appInfo()}
        chatWindow={platform.chatWindow !== null}
        builtInDisplayGeometry={builtInDisplayGeometry()}
        servers={servers()}
        onTestNotification={sendTestNotification}
        onOpenNotificationSettings={openNotificationSettings}
        onSetServerNotificationLevel={setServerNotificationLevel}
        onSetServerMuted={setServerMuted}
        notificationFocusRequest={notificationFocusRequest()}
        restoreFocusTarget={appSettingsRestoreTarget()}
        openTab={appSettingsTab()}
      />
    </Loading>
  );
}

/** Search across the agents, channels, conversations, routines and commands of the active server. */
function GlobalMessageSearch() {
  const { agentList, userHiddenAgentIds } = useAgents();
  const { sidebarLayout, pinnedSidebarItems } = useSidebar();
  // In sidebar order, so that ⌘1-9 opens the agents the user put at the top.
  const agents = createMemo(() =>
    sidebarAgentOrder(agentList(), {
      layout: sidebarLayout(),
      pinnedItems: pinnedSidebarItems(),
      hiddenAgentIds: userHiddenAgentIds(),
    }),
  );
  const { globalSearchOpen, searchGlobalMessages, setGlobalSearchVisibility, selectAgent, selectGlobalSearchMessage } =
    useNavigation();
  const sources = useGlobalSearchSources(globalSearchOpen);
  // Cmd+1 to Cmd+9 open the agents in sidebar order. Ctrl on other systems.
  onSettled(() => {
    const select = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || !/^[1-9]$/.test(event.key)) return;
      const agent = agents()[Number(event.key) - 1];
      if (!agent) return;
      event.preventDefault();
      selectAgent(agent.id);
    };
    window.addEventListener("keydown", select);
    return () => window.removeEventListener("keydown", select);
  });

  return (
    <GlobalSearchOverlay
      open={globalSearchOpen()}
      agents={agents()}
      channels={sources.channels()}
      routines={sources.routines()}
      routinesLoading={sources.routinesLoading()}
      actions={sources.actions()}
      onSearchMessages={searchGlobalMessages}
      onSearchFiles={sources.searchFiles()}
      onOpenChange={setGlobalSearchVisibility}
      onSelectAgent={selectAgent}
      onSelectChannel={sources.openChannel}
      onSelectMessage={selectGlobalSearchMessage}
      onSelectRoutine={sources.selectRoutine}
    />
  );
}
