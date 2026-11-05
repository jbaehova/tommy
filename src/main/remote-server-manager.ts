import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { basename } from "node:path";
import { isValidAvatarImage } from "@tommy/contracts/avatar-images";
import type {
  AgentEvent,
  AttachmentDownloadProgress,
  AvatarImageInput,
  ClientAgentSummary,
  ConversationPage,
  ConversationPageAnchor,
  ConversationReadState,
  ConversationSearchPage,
  ConversationWithReadState,
  DraftAttachment,
  DuplicateAgentResult,
  ExportInstanceInput,
  InstanceTransferPreview,
  MarkConversationReadInput,
  ServerNotificationLevel,
  ServerSummary,
  SetAgentNotificationLevelInput,
  SetTeamTypingInput,
  TeamMemberSummary,
  TeamPresenceSnapshot,
  TeamRealtimeEvent,
} from "@tommy/contracts/ipc";
import {
  type AgentNotificationLevelsSnapshot,
  decodeRemoteInstanceTransferPreview,
  EMPTY_AGENT_NOTIFICATION_LEVELS,
  LOCAL_SERVER_ID,
} from "@tommy/contracts/ipc";
import { TEAM_API_ROUTES } from "@tommy/contracts/team-api-routes";
import {
  AGENT_NOTIFICATION_LEVELS_CAPABILITY,
  AGENT_NOTIFICATION_LEVELS_ROUTES,
} from "@tommy/contracts/team-protocol/agent-notification-levels-v1";
import { decodeBrowserViewSessionResponse } from "@tommy/contracts/team-protocol/browser-view-v1";
import type { TeamCurrentCapability } from "@tommy/contracts/team-protocol/current";
import { DESKTOP_FOCUS_CAPABILITY, DESKTOP_FOCUS_ROUTES } from "@tommy/contracts/team-protocol/desktop-focus-v1";
import { FOCUS_USE_CAPABILITY, FOCUS_USE_ROUTES } from "@tommy/contracts/team-protocol/focus-use-v1";
import { decodeHostLogo, HOST_LOGO_ROUTES } from "@tommy/contracts/team-protocol/host-logo-v1";
import type { HostRestartEvent } from "@tommy/contracts/team-protocol/host-update-v1";
import { INSTANCE_TRANSFER_ROUTES } from "@tommy/contracts/team-protocol/instance-transfer-v1";
import type { MachineAlertEvent } from "@tommy/contracts/team-protocol/machine-resources-v1";
import { decodeTeamProtocolV1CurrentHttpResponse } from "@tommy/contracts/team-protocol/v1-adapter";
import { sourceText } from "@tommy/i18n/source";
import { createFocusUsePing } from "@tommy/team-client/focus-use";
import { Deferred, Effect, Exit, Layer, Result, Scope, Semaphore } from "effect";
import { contentDispositionFileName } from "./content-disposition";
import { createDesktopFocusReport } from "./desktop-focus-report";
import type { PreferenceFileFailure } from "./preference-file";
import {
  decodeAgentNotificationLevelsFromHost,
  decodeAgentSummary,
  decodeDraftAttachment,
  decodeDuplicateAgentResultFromHost,
} from "./remote-agent-decoding";
import { AttachmentDownloadStopped, type RemoteAttachment, RemoteAttachmentCache } from "./remote-attachment-cache";
import type { RemoteConnectTrace } from "./remote-connect-trace";
import {
  decodeConversationPageFromHost,
  decodeConversationReadState,
  decodeConversationReadStates,
  decodeConversationSearchPageFromHost,
  decodeConversationWithReadState,
} from "./remote-conversation-decoding";
import { acceptEmpty, decodeVoid, type ResponseDecoder } from "./remote-host-decoding";
import { type RemoteRequestInit, RemoteServerClient } from "./remote-server-client";
import { RemoteServerConnections } from "./remote-server-connections";
import { RemoteRequestError } from "./remote-server-errors";
import { RemoteEventRefresh } from "./remote-server-event-refresh";
import { RemoteEventStream } from "./remote-server-event-stream";
import { followedHostKeyHandovers, hostKeyChangeTimes, reconcileWebRtcHosts } from "./remote-server-host-directory";
import { throwRemoteResponseError } from "./remote-server-http";
import { RemotePresenceCache } from "./remote-server-presence";
import { RemoteServerStore, type TokenCipher } from "./remote-server-store";
import { remoteServerSummaries } from "./remote-server-summaries";
import { addRemotePreviewUrls, pageQuery } from "./remote-server-urls";
import {
  type RemoteFileProgress,
  RemoteRequest,
  RemoteWorkflowError,
  remoteCall,
  remoteDecode,
} from "./remote-service-effects";
import { decodeTeamMembers, decodeTeamPresenceSnapshot } from "./remote-team-decoding";
import { RemoteViewerProxy } from "./remote-viewer-proxy";
import {
  TEAM_WEBRTC_REMOTE_REQUEST_TIMEOUT_MILLISECONDS,
  type TeamWebRtcClientTransport,
} from "./team-webrtc-client-transport";

interface RemoteServerEvents {
  directoryInvalidated: [];
  changed: [servers: ServerSummary[]];
  agent: [serverId: string, event: AgentEvent, bufferedLive?: boolean];
  presence: [serverId: string, snapshot: TeamPresenceSnapshot];
  machineAlert: [serverId: string, event: MachineAlertEvent];
  attachmentDownload: [progress: AttachmentDownloadProgress];
}

// The renderer redraws a progress ring; more than about ten updates a second show nothing more.
const ATTACHMENT_PROGRESS_INTERVAL_MS = 100;

interface CentralAccountSession {
  getEmail: () => string;
}

interface RemoteServerManagerOptions {
  appVersion?: string;
  webrtcTransport?: TeamWebRtcClientTransport;
  getLocalHostId?: () => string | null;
  /** The account service's hosted servers. Each joined host can be one. */
  /** Times each WebRTC connection for the local trace. */
  connectTrace?: RemoteConnectTrace;
  /**
   * The account's first load. The host list needs only the saved token, so it can arrive before the
   * account says who is signed in; the first read of it waits for this.
   */
  accountReady?: Effect.Effect<unknown, RemoteWorkflowError>;
  /** The notification levels that the owner of this computer chose on its own server. */
  localNotificationLevels?: LocalNotificationLevels;
}

/** The levels of the owner on the server of this computer, which the host also reads for the owner's phones. */
export interface LocalNotificationLevels {
  snapshot(): AgentNotificationLevelsSnapshot;
  setServer(
    level: ServerNotificationLevel | null,
  ): Effect.Effect<AgentNotificationLevelsSnapshot, PreferenceFileFailure>;
  setAgent(
    input: SetAgentNotificationLevelInput,
  ): Effect.Effect<AgentNotificationLevelsSnapshot, PreferenceFileFailure>;
  /** Calls `listener` after each change, also one that the owner's phone made through the host. */
  subscribe(listener: () => void): () => void;
}

