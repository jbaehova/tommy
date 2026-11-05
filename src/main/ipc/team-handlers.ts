import { type HostStatus, LOCAL_SERVER_ID, type ServerSummary } from "@tommy/contracts/ipc";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { HostService } from "../host-service";
import type { RemoteServerManager } from "../remote-server-manager";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { routeToServer } from "./route-to-server";
import {
  parseHostConfig,
  parseHostIdentity,
  parseSetServerMuted,
  parseSetServerNotificationLevel,
  parseSetTeamTyping,
} from "./server-inputs";
import { stringPayload } from "./validation";

interface TeamIpcDependencies {
  host: HostService;
  remoteServers: RemoteServerManager;
}

export function teamIpcHandlers({
  host,
  remoteServers,
}: TeamIpcDependencies): Pick<IpcGroupHandlers, "servers" | "host"> {
  return {
    servers: {
      setMuted: payloadHandler(parseSetServerMuted, ({ serverId, muted, durationMs }) =>
        runCauseEffect(remoteServers.setMuted(serverId, muted, durationMs)).then((servers) =>
          withLocalHostSummary(servers, host.getStatus()),
        ),
      ),
      setNotificationLevel: payloadHandler(parseSetServerNotificationLevel, ({ serverId, level }) =>
        runCauseEffect(remoteServers.setNotificationLevel(serverId, level)).then((servers) =>
          withLocalHostSummary(servers, host.getStatus()),
        ),
      ),
      list: handler(() => withLocalHostSummary(remoteServers.list(), host.getStatus())),
      select: payloadHandler(stringPayload("serverId"), (serverId) =>
        runCauseEffect(remoteServers.select(serverId)).then((servers) =>
          withLocalHostSummary(servers, host.getStatus()),
        ),
      ),
      retryConnection: payloadHandler(stringPayload("serverId"), (serverId) =>
        runCauseEffect(remoteServers.retryConnection(serverId)),
      ),
      getPresence: handler(() =>
        routeToServer(remoteServers.activeServerId, {
          local: () => host.getPresence(),
          remote: () => remoteServers.getPresence(),
        }),
      ),
      getPresenceFor: payloadHandler(stringPayload("serverId"), (serverId) =>
        routeToServer(serverId, {
          local: () => host.getPresence(),
          remote: (target) => runCauseEffect(remoteServers.getPresenceFor(target)),
        }),
      ),
      refreshIdentity: payloadHandler(stringPayload("serverId"), (serverId) =>
        runCauseEffect(remoteServers.refreshIdentity(serverId)),
      ),
      listMembers: payloadHandler(stringPayload("serverId"), (serverId) =>
        runCauseEffect(remoteServers.listMembers(serverId)),
      ),
      setTyping: payloadHandler(parseSetTeamTyping, (parsed) =>
        routeToServer<void>(remoteServers.activeServerId, {
          local: () => host.setTyping(parsed),
          remote: () => runCauseEffect(remoteServers.setTyping(parsed)),
        }),
      ),
    },
    host: {
      getStatus: handler(() => host.getStatus()),
      configure: payloadHandler(parseHostConfig, (config) => runCauseEffect(host.configure(config))),
      updateIdentity: payloadHandler(parseHostIdentity, (identity) => runCauseEffect(host.updateIdentity(identity))),
      getPresence: handler(() => host.getPresence()),
      start: handler(() => runCauseEffect(host.start())),
      stop: handler(() => runCauseEffect(host.stop())),
      listMembers: handler(() => runCauseEffect(host.listMembers())),
      listSessions: handler(() => host.listSessions()),
      revokeSession: payloadHandler(stringPayload("sessionId"), (sessionId) =>
        runCauseEffect(host.revokeSession(sessionId)),
      ),
    },
  };
}

export function withLocalHostSummary(servers: ServerSummary[], status: HostStatus): ServerSummary[] {
  return servers.map((server) =>
    server.id === LOCAL_SERVER_ID
      ? {
          ...server,
          name: status.serverName ?? "Local",
          logoUrl: status.logoUrl,
          apiUrl: status.apiUrl,
          state: status.phase === "error" ? "error" : "online",
          role: status.configured ? "owner" : null,
        }
      : server,
  );
}
