import type {
  AvatarImageInput,
  McpServerConfig,
  McpSignInAppState,
  McpSignInRelayPage,
  McpSignInState,
  McpTestResult,
  SaveMcpSignInAppInput,
  ServerSummary,
  TeamPresenceMember,
} from "@tommy/contracts/ipc";
import { currentText } from "@tommy/ui/text";
import { createEffect, createMemo, createSignal, flush } from "solid-js";
import { createSimpleContext } from "../../simple-context";
import { mcpSignInRecord } from "./mcp-servers";
import type { ServerSettingsSection } from "./ServerSettingsModal";
import { serverCanAdminister, serverRoleCanAdminister, serverSupportsCapability } from "./server-capabilities";
import { useServers } from "./servers-context";
import { serverAdminPort, serversPort } from "./servers-port";

/**
 * The settings page for one server: its identity, whether it is published,
 * and who can reach it.
 *
 * Global rather than scoped to the active server, and deliberately so - the
 * server rail opens this for *any* server in the list, so `openServerSettings`
 * takes an id. Scoping it to the active server would break opening the settings
 * of a server the user has not switched to.
 *
 * Ungated - the dialog is closed until someone opens it, and `refreshServerSettings`
 * carries its own loading and error signals for what happens after that.
 *
 * Every mutation ends in `refreshServerSettings(server.id)` rather than patching
 * the lists it just changed: main is the authority on membership, and a failed
 * write must not leave a row the server never accepted. The `operationSucceeded`
 * latch in each is what keeps a failure *after* the write from being reported as
 * a failed write.
 */
/** How often the panel asks which host tab shows a remote sign-in page. */
const MCP_SIGN_IN_PAGE_POLL_MS = 1_000;

function withMcpSignInPage(pages: Record<string, string>, url: string, tabId: string | null): Record<string, string> {
  if (pages[url] === (tabId ?? undefined)) return pages;
  const { [url]: _previous, ...rest } = pages;
  return tabId ? { ...rest, [url]: tabId } : rest;
}