const REMOTE_DUPLICATION_TIMEOUT_MS = TEAM_WEBRTC_REMOTE_REQUEST_TIMEOUT_MILLISECONDS;
/** An export of up to 100 MB goes up and is read in one request, and apply creates many agents. */
export const AGENT_IMPORT_UPLOAD_TIMEOUT_MS = TEAM_WEBRTC_REMOTE_REQUEST_TIMEOUT_MILLISECONDS;
// How long a host that restarts into an update keeps the fast retry after Signal first misses it. A
// host that is not back by then is offline, as any other host. A hosted server restarts its whole
// machine and restores its disk; one took 18 minutes.
const HOST_RESTART_RETRY_MS = 30 * 60_000;
export class RemoteServerManager extends EventEmitter<RemoteServerEvents> {
  readonly #scope = Scope.makeUnsafe();
  readonly #platform: Layer.Layer<RemoteRequest>;
  #stopped = false;
  readonly #operations = new Set<Deferred.Deferred<void>>();
  #stopping: Deferred.Deferred<void, RemoteWorkflowError> | null = null;
  readonly #store: RemoteServerStore;
  readonly #connections: RemoteServerConnections;
  readonly #client: RemoteServerClient;
  readonly #refresh: RemoteEventRefresh;
  readonly #events: RemoteEventStream;
  readonly #presence: RemotePresenceCache;
  readonly #attachments = new RemoteAttachmentCache();
  /** The downloads that `stopAttachmentDownload` can end, by server and attachment. */
  readonly #attachmentStops = new Map<string, Deferred.Deferred<never, RemoteWorkflowError>>();
  readonly #localLevels: LocalNotificationLevels | null;
  /**
   * The notification levels that the user chose on each joined server, as each server last gave them.
   * Each connection reads them, and `agent-notification-levels-changed` and each change from this
   * computer keep them current.
   */
  readonly #syncedLevels = new Map<string, AgentNotificationLevelsSnapshot>();
  readonly #centralAccount: CentralAccountSession;
  readonly #appVersion: string | null;
  #duplicateOperationIds = new Map<string, string>();
  /** When Signal first missed each host that restarts into an update. */
  readonly #hostRestartAway = new Map<string, number>();
  readonly #webrtcTransport: TeamWebRtcClientTransport | null;
  readonly #getLocalHostId: () => string | null;
  /** From the last host list. Null before one, or when this computer hosts nothing that the account lists. */
  #localMemberLimit: number | null = null;
  /** When each listed host last changed its key, by server id. The local host is `LOCAL_SERVER_ID`. */
  #keyChangedAt = new Map<string, number>();
  /** The local servers that this app runs as its child processes. See `local-servers/`. */
  #thisComputerServers: ReadonlySet<string> = new Set();
  #appFocused = true;
  /** The selected hosted server keeps running while this window has focus (`focus-use-v1`). */
  readonly #focusUse = createFocusUsePing((serverId) =>
    this.#background(this.request(serverId, FOCUS_USE_ROUTES.ping, acceptEmpty, { method: "POST", body: {} })),
  );
  /** The server keeps the phones quiet while a window of this app has focus (`desktop-focus-v1`). */
  readonly #desktopFocus = createDesktopFocusReport((serverId, focused) =>
    this.#background(
      this.request(serverId, DESKTOP_FOCUS_ROUTES.report, acceptEmpty, { method: "POST", body: { focused } }),
    ),
  );
  readonly #remoteViewerProxy: RemoteViewerProxy | null;
  #selections = Semaphore.makeUnsafe(1);
  /** One read of the account's host list at a time, so an older answer cannot replace a newer one. */
  readonly #directorySync = Semaphore.makeUnsafe(1);
  /** Done when the first read of the account's host list after `initialize` ends, either way. */
  readonly #initialDirectory = Deferred.makeUnsafe<void>();
  readonly #connectTrace: RemoteConnectTrace | null;
  readonly #accountReady: Effect.Effect<unknown, RemoteWorkflowError>;
  #muteExpiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    path: string,
    cipher: TokenCipher,
    centralAccount: CentralAccountSession,
    options: RemoteServerManagerOptions = {},
  ) {
    super();
    this.#store = new RemoteServerStore({ path, cipher });
    this.#appVersion = options.appVersion ?? null;
    this.#connections = new RemoteServerConnections({
      appVersion: this.#appVersion,
      onChanged: () => this.#emitChanged(),
      // The registry never names the event stream. It reports that reconnecting is pointless and the
      // manager decides what that costs -- which is what keeps the socket out of the error path.
      onReconnectSuspended: (serverId) => this.#suspendServer(serverId),
    });
    this.#centralAccount = centralAccount;
    this.#webrtcTransport = options.webrtcTransport ?? null;
    this.#getLocalHostId = options.getLocalHostId ?? (() => null);
    this.#connectTrace = options.connectTrace ?? null;
    this.#accountReady = options.accountReady ?? Effect.void;
    this.#localLevels = options.localNotificationLevels ?? null;
    // A change from the owner's phone shows at once in the server list and in Settings › Notifications.
    this.#localLevels?.subscribe(() => {
      this.#emitChanged();
      const snapshot = this.cachedNotificationLevels(LOCAL_SERVER_ID);
      this.emit("agent", LOCAL_SERVER_ID, { type: "agent-notification-levels-changed", ...snapshot });
    });
    this.#client = new RemoteServerClient({
      appVersion: this.#appVersion,
      servers: this.#store,
      connections: this.#connections,
      transport: this.#webrtcTransport,
    });
    this.#platform = Layer.succeed(
      RemoteRequest,
      RemoteRequest.of({
        request: (serverId, path, decoder, init) => this.#client.request(serverId, path, decoder, init),
      }),
    );
    this.#refresh = new RemoteEventRefresh({
      request: (serverId, path, decoder, init) => this.#client.request(serverId, path, decoder, init),
      hasServer: (serverId) => this.#store.has(serverId),
      emit: (serverId, event, bufferedLive) => {
        // Another device of the user changed their levels: the server list shows the new server level.
        if (event.type === "agent-notification-levels-changed")
          this.#rememberLevels(serverId, { server: event.server, agents: event.agents });
        if (bufferedLive) this.emit("agent", serverId, event, true);
        else this.emit("agent", serverId, event);
      },
    });
    this.#presence = new RemotePresenceCache({
      fetchSnapshot: (serverId) => this.request(serverId, TEAM_API_ROUTES.team.presence, decodeTeamPresenceSnapshot),
      onSnapshot: (serverId, snapshot) => this.emit("presence", serverId, snapshot),
    });
    this.#events = new RemoteEventStream({
      appVersion: this.#appVersion,
      servers: this.#store,
      client: this.#client,
      connections: this.#connections,
      agents: this.#refresh,
      transport: this.#webrtcTransport,
      // The stream reports facts and this is where they become state: an identity is written, a
      // presence snapshot is cached, and the rest are forwarded to the renderer.
      onServerIdentity: (serverId, identity) => this.#applyServerIdentity(serverId, identity),
      onPresence: (serverId, snapshot) => this.#presence.accept(serverId, snapshot),
      onHostRestart: (serverId, event) => this.#applyHostRestart(serverId, event),
      onMachineAlert: (serverId, event) => this.emit("machineAlert", serverId, event),
      onOffline: (serverId) => this.#presence.markOffline(serverId),
      onChanged: () => this.#emitChanged(),
    });
    this.#remoteViewerProxy = this.#webrtcTransport
      ? new RemoteViewerProxy({
          transport: this.#webrtcTransport,
        })
      : null;
    this.#webrtcTransport?.on("connected", (serverId) => {
      this.#events.clearReconnectBackoff(serverId);
      this.#hostRestartAway.delete(serverId);
      this.#connections.markConnected(serverId);
      this.#emitChanged();
      const server = this.#store.find(serverId);
      this.#background(
        this.#owned(
          Effect.gen({ self: this }, function* () {
            if (server) yield* this.#client.refreshWebRtcCompatibility(server).pipe(Effect.catch(() => Effect.void));
            this.#connectTrace?.mark(serverId, "compatibility");
            this.#emitChanged();
            yield* Effect.all(
              [
                // Another device of the user can have changed the levels while this one was away.
                this.notificationLevels(serverId).pipe(Effect.catch(() => Effect.void)),
                this.#refresh.refreshAgentRoster(serverId).pipe(
                  Effect.result,
                  Effect.map((result) =>
                    this.#connectTrace?.mark(serverId, "first-request", Result.isSuccess(result) ? "ok" : "error"),
                  ),
                ),
              ],
              { concurrency: "unbounded" },
            );
          }),
        ),
      );
    });
    this.#webrtcTransport?.on("disconnected", (serverId) => {
      const wasOnline = this.#connections.statusFor(serverId).state === "online";
      // A host the app has stopped reconnecting to is not merely offline. The recorded failure is
      // the reason it will not come back, and this disconnect is that failure's own tail -- the one
      // `#suspendServer` asked for. Writing "offline" over an "incompatible" would leave the issue
      // sitting behind an ordinary word for it, which is why the HTTPS arm guards the same way.
      if (!this.#events.isReconnectSuspended(serverId)) this.#connections.setState(serverId, "offline");
      this.#presence.markOffline(serverId);
      this.#emitChanged();
      this.#events.scheduleReconnect(serverId);
      if (wasOnline) this.emit("directoryInvalidated");
    });
    this.#webrtcTransport?.on("event", (serverId, event) => this.#handleWebRtcEvent(serverId, event));
    this.#webrtcTransport?.on("error", (serverId, code, message) => {
      // A failure to connect also checks the restart time: the workspace shows "Updating" until it ends.
      // An error on a live connection, such as `rate_limited`, does not start that time.
      const hostRestarting =
        (code === "host_unavailable" || !this.#webrtcTransport?.isConnected(serverId)) &&
        this.#awaitsHostRestart(serverId);
      if (code === "host_unavailable" && !hostRestarting) {
        this.#events.markHostOffline(serverId);
      }
      if (!this.#connections.reportTransportError(serverId, code, message)) this.#events.scheduleReconnect(serverId);
      if (code === "session_revoked") this.emit("directoryInvalidated");
    });
  }

  #suspendServer(serverId: string): void {
    this.#events.suspendReconnect(serverId);
    if (this.#store.find(serverId)?.transport !== "webrtc-v2") return;
    const transport = this.#webrtcTransport;
    if (transport) this.#background(this.#owned(transport.disconnect(serverId).pipe(Effect.catch(() => Effect.void))));
  }

  /**
   * Starts work for a transport callback in this manager's scope, now, so events keep their order.
   * `stop` interrupts it. A failure is dropped: the callback has nobody to answer.
   */
  #background(operation: Effect.Effect<unknown, RemoteWorkflowError>): void {
    Effect.runFork(
      Effect.forkIn(operation.pipe(Effect.catch(() => Effect.void)), this.#scope, { startImmediately: true }),
    );
  }

  #owned<A>(operation: Effect.Effect<A, RemoteWorkflowError, RemoteRequest>): Effect.Effect<A, RemoteWorkflowError> {
    return Effect.suspend(() => {
      if (this.#stopped)
        return Effect.fail(
          new RemoteWorkflowError({ cause: new Error(sourceText("error.remote.connectionCancelled")) }),
        );
      const done = Deferred.makeUnsafe<void>();
      this.#operations.add(done);
      return operation.pipe(
        Effect.provide(this.#platform),
        Effect.ensuring(
          Effect.sync(() => this.#operations.delete(done)).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
        ),
      );
    });
  }

  /**
   * Loads the stored servers. The read of the account's host list goes on in the background, so the
   * window does not wait for the account service: `awaitHostDirectory` waits for it. A stored host
   * keeps the key it pinned before, and the directory never replaces a pinned key, so that key is
   * pinned now. A host without one waits in the transport until the directory pins it.
   */
  readonly initialize = Effect.fn("RemoteManager.initialize")(
    function* (this: RemoteServerManager): Effect.fn.Return<void, RemoteWorkflowError, RemoteRequest> {
      const transport = this.#webrtcTransport;

      yield* this.#store.load();
      this.#scheduleMuteExpiry();
      this.#initializeConnectionStates();
      if (!transport) {
        Deferred.doneUnsafe(this.#initialDirectory, Effect.void);
        return;
      }
      for (const server of this.#store.servers) {
        if (server.transport === "webrtc-v2" && server.publicKey) transport.pinHostKey(server.id, server.publicKey);
      }
      transport.beginHostKeySync();
      const startedAt = performance.now();
      this.#background(
        this.#owned(
          this.#accountReady.pipe(
            Effect.andThen(this.#syncWebRtcHosts()),
            Effect.tap(() => Effect.sync(() => this.#initializeConnectionStates())),
            // A host the directory added after the event connections started has no connection yet.
            Effect.tap(() => (this.#events.enabled ? this.startEventConnections() : Effect.void)),
            Effect.tap(() => Effect.sync(() => this.#emitChanged())),
            Effect.onExit((exit) =>
              Effect.sync(() => {
                this.#connectTrace?.directory(performance.now() - startedAt, Exit.isSuccess(exit) ? "ok" : "error");
                transport.endHostKeySync();
                Deferred.doneUnsafe(this.#initialDirectory, Effect.void);
              }),
            ),
          ),
        ),
      );
    },
    (operation) => this.#owned(operation),
  ).bind(this);

  /** Waits for the first read of the account's host list. It ends also when the read fails. */
  readonly awaitHostDirectory = Effect.fn("RemoteManager.awaitHostDirectory")(function* (this: RemoteServerManager) {
    yield* Deferred.await(this.#initialDirectory);
  }).bind(this);

  /**
   * Starts the connection to the selected WebRTC server before the window loads. The other servers
   * start with the event connections, after the window loads. A failure is dropped here: the event
   * connections try again and report it.
   */
  connectActiveServer(): void {
    const transport = this.#webrtcTransport;
    const server = this.#store.find(this.#store.activeServerId);
    if (!transport || server?.transport !== "webrtc-v2") return;
    this.#background(this.#owned(transport.connect(server.id)));
  }

  /** A server that has no connection state yet starts offline, with its compatibility unknown. */
  #initializeConnectionStates(): void {
    for (const server of this.#store.servers) {
      if (this.#connections.stateFor(server.id) !== null) continue;
      this.#connections.setState(server.id, "offline");
      if (server.transport === "webrtc-v2") this.#connections.startCheckingCompatibility(server.id);
    }
  }

  list(): ServerSummary[] {
    return remoteServerSummaries(
      this.#store.servers,
      this.#store.activeServerId,
      (serverId) => this.#connections.statusFor(serverId),
      this.#localMemberLimit,
      (serverId) => this.#thisComputerServers.has(serverId),
      (serverId) => this.#keyChangedAt.get(serverId),
    )
      .filter((server) => server.kind === "remote")
      .map((server) => {
        const mute = this.#store.muteState(server.id);
        return {
          ...server,
          notificationsMuted: mute.muted,
          notificationsMutedUntil: mute.mutedUntil,
          // The level that the user chose for all devices wins over the level of this computer.
          notificationLevel:
            this.cachedNotificationLevels(server.id).server ?? this.#store.notificationLevel(server.id),
        };
      });
  }

  /** The levels that the user chose on a server for all of their devices, as last read. */
  cachedNotificationLevels(serverId: string): AgentNotificationLevelsSnapshot {
    if (serverId === LOCAL_SERVER_ID) return this.#localLevels?.snapshot() ?? EMPTY_AGENT_NOTIFICATION_LEVELS;
    return this.#syncedLevels.get(serverId) ?? EMPTY_AGENT_NOTIFICATION_LEVELS;
  }

  /**
   * The levels of a joined server that this computer has read, or `null` before the first read
   * succeeds. A server without `agent-notification-levels-v1` has none to read.
   */
  knownNotificationLevels(serverId: string): AgentNotificationLevelsSnapshot | null {
    if (serverId === LOCAL_SERVER_ID) return this.cachedNotificationLevels(serverId);
    return this.#syncedLevels.get(serverId) ?? null;
  }

  /**
   * Reads the levels that the user chose on a server for all of their devices. A joined server without
   * `agent-notification-levels-v1` has none, so the level of this computer applies.
   */
  readonly notificationLevels = Effect.fn("RemoteManager.notificationLevels")(function* (
    this: RemoteServerManager,
    serverId: string,
  ) {
    if (serverId === LOCAL_SERVER_ID || !this.supportsCapability(serverId, AGENT_NOTIFICATION_LEVELS_CAPABILITY))
      return this.cachedNotificationLevels(serverId);
    const snapshot = yield* this.request(
      serverId,
      AGENT_NOTIFICATION_LEVELS_ROUTES.read,
      decodeAgentNotificationLevelsFromHost,
      { method: "POST", body: {} },
    );
    this.#rememberLevels(serverId, snapshot);
    return snapshot;
  }).bind(this);

  readonly setAgentNotificationLevel = Effect.fn("RemoteManager.setAgentNotificationLevel")(function* (
    this: RemoteServerManager,
    serverId: string,
    input: SetAgentNotificationLevelInput,
  ) {
    if (serverId === LOCAL_SERVER_ID) {
      const local = this.#localLevels;
      if (!local) return yield* this.#levelsUnsupported();
      return yield* local.setAgent(input).pipe(Effect.mapError((cause) => new RemoteWorkflowError({ cause })));
    }
    if (!this.supportsCapability(serverId, AGENT_NOTIFICATION_LEVELS_CAPABILITY))
      return yield* this.#levelsUnsupported();
    const snapshot = yield* this.request(
      serverId,
      AGENT_NOTIFICATION_LEVELS_ROUTES.set,
      decodeAgentNotificationLevelsFromHost,
      { method: "POST", body: { agentId: input.agentId, level: input.level } },
    );
    this.#rememberLevels(serverId, snapshot);
    return snapshot;
  }).bind(this);

  #levelsUnsupported() {
    return new RemoteWorkflowError({ cause: new Error(sourceText("error.team.agentNotificationLevelsUnsupported")) });
  }

  #rememberLevels(serverId: string, snapshot: AgentNotificationLevelsSnapshot): void {
    const before = this.#syncedLevels.get(serverId)?.server ?? null;
    this.#syncedLevels.set(serverId, snapshot);
    // The server level is in the server list, which the rail, the menus and the island read.
    if (before !== snapshot.server) this.#emitChanged();
  }

  /**
   * The account service says this user's server list changed, and it reached this computer through
   * Signal rather than through a poll. The refresh itself belongs to the caller that owns the
   * account check, so this only says the stored list can no longer be trusted.
   */
  readonly invalidateDirectory = Effect.fn("RemoteManager.invalidateDirectory")(function* (this: RemoteServerManager) {
    yield* this.#events.retryOfflineHosts();
    this.emit("directoryInvalidated");
  }).bind(this);

  /** Reads the server list again, for example after this computer's host changed its key. */
  requestDirectoryRefresh(): void {
    this.emit("directoryInvalidated");
  }

  /** Focus retries an offline host at once. After that, it retries each 5 minutes with focus and each 15 without. */
  readonly setAppFocused = Effect.fn("RemoteManager.setAppFocused")(function* (
    this: RemoteServerManager,
    focused: boolean,
  ) {
    this.#appFocused = focused;
    this.#syncFocusUse();
    yield* this.#events.setAppFocused(focused);
  }).bind(this);

  /** The computer woke from sleep. Each host reconnects at once instead of after its backoff. */
  readonly wake = Effect.fn("RemoteManager.wake")(function* (this: RemoteServerManager) {
    yield* this.#events.wake();
  }).bind(this);

  /** A file on this server was deleted, so a copy of it must not be shown again. */
  forgetCachedAttachments(serverId: string): void {
    this.#attachments.forget(serverId);
  }

  readonly syncRemoteHosts = Effect.fn("RemoteManager.syncRemoteHosts")(
    function* (this: RemoteServerManager): Effect.fn.Return<ServerSummary[], RemoteWorkflowError, RemoteRequest> {
      yield* this.#syncWebRtcHosts();
      if (this.#events.enabled) yield* this.startEventConnections();
      this.#emitChanged();
      return this.list();
    },
    (operation) => this.#owned(operation),
  ).bind(this);

  get activeServerId(): string {
    return this.#store.activeServerId;
  }

  /** The servers that a chat window shows. Their hosts keep sending chat events. */
  setChatWindowServers(serverIds: ReadonlySet<string>): void {
    this.#events.setChatWindowServers(serverIds);
  }

  // What the host on the other end negotiated it can do. An IPC handler asks before calling a route
  // an older host does not serve, so this answers false until compatibility is known rather than
  // waiting for it -- a capability nobody has confirmed is one you cannot use yet.
  supportsCapability(serverId: string, capability: TeamCurrentCapability): boolean {
    return this.#connections.compatibilityFor(serverId)?.capabilities.includes(capability) ?? false;
  }

  readonly startEventConnections = Effect.fn("RemoteManager.startEventConnections")(function* (
    this: RemoteServerManager,
  ) {
    yield* this.#events.start();
  }).bind(this);

  readonly refreshRuntimeSnapshots = Effect.fn("RemoteManager.refreshRuntimeSnapshots")(function* (
    this: RemoteServerManager,
  ) {
    yield* this.#events.refreshRuntimeSnapshots();
  }).bind(this);

  select(serverId: string): Effect.Effect<ServerSummary[], RemoteWorkflowError> {
    return this.#owned(this.#selections.withPermit(Effect.uninterruptible(this.#selectEffect(serverId))));
  }

  readonly #selectEffect = Effect.fn("RemoteManager.select")(function* (this: RemoteServerManager, serverId: string) {
    if (serverId !== LOCAL_SERVER_ID && !this.#store.has(serverId))
      return yield* new RemoteWorkflowError({ cause: new Error(sourceText("error.remote.serverNotFound")) });
    const previousSelection = this.#store.selection;
    const selectionRevision = this.#store.setActiveServerId(serverId);
    this.#events.syncScopes();
    yield* this.#store.persist().pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          if (this.#store.activeServerRevision === selectionRevision) {
            this.#store.restoreSelection(previousSelection);
            this.#events.syncScopes();
          }
        }),
      ),
    );
    this.#emitChanged();
    yield* this.startEventConnections();
    // A host that dropped recently waits on its reconnect backoff, up to minutes. Without this the
    // selected server showed "Connecting" until that timer fired.
    yield* this.#events.retryNow(serverId);
    return this.list();
  });

  // No duration mutes until the user unmutes.

  readonly setMuted = Effect.fn("RemoteManager.setMuted")(
    function* (
      this: RemoteServerManager,
      serverId: string,
      muted: boolean,
      durationMs?: number,
    ): Effect.fn.Return<ServerSummary[], RemoteWorkflowError, RemoteRequest> {
      yield* this.#store.setMuted(serverId, muted, durationMs === undefined ? null : Date.now() + durationMs);
      this.#scheduleMuteExpiry();
      this.#emitChanged();
      return this.list();
    },
    (operation) => this.#owned(operation),
  ).bind(this);

  readonly setNotificationLevel = Effect.fn("RemoteManager.setNotificationLevel")(
    function* (
      this: RemoteServerManager,
      serverId: string,
      level: ServerNotificationLevel,
    ): Effect.fn.Return<ServerSummary[], RemoteWorkflowError, RemoteRequest> {
      // The level of this computer stays as the fallback for a server that cannot keep the user's level.
      yield* this.#store.setNotificationLevel(serverId, level);
      if (serverId === LOCAL_SERVER_ID && this.#localLevels) {
        yield* this.#localLevels.setServer(level).pipe(Effect.mapError((cause) => new RemoteWorkflowError({ cause })));
      } else if (
        serverId !== LOCAL_SERVER_ID &&
        this.supportsCapability(serverId, AGENT_NOTIFICATION_LEVELS_CAPABILITY)
      ) {
        const snapshot = yield* this.request(
          serverId,
          AGENT_NOTIFICATION_LEVELS_ROUTES.server,
          decodeAgentNotificationLevelsFromHost,
          { method: "POST", body: { level } },
        );
        this.#syncedLevels.set(serverId, snapshot);
      }
      this.#emitChanged();
      return this.list();
    },
    (operation) => this.#owned(operation),
  ).bind(this);

  // The rail shows a muted server until its timed mute ends, so the end has to reach the renderer as a
  // change. One timer covers the earliest end; each run schedules the next one.
  #scheduleMuteExpiry(): void {
    if (this.#muteExpiryTimer) clearTimeout(this.#muteExpiryTimer);
    this.#muteExpiryTimer = null;
    const expiry = this.#store.nextMuteExpiry();
    if (expiry === null) return;
    // setTimeout overflows above 2^31-1 ms; a later run reschedules until the end is reached.
    const delay = Math.min(Math.max(expiry - Date.now(), 0) + 1, 2_147_483_647);
    this.#muteExpiryTimer = setTimeout(() => {
      this.#scheduleMuteExpiry();
      this.#emitChanged();
    }, delay);
    this.#muteExpiryTimer.unref?.();
  }

  readonly retryConnection = Effect.fn("RemoteManager.retryConnection")(
    function* (
      this: RemoteServerManager,
      serverId: string,
    ): Effect.fn.Return<ServerSummary, RemoteWorkflowError, RemoteRequest> {
      const transport = this.#webrtcTransport;

      const server = yield* remoteDecode(() => this.#store.require(serverId));
      const blockedState = this.#connections.hasIssue(serverId)
        ? (this.#connections.stateFor(serverId) ?? "error")
        : "error";
      const attempt1 = yield* Effect.gen({ self: this }, function* () {
        if (server.transport === "webrtc-v2") {
          if (!transport)
            return yield* new RemoteWorkflowError({ cause: new Error(sourceText("error.remote.webRtcUnavailable")) });
          // The user retrying is what lifts the suspension a protocol or credential failure left
          // behind. Without this the connection comes up and the next disconnect never reconnects,
          // because `scheduleReconnect` still sees the host paused -- the HTTPS arm below gets the
          // same reset from `restart(serverId, true)`.
          this.#events.resumeReconnect(serverId);
          this.#connections.setState(serverId, "connecting");
          this.#emitChanged();
          yield* transport.retry(serverId);
          // The `connected` handler is what turns that "connecting" back into "online", and a host
          // that was already connected raises no such event -- the session it would announce is the
          // one still running. Retrying a host whose channel had never actually dropped therefore
          // left it reading as reconnecting until it next went offline for real.
          if (this.#connections.stateFor(serverId) === "connecting" && transport.isConnected(serverId)) {
            // The same session continues, so the host does not send its restart state again.
            const hostRestart = this.#connections.hostRestartFor(serverId);
            this.#connections.markConnected(serverId);
            this.#connections.setHostRestart(serverId, hostRestart);
            this.#emitChanged();
          }
          return yield* remoteDecode(() => requiredServerSummary(this.list(), serverId));
        }
        this.#connections.setState(serverId, "connecting");
        this.#emitChanged();
        yield* this.#client.ensureCompatibility(server, true);
        yield* this.#events.restart(serverId, true);
      }).pipe(Effect.result);
      if (Result.isFailure(attempt1)) {
        const error = attempt1.failure.cause;
        this.#connections.reportError(serverId, error, blockedState);
        // A failed check can leave the old event socket open. Replace it so a later
        // successful connection can restore the state, with the existing backoff.
        if (!this.#events.isReconnectSuspended(serverId)) yield* this.#events.restart(serverId);
        return yield* new RemoteWorkflowError({ cause: error });
      } else if (attempt1.success !== undefined) return attempt1.success;
      return yield* remoteDecode(() => requiredServerSummary(this.list(), serverId));
    },
    (operation) => this.#owned(operation),
  ).bind(this);

  #clearServerConnectionState(serverId: string): void {
    this.#events.forget(serverId);
    this.#refresh.forget(serverId);
    this.#connections.forget(serverId);
    this.#client.forget(serverId);
    this.#presence.forget(serverId);
    this.#attachments.forget(serverId);
  }

  // The server comes first because every caller knows which one it means, and the decoder sits next
  // to the path it decodes. `init` is last and optional, so a plain GET reads as three arguments.

  request<T>(
    serverId: string,
    path: string,
    decoder: ResponseDecoder<T>,
    init: RemoteRequestInit = {},
  ): Effect.Effect<T, RemoteWorkflowError> {
    return this.#owned(RemoteRequest.use((service) => service.request(serverId, path, decoder, init))).pipe(
      Effect.withSpan("RemoteManager.request"),
    );
  }

  readonly duplicateAgent = Effect.fn("RemoteManager.duplicateAgent")(
    function* (
      this: RemoteServerManager,
      agentId: string,
      serverId = this.#store.activeServerId,
    ): Effect.fn.Return<DuplicateAgentResult, RemoteWorkflowError, RemoteRequest> {
      const key = `${serverId}\0${agentId}`;
      const operationId = this.#duplicateOperationIds.get(key) ?? randomUUID();
      this.#duplicateOperationIds.set(key, operationId);
      return yield* Effect.gen({ self: this }, function* () {
        const result = yield* this.request(
          serverId,
          TEAM_API_ROUTES.agent.duplicate(agentId),
          decodeDuplicateAgentResultFromHost,
          { method: "POST", body: { operationId }, timeoutMs: REMOTE_DUPLICATION_TIMEOUT_MS },
        );
        this.#duplicateOperationIds.delete(key);
        return result;
      }).pipe(
        Effect.catch(({ cause: error }) =>
          Effect.gen({ self: this }, function* () {
            if (error instanceof RemoteRequestError && error.status >= 400 && error.status < 500) {
              this.#duplicateOperationIds.delete(key);
            }
            return yield* new RemoteWorkflowError({ cause: error });
          }),
        ),
      );
    },
    (operation) => this.#owned(operation),
  ).bind(this);

  listAgentConversationReads(
    serverId = this.#store.activeServerId,
  ): Effect.Effect<Record<string, ConversationReadState>, RemoteWorkflowError> {
    return this.request(serverId, TEAM_API_ROUTES.agents.conversationReads, decodeConversationReadStates);
  }

  readAgentConversation(
    agentId: string,
    serverId = this.#store.activeServerId,
  ): Effect.Effect<ConversationWithReadState, RemoteWorkflowError> {
    return this.request(serverId, TEAM_API_ROUTES.agent.conversation(agentId), decodeConversationWithReadState);
  }

  readAgentConversationPage(
    agentId: string,
    anchor: ConversationPageAnchor = { type: "latest" },
    limit = 50,
    serverId = this.#store.activeServerId,
  ): Effect.Effect<ConversationPage, RemoteWorkflowError> {
    return this.request(
      serverId,
      `${TEAM_API_ROUTES.agent.conversationPage(agentId)}${pageQuery(anchor, limit)}`,
      decodeConversationPageFromHost,
    );
  }

  searchAgentConversationMessages(
    query: string,
    agentId?: string,
    cursor?: string,
    limit = 100,
    serverId = this.#store.activeServerId,
  ): Effect.Effect<ConversationSearchPage, RemoteWorkflowError> {
    const parameters = new URLSearchParams({ q: query, limit: String(limit) });
    // A query parameter never reaches the JSON adapters, so it keeps the released spelling.
    if (agentId) parameters.set("botId", agentId);
    if (cursor) parameters.set("cursor", cursor);
    return this.request(
      serverId,
      `${TEAM_API_ROUTES.messages.search}?${parameters.toString()}`,
      decodeConversationSearchPageFromHost,
    );
  }

  markAgentConversationRead(
    input: MarkConversationReadInput,
    serverId = this.#store.activeServerId,
  ): Effect.Effect<ConversationReadState, RemoteWorkflowError> {
    return this.request(serverId, TEAM_API_ROUTES.agent.conversationRead(input.agentId), decodeConversationReadState, {
      method: "POST",
      body: { throughMessageId: input.throughMessageId },
    });
  }

  getPresence(serverId = this.#store.activeServerId): TeamPresenceSnapshot {
    return this.#presence.get(serverId);
  }

  getPresenceFor(serverId: string): Effect.Effect<TeamPresenceSnapshot, RemoteWorkflowError> {
    return this.#owned(this.#presence.refresh(serverId));
  }

  readonly refreshIdentity = Effect.fn("RemoteManager.refreshIdentity")(
    function* (
      this: RemoteServerManager,
      serverId: string,
    ): Effect.fn.Return<ServerSummary, RemoteWorkflowError, RemoteRequest> {
      const transport = this.#webrtcTransport;

      const server = yield* remoteDecode(() => this.#store.require(serverId));
      if (server.transport === "webrtc-v2" && transport) {
        yield* this.#syncWebRtcHosts();
        this.#connections.clearCompatibility(serverId);
        yield* this.#client.ensureCompatibility(server, true);
        this.#connections.clearIssue(serverId);
        this.#emitChanged();
        return yield* remoteDecode(() => requiredServerSummary(this.list(), serverId));
      }
      const identity = yield* this.#client.verifyIdentity(server.apiUrl, server.id, server.fingerprint);
      this.#connections.setCompatibility(server.id, identity.compatibility);
      this.#connections.clearIssue(server.id);
      yield* this.#store.update(server.id, { name: identity.serverName, logoVersion: identity.logoVersion });
      this.#emitChanged();
      return yield* remoteDecode(() => requiredServerSummary(this.list(), server.id));
    },
    (operation) => this.#owned(operation),
  ).bind(this);

  listMembers(serverId: string): Effect.Effect<TeamMemberSummary[], RemoteWorkflowError> {
    return this.#owned(this.request(serverId, TEAM_API_ROUTES.team.members, (value) => decodeTeamMembers(value)));
  }

  readonly setTyping = Effect.fn("RemoteManager.setTyping")(function* (
    this: RemoteServerManager,
    input: SetTeamTypingInput,
    serverId = this.#store.activeServerId,
  ) {
    const server = this.#store.find(serverId);
    if (server?.transport === "webrtc-v2") {
      const transport = this.#webrtcTransport;
      if (transport)
        yield* Effect.forkIn(
          this.#owned(transport.setTyping(serverId, input.agentId, input.typing).pipe(Effect.catch(() => Effect.void))),
          this.#scope,
        );
      return;
    }
    this.#events.send(serverId, { type: "team-typing", ...input });
  }).bind(this);

  /**
   * Asks a host for a live view of one tab and answers where its frames are. A WebRTC host has no
   * address the client can reach, so the socket goes through the same local proxy the remote screen
   * uses; a host on the network is opened directly, with the member's token as the subprotocol.
   */

  readonly openBrowserViewStream = Effect.fn("RemoteManager.openBrowserViewStream")(
    function* (
      this: RemoteServerManager,
      serverId: string,
      tabId: string,
    ): Effect.fn.Return<{ sessionId: string; url: string; protocols: string[] }, RemoteWorkflowError, RemoteRequest> {
      const viewerProxy = this.#remoteViewerProxy;

      const server = yield* remoteDecode(() => this.#store.require(serverId));
      const session = yield* this.request(
        serverId,
        TEAM_API_ROUTES.browser.viewSessions,
        decodeBrowserViewSessionResponse,
        { method: "POST", body: { tabId } },
      );
      if (server.transport === "webrtc-v2") {
        const attempt3 = yield* Effect.gen({ self: this }, function* () {
          if (!viewerProxy)
            return yield* new RemoteWorkflowError({
              cause: new Error(sourceText("error.remote.viewerProxyUnavailable")),
            });
          const url = new URL(yield* viewerProxy.viewerUrl(serverId, session.streamPath));
          url.protocol = "ws:";
          return { sessionId: session.id, url: url.toString(), protocols: [] };
        }).pipe(Effect.result);
        if (Result.isFailure(attempt3)) {
          const error = attempt3.failure.cause;
          // The host counts this session against its limit until it is deleted.
          yield* this.closeBrowserViewSession(serverId, session.id).pipe(Effect.catch(() => Effect.void));
          return yield* new RemoteWorkflowError({ cause: error });
        } else return attempt3.success;
      }
      const url = new URL(session.streamPath, server.apiUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return {
        sessionId: session.id,
        url: url.toString(),
        protocols: [`tommy-token.${this.#store.token(server)}`],
      };
    },
    (operation) => this.#owned(operation),
  ).bind(this);

  closeBrowserViewSession(serverId: string, sessionId: string): Effect.Effect<void, RemoteWorkflowError> {
    return this.request(serverId, TEAM_API_ROUTES.browser.viewSession(sessionId), decodeVoid, { method: "DELETE" });
  }

  readonly uploadAttachment = Effect.fn("RemoteManager.uploadAttachment")(
    function* (
      this: RemoteServerManager,
      name: string,
      mimeType: string,
      bytes: Uint8Array,
      serverId = this.#store.activeServerId,
    ): Effect.fn.Return<DraftAttachment, RemoteWorkflowError, RemoteRequest> {
      const server = yield* remoteDecode(() => this.#store.require(serverId));
      const url = new URL(TEAM_API_ROUTES.attachments, server.apiUrl);
      url.searchParams.set("name", name);
      url.searchParams.set("mime", mimeType || "application/octet-stream");
      const response = yield* this.#client.fetch(server, url, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
        },
        body: Buffer.from(bytes),
      });
      const json = yield* remoteCall(() => response.json());
      return yield* remoteDecode(() =>
        addRemotePreviewUrls(
          decodeDraftAttachment(decodeTeamProtocolV1CurrentHttpResponse("POST", url.pathname, response.status, json)),
          server.id,
        ),
      );
    },
    (operation) => this.#owned(operation),
  ).bind(this);

  /** Sends a Grok Bot export to the host with `agent-import-v1` and answers its preview. */

  /** Sends a Tommy transfer file to the host with `instance-transfer-v1` and answers its preview. */
  readonly stageInstanceTransfer = Effect.fn("RemoteManager.stageInstanceTransfer")(
    function* (
      this: RemoteServerManager,
      serverId: string,
      bytes: Uint8Array,
    ): Effect.fn.Return<InstanceTransferPreview, RemoteWorkflowError, RemoteRequest> {
      const server = yield* remoteDecode(() => this.#store.require(serverId));
      const url = new URL(INSTANCE_TRANSFER_ROUTES.stage, server.apiUrl);
      const response = yield* this.#client.fetch(
        server,
        url,
        { method: "POST", headers: { "Content-Type": "application/zip" }, body: Buffer.from(bytes) },
        true,
        AGENT_IMPORT_UPLOAD_TIMEOUT_MS,
      );
      yield* this.#rejectHostError(response, url);
      const value = yield* remoteCall(() => response.json());
      return yield* remoteDecode(() => decodeRemoteInstanceTransferPreview(value));
    },
    (operation) => this.#owned(operation),
  ).bind(this);

  /** The host's transfer file, made with `instance-transfer-v1`. */
  readonly downloadInstanceTransfer = Effect.fn("RemoteManager.downloadInstanceTransfer")(
    function* (
      this: RemoteServerManager,
      serverId: string,
      input: ExportInstanceInput,
    ): Effect.fn.Return<Uint8Array, RemoteWorkflowError, RemoteRequest> {
      const server = yield* remoteDecode(() => this.#store.require(serverId));
      const url = new URL(INSTANCE_TRANSFER_ROUTES.export, server.apiUrl);
      const response = yield* this.#client.fetch(
        server,
        url,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
        true,
        AGENT_IMPORT_UPLOAD_TIMEOUT_MS,
      );
      yield* this.#rejectHostError(response, url);
      return new Uint8Array(yield* remoteCall(() => response.arrayBuffer()));
    },
    (operation) => this.#owned(operation),
  ).bind(this);

  /**
   * The WebRTC path of `fetch` answers a host error as a response, not a failure. A transfer must not
   * read that error as a file or a preview.
   */
  #rejectHostError(response: Response, url: URL) {
    return response.ok
      ? Effect.void
      : throwRemoteResponseError(response, "POST", url.pathname).pipe(
          Effect.mapError((cause) => new RemoteWorkflowError({ cause })),
        );
  }

  readonly setAgentAvatar = Effect.fn("RemoteManager.setAgentAvatar")(
    function* (
      this: RemoteServerManager,
      agentId: string,
      image: AvatarImageInput | null,
      serverId = this.#store.activeServerId,
    ): Effect.fn.Return<ClientAgentSummary, RemoteWorkflowError, RemoteRequest> {
      const server = yield* remoteDecode(() => this.#store.require(serverId));
      const url = new URL(TEAM_API_ROUTES.agent.avatar(agentId), server.apiUrl);
      const headers = new Headers();
      if (image) headers.set("Content-Type", image.mimeType);
      const response = yield* this.#client.fetch(server, url, {
        method: image ? "PUT" : "DELETE",
        headers,
        ...(image ? { body: Buffer.from(image.bytes) } : {}),
      });
      const json = yield* remoteCall(() => response.json());
      const value = yield* remoteDecode(() =>
        decodeTeamProtocolV1CurrentHttpResponse(image ? "PUT" : "DELETE", url.pathname, response.status, json),
      );
      return addRemotePreviewUrls(yield* remoteDecode(() => decodeAgentSummary(value)), server.id);
    },
    (operation) => this.#owned(operation),
  ).bind(this);

  readonly downloadAgentAvatar = Effect.fn("RemoteManager.downloadAgentAvatar")(
    function* (
      this: RemoteServerManager,
      agentId: string,
      serverId = this.#store.activeServerId,
      version?: string,
    ): Effect.fn.Return<{ bytes: Uint8Array; mimeType: string }, RemoteWorkflowError, RemoteRequest> {
      const server = yield* remoteDecode(() => this.#store.require(serverId));
      const url = new URL(TEAM_API_ROUTES.agent.avatar(agentId), server.apiUrl);
      if (version) url.searchParams.set("v", version);
      const response = yield* this.#client.fetch(server, url);
      return {
        bytes: new Uint8Array(yield* remoteCall(() => response.arrayBuffer())),
        mimeType: response.headers.get("content-type") ?? "application/octet-stream",
      };
    },
    (operation) => this.#owned(operation),
  ).bind(this);

  readonly downloadServerLogo = Effect.fn("RemoteManager.downloadServerLogo")(
    function* (
      this: RemoteServerManager,
      serverId: string,
      version: string,
    ): Effect.fn.Return<{ bytes: Uint8Array; mimeType: string }, RemoteWorkflowError, RemoteRequest> {
      const server = yield* remoteDecode(() => this.#store.require(serverId));
      if (server.logoVersion !== version)
        return yield* new RemoteWorkflowError({ cause: new Error("Server logo version is not current.") });
      if (server.transport === "webrtc-v2") {
        const logo = yield* this.request(serverId, HOST_LOGO_ROUTES.read, decodeHostLogo, {
          method: "POST",
          body: { version },
        });
        const bytes = new Uint8Array(Buffer.from(logo.data, "base64"));
        if (!isValidAvatarImage(logo.mimeType, bytes))
          return yield* new RemoteWorkflowError({ cause: new Error("Server logo response is invalid.") });
        return { bytes, mimeType: logo.mimeType };
      }
      const url = new URL(TEAM_API_ROUTES.team.logo, server.apiUrl);
      url.searchParams.set("v", version);
      const response = yield* this.#client.fetch(server, url);
      const bytes = new Uint8Array(yield* remoteCall(() => response.arrayBuffer()));
      const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
      if (!isValidAvatarImage(mimeType, bytes))
        return yield* new RemoteWorkflowError({ cause: new Error("Server logo response is invalid.") });
      return { bytes, mimeType };
    },
    (operation) => this.#owned(operation),
  ).bind(this);

  readonly downloadAttachment = Effect.fn("RemoteManager.downloadAttachment")(
    function* (
      this: RemoteServerManager,
      attachmentId: string,
      serverId = this.#store.activeServerId,
      preview = false,
      // The size that the message names. With it, the download reports its bytes and can be stopped.
      size?: number,
    ): Effect.fn.Return<RemoteAttachment, RemoteWorkflowError, RemoteRequest> {
      const server = yield* remoteDecode(() => this.#store.require(serverId));
      const progress = size === undefined ? undefined : this.#attachmentProgress(server.id, attachmentId, size);
      const load = this.#attachments.get(
        server.id,
        attachmentId,
        () =>
          this.#owned(
            Effect.gen({ self: this }, function* () {
              const response = yield* this.#client.fetch(
                server,
                new URL(TEAM_API_ROUTES.attachment(attachmentId), server.apiUrl),
                {},
                true,
                undefined,
                progress,
              );
              return {
                bytes: yield* remoteCall((signal) =>
                  // A WebRTC answer holds the whole file already, and its bytes were reported.
                  progress && server.transport !== "webrtc-v2"
                    ? countedResponseBytes(response, progress, signal)
                    : response.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
                ),
                name: contentDispositionFileName(response.headers.get("content-disposition"), attachmentId),
                mimeType: response.headers.get("content-type") ?? "application/octet-stream",
              };
            }).pipe((download) => (progress ? this.#stoppable(server.id, attachmentId, download) : download)),
          ),
        preview,
      );
      // A click can wait for a load that a preview or a ZIP started. Its stop then ends only its wait.
      // A click that starts the load stops the load itself, above, so the callers that wait get an error.
      return yield* progress ? this.#stoppable(server.id, attachmentId, load) : load;
    },
    (operation) => this.#owned(operation),
  ).bind(this);

  /** Ends a download that an open or a save started. The open or the save answers without a file. */
  stopAttachmentDownload(attachmentId: string, serverId: string): void {
    const stop = this.#attachmentStops.get(JSON.stringify([serverId, attachmentId]));
    if (stop)
      Deferred.doneUnsafe(stop, Effect.fail(new RemoteWorkflowError({ cause: new AttachmentDownloadStopped() })));
  }

  #stoppable<A>(
    serverId: string,
    attachmentId: string,
    download: Effect.Effect<A, RemoteWorkflowError, RemoteRequest>,
  ): Effect.Effect<A, RemoteWorkflowError, RemoteRequest> {
    return Effect.suspend(() => {
      const key = JSON.stringify([serverId, attachmentId]);
      const stop = Deferred.makeUnsafe<never, RemoteWorkflowError>();
      this.#attachmentStops.set(key, stop);
      // The stop interrupts the download, and the WebRTC transfer then refuses the file.
      return Effect.raceFirst(download, Deferred.await(stop)).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.#attachmentStops.get(key) === stop) this.#attachmentStops.delete(key);
          }),
        ),
      );
    });
  }

  #attachmentProgress(serverId: string, attachmentId: string, size: number): RemoteFileProgress {
    let reportedAt = 0;
    return {
      size,
      onProgress: (received, total) => {
        const now = Date.now();
        if (received < total && now - reportedAt < ATTACHMENT_PROGRESS_INTERVAL_MS) return;
        reportedAt = now;
        this.emit("attachmentDownload", { serverId, attachmentId, received, total });
      },
    };
  }

  readonly downloadSharedFile = Effect.fn("RemoteManager.downloadSharedFile")(
    function* (
      this: RemoteServerManager,
      sharedPath: string,
      serverId = this.#store.activeServerId,
      maxBytes?: number,
    ): Effect.fn.Return<{ bytes: Uint8Array; name: string }, RemoteWorkflowError, RemoteRequest> {
      const server = yield* remoteDecode(() => this.#store.require(serverId));
      const url = new URL(TEAM_API_ROUTES.sharedFiles, server.apiUrl);
      url.searchParams.set("path", sharedPath);
      const response = yield* this.#client.fetch(server, url);
      return {
        bytes: yield* remoteCall(() => fileResponseBytes(response, maxBytes)),
        name: contentDispositionFileName(response.headers.get("content-disposition"), basename(sharedPath)),
      };
    },
    (operation) => this.#owned(operation),
  ).bind(this);

  readonly downloadWorkspaceFile = Effect.fn("RemoteManager.downloadWorkspaceFile")(
    function* (
      this: RemoteServerManager,
      agentId: string,
      workspacePath: string,
      serverId = this.#store.activeServerId,
      maxBytes?: number,
    ): Effect.fn.Return<{ bytes: Uint8Array; name: string }, RemoteWorkflowError, RemoteRequest> {
      const server = yield* remoteDecode(() => this.#store.require(serverId));
      const url = new URL(TEAM_API_ROUTES.workspaceFiles, server.apiUrl);
      // A query parameter never reaches the JSON adapters, so it keeps the released spelling.
      url.searchParams.set("botId", agentId);
      url.searchParams.set("path", workspacePath);
      const response = yield* this.#client.fetch(server, url);
      return {
        bytes: yield* remoteCall(() => fileResponseBytes(response, maxBytes)),
        name: contentDispositionFileName(response.headers.get("content-disposition"), basename(workspacePath)),
      };
    },
    (operation) => this.#owned(operation),
  ).bind(this);

  readonly stop = Effect.fn("RemoteManager.stop")(function* (this: RemoteServerManager) {
    if (this.#stopping) return yield* Deferred.await(this.#stopping);
    const done = Deferred.makeUnsafe<void, RemoteWorkflowError>();
    this.#stopping = done;
    return yield* Effect.gen({ self: this }, function* () {
      this.#focusUse.dispose();
      this.#desktopFocus.dispose();
      yield* this.#events.stop();
      this.#refresh.clear();
      this.#client.clear();
      this.#attachments.clear();
      if (this.#remoteViewerProxy) yield* this.#remoteViewerProxy.stop().pipe(Effect.catch(() => Effect.void));
      if (this.#webrtcTransport) yield* this.#webrtcTransport.stop().pipe(Effect.catch(() => Effect.void));
      yield* Scope.close(this.#scope, Exit.void);
      while (this.#operations.size)
        yield* Effect.forEach([...this.#operations], Deferred.await, { concurrency: "unbounded" });
      yield* this.#selections.withPermit(Effect.void);
      this.#stopped = true;
    }).pipe(Effect.onExit((exit) => Deferred.done(done, exit)));
  }).bind(this);

  /** Whether a client-side file transfer is moving right now, either direction. */
  hasActiveTransfers(): boolean {
    return this.#webrtcTransport?.hasActiveTransfers() ?? false;
  }

  readonly disconnectRemoteSessions = Effect.fn("RemoteManager.disconnectRemoteSessions")(
    function* (this: RemoteServerManager): Effect.fn.Return<void, RemoteWorkflowError, RemoteRequest> {
      const transport = this.#webrtcTransport;

      // A copy skips the host's check of the account, so the next account must not see it.
      this.#attachments.clear();
      if (!transport) return;
      // First: a session kept for the next run belongs to the account that leaves.
      yield* transport.forgetStoredSessions();
      yield* Effect.forEach(
        this.#store.servers.filter((server) => server.transport === "webrtc-v2"),
        (server) => transport.disconnect(server.id),
        { concurrency: "unbounded", discard: true },
      );
    },
    (operation) => this.#owned(operation),
  ).bind(this);

  readonly #syncWebRtcHosts = Effect.fn("RemoteManager.syncWebRtcHosts")(function* (
    this: RemoteServerManager,
  ): Effect.fn.Return<void, RemoteWorkflowError, RemoteRequest> {
    const transport = this.#webrtcTransport;
    if (!transport) return;
    yield* this.#directorySync.withPermit(this.#syncWebRtcHostsOnce(transport));
  });

  readonly #syncWebRtcHostsOnce = Effect.fn("RemoteManager.syncWebRtcHostsOnce")(function* (
    this: RemoteServerManager,
    transport: TeamWebRtcClientTransport,
  ): Effect.fn.Return<void, RemoteWorkflowError, RemoteRequest> {
    const hosts = yield* transport.listHosts();
    // The account can be signed out or not loaded yet; that is a failed read, not a defect.
    const email = yield* remoteDecode(() => this.#centralAccount.getEmail());
    const localHostId = this.#getLocalHostId();
    this.#localMemberLimit = hosts.find((host) => host.hostId === localHostId)?.memberLimit ?? null;
    const followedHandovers = yield* followedHostKeyHandovers({
      hosts,
      servers: this.#store.servers,
      preservedIdentities: this.#store.preservedIdentities,
    });
    const { servers, removedHostIds, staleTransportHostIds, pinnedKeys } = reconcileWebRtcHosts({
      hosts,
      followedHandovers,
      isConnected: (hostId) => transport.isConnected(hostId),
      servers: this.#store.servers,
      preservedIdentities: this.#store.preservedIdentities,
      localHostId,
      isHiddenHost: (hostId) => this.#store.isHiddenHost(hostId),
      username: email.trim().toLowerCase(),
      keepOtherTransports: false,
      isThisComputer: (serverId) => this.#thisComputerServers.has(serverId),
    });
    for (const { hostId, publicKey } of pinnedKeys) transport.pinHostKey(hostId, publicKey);
    // This computer's own host uses the key that it lists. A joined host uses the key that is pinned.
    const keys = new Map(servers.map((server) => [server.id, server.publicKey]));
    const changeTimes = yield* hostKeyChangeTimes(hosts, (host) =>
      host.hostId === localHostId ? host.devicePublicKey : keys.get(host.hostId),
    );
    this.#keyChangedAt = new Map(
      [...changeTimes].map(([hostId, changedAt]) => [hostId === localHostId ? LOCAL_SERVER_ID : hostId, changedAt]),
    );
    for (const serverId of removedHostIds) {
      yield* transport.disconnect(serverId).pipe(Effect.catch(() => Effect.void));
      this.#clearServerConnectionState(serverId);
    }
    // Before the store changes, because after it `ensure` answers for the new entry: it branches on
    // the transport it finds and starts the WebRTC one beside an HTTPS controller it never aborts,
    // so both would deliver the same events and the socket for an entry that no longer exists could
    // still mark a healthy host offline. No `disconnect` -- see `staleTransportHostIds`.
    for (const serverId of staleTransportHostIds) this.#clearServerConnectionState(serverId);
    yield* this.#store.replaceServers(servers);
    // This computer has no server of its own, so the paired server is always the selected one.
    const only = servers[0];
    if (only && this.#store.activeServerId !== only.id) {
      this.#store.setActiveServerId(only.id);
      yield* this.#store.persist().pipe(Effect.catch(() => Effect.void));
      this.#events.syncScopes();
    }
  });

  #handleWebRtcEvent(serverId: string, event: AgentEvent | TeamRealtimeEvent): void {
    if (event.type === "team-identity") {
      this.#applyServerIdentity(serverId, event);
    } else if (event.type === "team-presence") {
      this.#presence.accept(serverId, event.snapshot);
    } else if (event.type === "team-direct-message" || event.type === "team-direct-typing") {
      // An older server can still send these. This app has no direct messages.
    } else if (event.type === "host-restart") this.#applyHostRestart(serverId, event);
    else if (event.type === "machine-alert") this.emit("machineAlert", serverId, event);
    else this.#background(this.#owned(this.#refresh.forward(serverId, event)));
  }

  /** A host that restarts into an update is away for a short time: it keeps the fast retry for a limited time. */
  #awaitsHostRestart(serverId: string): boolean {
    if (!this.#connections.hostRestartFor(serverId)) return false;
    const now = Date.now();
    const since = this.#hostRestartAway.get(serverId) ?? now;
    this.#hostRestartAway.set(serverId, since);
    if (now - since < HOST_RESTART_RETRY_MS) return true;
    this.#hostRestartAway.delete(serverId);
    if (this.#connections.setHostRestart(serverId, null)) this.#emitChanged();
    return false;
  }

  #applyHostRestart(serverId: string, { state, version }: HostRestartEvent): void {
    if (this.#connections.setHostRestart(serverId, state === "none" ? null : { state, version })) this.#emitChanged();
  }

  // Best effort, the same as the screen sharing flag. The host sends an identity whenever it changes,
  // so a store that cannot be written must not turn one of them into an uncaught exception in the main
  // process. The new name stays in memory and the next write of any field saves it.
  #applyServerIdentity(serverId: string, identity: { serverName: string; logoVersion: string | null }): void {
    this.#background(
      this.#owned(
        this.#store.update(serverId, { name: identity.serverName, logoVersion: identity.logoVersion }).pipe(
          Effect.tap(() => Effect.sync(() => this.#emitChanged())),
          Effect.catch(() => Effect.void),
        ),
      ),
    );
  }

  #emitChanged(): void {
    this.#syncFocusUse();
    this.emit("changed", this.list());
  }

  #syncFocusUse(): void {
    const serverId = this.#store.activeServerId;
    const focused =
      !this.#stopping &&
      this.#appFocused &&
      this.#connections.stateFor(serverId) === "online" &&
      this.supportsCapability(serverId, FOCUS_USE_CAPABILITY);
    this.#focusUse.setTarget(focused ? serverId : null);
    this.#desktopFocus.setTarget(
      !this.#stopping &&
        this.#appFocused &&
        this.#connections.stateFor(serverId) === "online" &&
        this.supportsCapability(serverId, DESKTOP_FOCUS_CAPABILITY)
        ? serverId
        : null,
    );
  }
}

