import type { BrowserProfileProxyInput, BrowserProfileProxySummary } from "@tommy/contracts/browser-profile-proxy";
import {
  type AgentBrowserProfile,
  type BrowserProfileList,
  type BrowserProfileSummary,
  type BrowserTabProfile,
  type ClearBrowserDataInput,
  LOCAL_SERVER_ID,
  type UpdateAgentBrowserProfileInput,
  type UpdateBrowserProfileInput,
} from "@tommy/contracts/ipc";

/**
 * The browser profiles of one server, and the profile of each of its agents. Desktop reaches them
 * through main for this computer and for a joined server; the web client asks the host directly.
 */
export interface BrowserProfileProxyCalls {
  get(profileId: string): Promise<BrowserProfileProxySummary>;
  set(input: BrowserProfileProxyInput): Promise<BrowserProfileProxySummary>;
}

export interface BrowserProfileCalls {
  proxy?: BrowserProfileProxyCalls | undefined;
  list(): Promise<BrowserProfileList>;
  create(name: string): Promise<BrowserProfileSummary>;
  update(input: UpdateBrowserProfileInput): Promise<BrowserProfileSummary>;
  clear(input: ClearBrowserDataInput): Promise<void>;
  remove(profileId: string): Promise<void>;
  readAgent(agentId: string): Promise<AgentBrowserProfile>;
  updateAgent(input: UpdateAgentBrowserProfileInput): Promise<AgentBrowserProfile>;
  /** The profile of each open tab that is not in the shared session. */
  tabProfiles(): Promise<BrowserTabProfile[]>;
  /**
   * Calls `listener` each time the host reports a change of its profiles or of an agent's profile,
   * also one made on another device. Absent when the host does not report changes.
   */
  onChanged?(listener: () => void): () => void;
}

/** The desktop calls for one server. Reads `window.tommy` on each call: stories replace it per case. */
export function desktopBrowserProfileCalls(serverId?: string): BrowserProfileCalls {
  const agent = () => window.tommy.agent;
  const eventServerId = serverId ?? LOCAL_SERVER_ID;
  return {
    list: () => agent().listBrowserProfiles(serverId),
    proxy: {
      get: (profileId) => agent().getBrowserProfileProxy(profileId, serverId),
      set: (input) => agent().setBrowserProfileProxy(input, serverId),
    },
    create: (name) => agent().createBrowserProfile(name, serverId),
    update: (input) => agent().updateBrowserProfile(input, serverId),
    clear: (input) => agent().clearBrowserData(input, serverId),
    remove: (profileId) => agent().deleteBrowserProfile(profileId, serverId),
    readAgent: (agentId) => agent().getAgentBrowserProfile(agentId, serverId),
    updateAgent: (input) => agent().updateAgentBrowserProfile(input, serverId),
    tabProfiles: () => agent().listBrowserTabProfiles(serverId),
    onChanged: (listener) =>
      agent().onScopedEvent((scoped) => {
        if (scoped.serverId === eventServerId && scoped.event.type === "browser-profiles-changed") listener();
      }),
  };
}