const ServerSettings = createSimpleContext({
  name: "Server settings",
  init: () => {
    const { servers, setServers, hostStatus, setHostStatus } = useServers();
    const [serverSettingsTargetId, setServerSettingsTargetId] = createSignal<string | null>(null);
    /** The section an opener asked for, such as Updates from the host version notice. */
    const [serverSettingsSection, setServerSettingsSection] = createSignal<ServerSettingsSection | null>(null);
    const [serverSettingsOpen, setServerSettingsOpen] = createSignal(false);
    /** Counts each open request, so the settings page can tell a new request for the open server. */
    const [serverSettingsOpenRequest, setServerSettingsOpenRequest] = createSignal(0);
    const [serverSettingsMembers, setServerSettingsMembers] = createSignal<TeamPresenceMember[]>([]);
    const [serverSettingsLoading, setServerSettingsLoading] = createSignal(false);
    const [serverSettingsError, setServerSettingsError] = createSignal<string | null>(null);
    const [serverSettingsMcp, setServerSettingsMcp] = createSignal<McpServerConfig[]>([]);
    const [serverSettingsMcpError, setServerSettingsMcpError] = createSignal<string | null>(null);
    /** Which http rows the server holds a sign-in for, by id. Empty for a host without `mcp-sign-in-v1`. */
    const [serverSettingsMcpSignIns, setServerSettingsMcpSignIns] = createSignal<Record<string, McpSignInState>>({});
    /** The host tab of each remote sign-in page, by the address it signs in to, while the sign-in waits. */
    const [serverSettingsMcpSignInPages, setServerSettingsMcpSignInPages] = createSignal<Record<string, string>>({});
    /** The relayed sign-in page of each remote sign-in that waits in this computer's browser (`sign-in-relay-v1`). */
    const [serverSettingsMcpSignInRelays, setServerSettingsMcpSignInRelays] = createSignal<
      Record<string, McpSignInRelayPage>
    >({});
    /** The MCP row whose sign-in an agent's card asked for, until the MCP section starts it. */
    const [serverSettingsMcpSignInRequest, setServerSettingsMcpSignInRequest] = createSignal<string | null>(null);
    /** Set when the Marketplace asked for the form that adds a server, until the MCP section opens it. */
    const [serverSettingsMcpAddRequest, setServerSettingsMcpAddRequest] = createSignal(false);
    /** Bumped by every open and refresh, so a slower earlier load cannot paint over a newer one. */
    let serverSettingsRequest = 0;
    /**
     * The same guard for the MCP list, counted separately. The two loads start from different
     * events - a presence update refreshes the settings, opening the section reads the MCP list -
     * so one counter would let either one discard the other's reply and its cleanup.
     */
    let serverSettingsMcpRequest = 0;
    let serverSettingsRestoreTarget: HTMLElement | null = null;

    const serverSettingsTarget = createMemo(() => servers().find((server) => server.id === serverSettingsTargetId()));
    createEffect(
      () => ({ open: serverSettingsOpen(), id: serverSettingsTargetId() }),
      ({ open, id }) => {
        if (!open || !id) return;
        let previous = "";
        return serversPort().servers.onPresence((presence) => {
          // Typing updates must not read the account API again. Membership and
          // online changes are enough to refresh an accepted invitation.
          const signature = JSON.stringify(
            presence.members.map((member) => [member.id, member.role, member.disabled, member.online]),
          );
          if (signature === previous) return;
          previous = signature;
          flush(() => setServerSettingsMembers(presence.members));
          void refreshServerSettings(id);
        }, id);
      },
    );

    async function refreshServerSettings(serverId = serverSettingsTargetId()): Promise<void> {
      if (!serverId) return;
      const request = ++serverSettingsRequest;
      setServerSettingsLoading(true);
      setServerSettingsError(null);
      try {
        let server = servers().find((item) => item.id === serverId);
        if (!server) throw new Error(currentText().t("server.settings.unavailable"));
        let identityError: string | null = null;
        if (server.kind === "remote") {
          try {
            const refreshed = await serversPort().servers.refreshIdentity(serverId);
            setServers((current) => current.map((item) => (item.id === serverId ? refreshed : item)));
            server = refreshed;
          } catch (error) {
            const text = currentText();
            identityError = text.errorMessage(error, text.t("server.settings.identityRefreshFailed"));
          }
        }
        const canManage = server.kind === "local" ? hostStatus().configured : serverRoleCanAdminister(server);
        const canUseNetwork = server.kind === "local" || server.state === "online";
        const admin = serverAdminPort(server);
        const [presence, members] = await Promise.all([
          admin.getPresence(),
          canManage && canUseNetwork ? admin.listMembers() : Promise.resolve(null),
        ]);
        if (request !== serverSettingsRequest || serverSettingsTargetId() !== serverId) return;
        const presenceById = new Map(presence.members.map((member) => [member.id, member]));
        setServerSettingsMembers(
          (members ?? presence.members).map((member) => ({
            ...member,
            online: presenceById.get(member.id)?.online ?? false,
            typingAgentId: presenceById.get(member.id)?.typingAgentId ?? null,
          })),
        );
        if (identityError) setServerSettingsError(identityError);
      } catch (error) {
        if (request === serverSettingsRequest && serverSettingsTargetId() === serverId) {
          const text = currentText();
          setServerSettingsError(text.errorMessage(error, text.t("server.settings.loadFailed")));
        }
      } finally {
        if (request === serverSettingsRequest) setServerSettingsLoading(false);
      }
    }

    function openServerSettings(
      serverId: string,
      trigger: HTMLElement | null,
      section: ServerSettingsSection | null = null,
    ): void {
      serverSettingsRequest += 1;
      setServerSettingsSection(section);
      serverSettingsMcpRequest += 1;
      serverSettingsRestoreTarget = trigger;
      setServerSettingsTargetId(serverId);
      setServerSettingsOpen(true);
      setServerSettingsOpenRequest((count) => count + 1);
      setServerSettingsMembers([]);
      setServerSettingsMcp([]);
      setServerSettingsMcpError(null);
      setServerSettingsMcpSignIns({});
      setServerSettingsMcpSignInRequest(null);
      setServerSettingsMcpAddRequest(false);
      setServerSettingsError(null);
      void refreshServerSettings(serverId);
    }

    /** Opens the MCP section of a server and signs in to one of its rows, as its Sign in button does. */
    function openMcpSignIn(serverId: string, mcpServerId: string, trigger: HTMLElement | null): void {
      openServerSettings(serverId, trigger, "mcp");
      setServerSettingsMcpSignInRequest(mcpServerId);
    }

    /** Opens the MCP section of a server on the form that adds a server, as its Add button does. */
    function openMcpAdd(serverId: string, trigger: HTMLElement | null): void {
      openServerSettings(serverId, trigger, "mcp");
      setServerSettingsMcpAddRequest(true);
    }

    async function saveServerIdentity(input: { serverName: string; logo?: AvatarImageInput | null }): Promise<void> {
      const server = serverSettingsTarget();
      if (!serverCanAdminister(server, "host-admin-v1"))
        throw new Error(currentText().t("server.settings.identityLocalOnly"));
      const serverKind = server.kind;
      try {
        if (serverKind === "local") {
          const status = hostStatus().configured
            ? await serversPort().host.updateIdentity(input)
            : await serversPort().host.configure(input);
          setHostStatus(status);
        } else {
          await serversPort().hostAdmin.updateIdentity(input, server.id);
        }
        setServers(await serversPort().servers.list());
        await refreshServerSettings(server.id);
      } catch (error) {
        throw error;
      }
    }

    /**
     * The MCP list.
     *
     * It is read when the MCP section opens, not when the dialog opens, because most visits to this
     * dialog never reach that section. Nothing connects here: Tommy connects only when the user
     * asks for a test, and the providers make their own connections when an agent starts.
     */
    async function refreshMcpServers(): Promise<void> {
      const server = serverSettingsTarget();
      if (!server) return;
      const request = ++serverSettingsMcpRequest;
      const current = (): boolean => request === serverSettingsMcpRequest && serverSettingsTargetId() === server.id;
      try {
        const [configs, signIns] = await Promise.all([
          serversPort().agent.listMcpServers(server.id),
          listMcpSignIns(server),
        ]);
        if (!current()) return;
        setServerSettingsMcp(configs);
        setServerSettingsMcpSignIns(signIns);
        setServerSettingsMcpError(null);
      } catch (error) {
        // Reported in the panel rather than thrown: the callers ask for this list on a section
        // change, where nothing is waiting for the promise and an unreported failure would leave
        // the panel saying the server has no MCP servers at all.
        if (current()) {
          const text = currentText();
          setServerSettingsMcpError(text.errorMessage(error, text.t("mcp.server.loadFailed")));
        }
      }
    }

    /**
     * One test connection, for the configuration the user is looking at. The configuration is sent
     * whole rather than by id, so the form can test a draft that was never saved. The answer is not
     * stored: the panel holds it while it is open, and it says nothing about any later moment.
     */
    async function testMcpServer(config: McpServerConfig): Promise<McpTestResult> {
      const server = serverSettingsTarget();
      if (!server) throw new Error(currentText().t("server.settings.unavailable"));
      const result = await serversPort().agent.testMcpServer({ config }, server.id);
      return result;
    }

    /** Which http rows the server holds a sign-in for. A host without `mcp-sign-in-v1` answers none. */
    async function listMcpSignIns(server: ServerSummary): Promise<Record<string, McpSignInState>> {
      // A badge beside the list, not the list: a failed read shows no badge rather than failing the
      // list read, or reporting a save that already landed as failed.
      return serversPort()
        .agent.listMcpSignIns(server.id)
        .then(mcpSignInRecord, () => ({}));
    }

    /**
     * Opens the browser when the server asks; the answer comes once the browser came back. A remote
     * host opens the page in its own browser, and the panel shows that tab while the sign-in waits.
     */
    async function signInMcpServer(config: McpServerConfig): Promise<McpTestResult> {
      const server = serverSettingsTarget();
      if (!server) throw new Error(currentText().t("server.settings.unavailable"));
      let waiting = true;
      const signIn = serversPort().agent.signInMcpServer({ config }, server.id);
      if (server.kind === "remote") {
        if (serverSupportsCapability(server, "sign-in-relay-v1"))
          void followMcpSignInRelay(server.id, config.url, () => waiting);
        else void followMcpSignInPage(server.id, config.url, () => waiting);
      }
      const result = await signIn.finally(() => {
        waiting = false;
      });
      const signIns = await listMcpSignIns(server);
      if (serverSettingsTargetId() === server.id) setServerSettingsMcpSignIns(signIns);
      return result;
    }

    /** Reads which host tab shows the sign-in page until the sign-in ends; the host opens it a moment after start. */
    async function followMcpSignInPage(serverId: string, url: string, waiting: () => boolean): Promise<void> {
      try {
        while (waiting()) {
          const tabId = await serversPort()
            .agent.mcpSignInPage({ url }, serverId)
            .catch(() => null);
          if (!waiting()) return;
          setServerSettingsMcpSignInPages((pages) => withMcpSignInPage(pages, url, tabId));
          await new Promise((resolve) => setTimeout(resolve, MCP_SIGN_IN_PAGE_POLL_MS));
        }
      } finally {
        setServerSettingsMcpSignInPages((pages) => withMcpSignInPage(pages, url, null));
      }
    }

    /** Reads the relayed page of a sign-in until it ends. The page opens when the user asks. */
    async function followMcpSignInRelay(serverId: string, url: string, waiting: () => boolean): Promise<void> {
      const set = (page: McpSignInRelayPage | null) =>
        setServerSettingsMcpSignInRelays((pages) => {
          const { [url]: _previous, ...rest } = pages;
          return page ? { ...rest, [url]: page } : rest;
        });
      try {
        while (waiting()) {
          const page = await serversPort()
            .agent.mcpSignInRelay({ url }, serverId)
            .catch(() => null);
          if (!waiting()) return;
          const current = serverSettingsMcpSignInRelays()[url];
          if (current?.authorizeHost !== page?.authorizeHost || current?.listening !== page?.listening) set(page);
          await new Promise((resolve) => setTimeout(resolve, MCP_SIGN_IN_PAGE_POLL_MS));
        }
      } finally {
        set(null);
      }
    }

    /** Opens a relayed sign-in page in this computer's browser, after the user checked its host name. */
    async function openMcpSignInRelay(url: string): Promise<void> {
      const server = serverSettingsTarget();
      if (!server) throw new Error(currentText().t("server.settings.unavailable"));
      await serversPort().agent.openMcpSignInRelay({ url }, server.id);
    }

    /** The address the browser shows at the end of a relayed sign-in. Main sends only its query to the host. */
    async function pasteMcpSignInRelay(url: string, address: string): Promise<void> {
      const server = serverSettingsTarget();
      if (!server) throw new Error(currentText().t("server.settings.unavailable"));
      await serversPort().agent.completeMcpSignInRelay({ url, address }, server.id);
    }

    async function cancelMcpSignIn(url: string): Promise<void> {
      const server = serverSettingsTarget();
      if (!server) throw new Error(currentText().t("server.settings.unavailable"));
      await serversPort().agent.cancelMcpSignIn({ url }, server.id);
    }

    async function signOutMcpServer(mcpServerId: string): Promise<void> {
      const server = serverSettingsTarget();
      if (!server) throw new Error(currentText().t("server.settings.unavailable"));
      const states = await serversPort().agent.signOutMcpServer({ mcpServerId }, server.id);
      if (serverSettingsTargetId() === server.id) setServerSettingsMcpSignIns(mcpSignInRecord(states));
    }

    /** The OAuth app of a saved http row. The answer says only whether a secret is saved. */
    async function mcpSignInApp(mcpServerId: string): Promise<McpSignInAppState> {
      const server = serverSettingsTarget();
      if (!server) throw new Error(currentText().t("server.settings.unavailable"));
      return serversPort().agent.mcpSignInApp({ mcpServerId }, server.id);
    }

    async function saveMcpSignInApp(input: SaveMcpSignInAppInput): Promise<McpSignInAppState> {
      return changeMcpSignInApp((serverId) => serversPort().agent.saveMcpSignInApp(input, serverId));
    }

    async function removeMcpSignInApp(mcpServerId: string): Promise<McpSignInAppState> {
      return changeMcpSignInApp((serverId) => serversPort().agent.removeMcpSignInApp({ mcpServerId }, serverId));
    }

    /** A changed or removed app drops the sign-in that the old client held, so the badges are read again. */
    async function changeMcpSignInApp(
      change: (serverId: string) => Promise<McpSignInAppState>,
    ): Promise<McpSignInAppState> {
      const server = serverSettingsTarget();
      if (!server) throw new Error(currentText().t("server.settings.unavailable"));
      const state = await change(server.id);
      const signIns = await listMcpSignIns(server);
      if (serverSettingsTargetId() === server.id) setServerSettingsMcpSignIns(signIns);
      return state;
    }

    async function saveMcpServer(config: McpServerConfig): Promise<void> {
      await runMcpMutation((serverId) => serversPort().agent.saveMcpServer({ config }, serverId));
    }

    async function removeMcpServer(mcpServerId: string): Promise<void> {
      await runMcpMutation((serverId) => serversPort().agent.removeMcpServer({ mcpServerId }, serverId));
    }

    async function setMcpServerEnabled(mcpServerId: string, enabled: boolean): Promise<void> {
      await runMcpMutation((serverId) => serversPort().agent.setMcpServerEnabled({ mcpServerId, enabled }, serverId));
    }

    /**
     * Main answers every mutation with the whole list, so the rows are taken from the reply rather
     * than patched. The `operationSucceeded` latch keeps a failure after the write from being
     * reported as a failed write, as every other mutation in this file does.
     */
    async function runMcpMutation(mutate: (serverId: string) => Promise<McpServerConfig[]>): Promise<void> {
      const server = serverSettingsTarget();
      if (!server) throw new Error(currentText().t("server.settings.unavailable"));
      try {
        const configs = await mutate(server.id);
        if (serverSettingsTargetId() !== server.id) return;
        // A read that is still in flight started before this write and would answer with the list
        // as it was, putting a removed server back or showing the old enabled state. The reply
        // carries the whole list, so nothing is lost by dropping that read.
        serverSettingsMcpRequest += 1;
        setServerSettingsMcp(configs);
        setServerSettingsMcpError(null);
        // A saved row can name an address this computer is already signed in to.
        const signIns = await listMcpSignIns(server);
        if (serverSettingsTargetId() === server.id) setServerSettingsMcpSignIns(signIns);
      } catch (error) {
        throw error;
      }
    }

    return {
      serverSettingsTarget,
      serverSettingsSection,
      serverSettingsOpen,
      setServerSettingsOpen,
      serverSettingsOpenRequest,
      serverSettingsRestoreTarget: () => serverSettingsRestoreTarget,
      serverSettingsMembers,
      serverSettingsLoading,
      serverSettingsError,
      openServerSettings,
      refreshServerSettings,
      saveServerIdentity,
      serverSettingsMcp,
      serverSettingsMcpError,
      serverSettingsMcpSignIns,
      serverSettingsTargetId,
      serverSettingsMcpSignInRequest,
      clearMcpSignInRequest: () => setServerSettingsMcpSignInRequest(null),
      openMcpSignIn,
      serverSettingsMcpAddRequest,
      clearMcpAddRequest: () => setServerSettingsMcpAddRequest(false),
      openMcpAdd,
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
    };
  },
});

export const ServerSettingsProvider = ServerSettings.provider;
export const useServerSettings = ServerSettings.use;
