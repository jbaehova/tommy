import type { ServerSummary, TommyDesktopApi } from "@tommy/contracts/ipc";

/**
 * What the servers domain reaches in main: the server list and selection, the account changes, the local host, the
 * settings of one server, the name, logo and update of a joined server's host, the servers that
 * run on this computer, and the remote desktop setup of a server.
 */
export interface ServersPort {
  agent: Pick<
    TommyDesktopApi["agent"],
    | "getStatus"
    | "listAgents"
    | "listConversationReads"
    | "listHiddenAgents"
    | "listMcpServers"
    | "listModels"
    | "removeMcpServer"
    | "saveMcpServer"
    | "setMcpServerEnabled"
    | "testMcpServer"
    | "signInMcpServer"
    | "mcpSignInPage"
    | "mcpSignInRelay"
    | "openMcpSignInRelay"
    | "completeMcpSignInRelay"
    | "cancelMcpSignIn"
    | "signOutMcpServer"
    | "listMcpSignIns"
    | "mcpSignInApp"
    | "saveMcpSignInApp"
    | "removeMcpSignInApp"
  >;
  events: TommyDesktopApi["events"];
  auth: Pick<TommyDesktopApi["auth"], "onEvent">;
  browser: Pick<TommyDesktopApi["browser"], "setVisible">;
  hostAdmin: Pick<TommyDesktopApi["hostAdmin"], "cancelUpdate" | "getUpdateStatus" | "startUpdate" | "updateIdentity">;
  host: Pick<TommyDesktopApi["host"], "configure" | "getStatus" | "onEvent" | "start" | "stop" | "updateIdentity">;
  notifications: Pick<TommyDesktopApi["notifications"], "onOpened">;
  servers: Pick<
    TommyDesktopApi["servers"],
    | "getPresenceFor"
    | "list"
    | "onEvent"
    | "onPresence"
    | "refreshIdentity"
    | "retryConnection"
    | "select"
    | "setMuted"
    | "setNotificationLevel"
  >;
}

/** Read on each call: tests and stories replace `window.tommy` per case. */
export function serversPort(): ServersPort {
  return window.tommy;
}

/** The member reads for one server. */
export type ServerAdminPort = Pick<TommyDesktopApi["host"], "getPresence" | "listMembers">;

export function serverAdminPort(server: Pick<ServerSummary, "id" | "kind">): ServerAdminPort {
  if (server.kind === "local") return window.tommy.host;
  const serverId = server.id;
  return {
    getPresence: () => window.tommy.servers.getPresenceFor(serverId),
    listMembers: () => window.tommy.servers.listMembers(serverId),
  };
}