function requiredServerSummary(servers: ServerSummary[], serverId: string): ServerSummary {
  const server = servers.find((candidate) => candidate.id === serverId);
  if (!server) throw new Error("Remote server summary is missing.");
  return server;
}

/**
 * The body of a host file, read in parts so that `progress` gets the bytes as they arrive. The total
 * is the length that the host names, or the size that the message names.
 */
async function countedResponseBytes(
  response: Response,
  progress: RemoteFileProgress,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const stop = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", stop, { once: true });
  try {
    const named = Number(response.headers.get("content-length"));
    const total = Number.isSafeInteger(named) && named > 0 ? named : progress.size;
    const parts: Uint8Array[] = [];
    let received = 0;
    progress.onProgress(0, total);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value.byteLength;
      progress.onProgress(Math.min(received, total), total);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/**
 * The body of a host file. With `maxBytes`, a preview that names a larger size stops before it reads
 * the body. A host that names no size is read, and the result is checked.
 */
async function fileResponseBytes(response: Response, maxBytes: number | undefined): Promise<Uint8Array> {
  if (maxBytes !== undefined && Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error(sourceText("error.attachment.previewTooLarge"));
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (maxBytes !== undefined && bytes.byteLength > maxBytes)
    throw new Error(sourceText("error.attachment.previewTooLarge"));
  return bytes;
}
