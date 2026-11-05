import {
  DIRECT_CLOSE_DEVICE_REVOKED,
  DIRECT_FILES_PATH,
  DIRECT_FILES_TOKEN_QUERY,
  DirectHello,
  decodeDirectFrame,
  directConnectionBinding,
  encodeDirectFrame,
} from "@tommy/contracts/direct-connection";
import type { AgentEvent, TeamRealtimeEvent } from "@tommy/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@tommy/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@tommy/contracts/team-api-routes";
import {
  decodeTeamProtocolV2AuthFrame,
  decodeTeamProtocolV2EventFrame,
  decodeTeamProtocolV2RpcFrame,
  decodeTeamProtocolV8CurrentEvent,
  decodeTeamProtocolV9WebRtcHttpResponse,
  encodeTeamProtocolV2Frame,
  encodeTeamProtocolV8WebRtcHttpRequest,
  TEAM_PROTOCOL_V2_MAX_FILE_BYTES,
  type TeamProtocolV2AuthFrame,
  type TeamProtocolV2Json,
  teamCapabilitiesForProtocol,
  teamProtocolV2AuthenticationTranscript,
} from "@tommy/contracts/team-protocol";
import { optionalTeamEvent, optionalTeamEventToCurrent } from "@tommy/contracts/team-protocol/optional-events";
import { teamSideRouteCodec } from "@tommy/contracts/team-protocol/side-routes";
import { addUiBlockAutoAnswers } from "@tommy/contracts/team-protocol/ui-block-auto-answer-v1";
import { addUiBlockVaultRequests } from "@tommy/contracts/team-protocol/ui-block-vault-v1";
import {
  type TeamProtocolV1CurrentEventControl,
  toWireTeamProtocolV1ClientEvent,
} from "@tommy/contracts/team-protocol/v1-adapter";
import { decodeTeamProtocolSupportV9, TEAM_PROTOCOL_V9 } from "@tommy/contracts/team-protocol/v9";
import { sourceText } from "@tommy/i18n/source";
import { errorReference, referenceFrom } from "@tommy/user-errors/reference";
import { Context, Deferred, Effect, Exit, Layer, ManagedRuntime, Result, Schema, Scope } from "effect";
import { base64ToBytes, base64UrlToBytes, bytesToBase64Url } from "./base64";
import { type Ed25519Identity, signEd25519, verifyEd25519Pem } from "./ed25519";

/** `reference` is the code a user can copy, such as `signal/host_busy`. It never holds server text. */
class RemotePeerError extends Schema.TaggedError<RemotePeerError>()("RemotePeerError", {
  message: Schema.String,
  reference: Schema.optional(Schema.NullOr(Schema.String)),
}) {}
/** The reference of a failure. A peer error keeps its own; any other error gets one from its code or name. */
const failureReference = (error: unknown): string | null =>
  error instanceof RemotePeerError ? (error.reference ?? null) : errorReference(error);
const peerError = (error: unknown) =>
  error instanceof RemotePeerError
    ? error
    : new RemotePeerError({
        message: error instanceof Error ? error.message : sourceText("error.remote.operationFailed"),
        reference: failureReference(error),
      });
const referenced = (message: string, reference: string | null) => new RemotePeerError({ message, reference });

const peerCall = <A>(operation: () => Promise<A> | A) =>
  Effect.tryPromise({ try: async () => operation(), catch: peerError });
const peerDecode = <A>(operation: () => A) => Effect.try({ try: operation, catch: peerError });

import { createRemoteFileReceiver } from "./file-download";
import { createRemoteFileSender, type RemoteFileUpload } from "./file-upload";
import { markRemoteSync, type RemoteRequestProfile, startRemoteRequest } from "./sync-profile";

export type { RemoteFileUpload } from "./file-upload";
export { MOBILE_ATTACHMENT_BYTES } from "./file-upload";

import { createTeamRequestId } from "./request-id";

// A type, not an interface: the command crosses the native/DOM bridge as JSON.
export type RemoteLargeDownload = {
  maxBytes: number;
  mimeType: string;
};

export type RemoteTeamCommand =
  | { id: string; type: "connect"; hostId: string; hostPublicKey: string }
  | { id: string; type: "disconnect" }
  | {
      id: string;
      type: "request";
      method: string;
      path: string;
      body: TeamProtocolV2Json;
      upload?: RemoteFileUpload | undefined;
      timeoutMs?: number | undefined;
      /** A larger cap for the one file that answers this request, such as a transfer file. */
      largeDownload?: RemoteLargeDownload | undefined;
    };

/** What a paired device needs to connect. `url` is the address of the connect socket, with the device ID. */
export interface RemoteTeamDevice {
  sessionId: string;
  ticket: string;
  url: string;
  identity: Ed25519Identity;
}

export interface RemoteTeamCommandResult {
  commandId: string;
  ok: boolean;
  status?: number;
  body?: TeamProtocolV2Json;
  error?: string;
  /** The code a user can copy for `error`, such as `webrtc/ice/failed`. */
  reference?: string;
}

export interface RemoteTeamConnectionUpdate {
  hostId: string;
  state: "connecting" | "online" | "offline";
  message: string | null;
  /**
   * Set when no reconnect can fix this failure, because the two ends disagree about the wire rather
   * than about whether there is one. A consumer that retries every offline update has to be told
   * the difference, or it retries into the same frame forever.
   */
  code?: "protocol_error" | "session_revoked";
  /** The code a user can copy for `message`, such as `signal/host_busy`. */
  reference?: string;
  resync?: boolean;
  /**
   * With `state: "connecting"`: the host is not connected to Signal. Signal holds this attempt and
   * continues it when the host connects, so the consumer must not start another attempt.
   */
  hostOffline?: true;
}

/**
 * One step of a connection, for the support log on the device. It names no ticket, token, address,
 * candidate or content: `detail` is a fixed state, a number, or the English error the peer reports.
 */
export interface RemoteTeamDiagnostic {
  hostId: string;
  step: "event-reset" | "socket-open" | "socket-closed" | "event-gap" | "authenticated" | "failed";
  detail?: string;
}

/** How much of one upload command's file has been sent. */
export interface RemoteUploadProgress {
  commandId: string;
  sent: number;
  total: number;
}

export interface RemoteTeamPeerActions {
  /** Hears upload progress, at most once per whole percent. Optional, and never affects the upload. */
  onUploadProgress?: (progress: RemoteUploadProgress) => Promise<void>;
  /** A message of a live browser view. */
  onHostStreamData?: (data: string | ArrayBuffer) => void;
  /** What this device needs to connect to its host. */
  getDevice: (hostId: string) => Promise<RemoteTeamDevice>;
  onConnectionUpdate: (update: RemoteTeamConnectionUpdate) => Promise<void>;
  /** Hears connection steps. Optional, and never affects the connection. */
  onDiagnostic?: (diagnostic: RemoteTeamDiagnostic) => Promise<void>;
  /** The platform reported that the network came back. A consumer that waits to retry can retry now. */
  onNetworkRestored?: () => Promise<void>;
  onTeamEvent: (hostId: string, event: AgentEvent | TeamRealtimeEvent) => Promise<void>;
}
interface ActionsRef {
  current: RemoteTeamPeerActions;
}
type ChannelKind = "rpc" | "events" | "files" | "desktop";

interface PendingRequest {
  method: string;
  path: string;
  resolve: (value: { status: number; body: TeamProtocolV2Json }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  profile: RemoteRequestProfile | null;
}

interface PeerState {
  generation: number;
  hostId: string;
  hostPublicKey: string;
  device: RemoteTeamDevice;
  socket: WebSocket | null;
  /** The separate files socket, once it is open, so that a file does not hold back chat. */
  filesSocket: WebSocket | null;
  /** Settles once: the files socket opened, or files go on the connect socket. */
  filesDecided: Deferred.Deferred<void>;
  clientNonce: string;
  hostNonce: string | null;
  binding: { clientFingerprint: string; hostFingerprint: string } | null;
  authenticated: boolean;
  closed: boolean;
  /** A frame arrived after the last heartbeat. */
  alive: boolean;
  heartbeat: ReturnType<typeof setInterval> | null;
  /** The frames of each channel run one at a time, in the order they arrive. */
  handled: Record<ChannelKind, Promise<unknown>>;
  lastEventSequence: number;
  connected: Deferred.Deferred<void, RemotePeerError> | null;
  readonly abort: AbortController;
  connectedTimer: ReturnType<typeof setTimeout> | null;
  /** The host answered a request on this peer. */
  answeredRequest: boolean;
  hostProtocol: number | undefined;
  /** The compatibility read in flight. A request waits for it when the host protocol is not known. */
  hostProtocolRead?: Deferred.Deferred<void>;
}

const REQUEST_TIMEOUT_MS = 10 * 60_000 + 30_000;
const MAXIMUM_BUFFERED_BYTES = 4 * 1024 * 1024;
const BACKPRESSURE_TIMEOUT_MS = 60_000;
const BUFFER_CHECK_INTERVAL_MS = 50;
const CONNECT_TIMEOUT_MS = 30_000;
/** A socket that sends nothing for one interval gets a ping, and is closed after the next one. */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** A phone that returns from the background or gets a network waits this long for a sign of the socket. */
const PROBE_TIMEOUT_MS = 5_000;
/** How long a file waits for the files socket. After it, files go on the connect socket. */
const FILES_SOCKET_TIMEOUT_MS = 5_000;
/** The answer to the first compatibility read of a peer can take longer than the later ones. */
const FIRST_PROBE_TIMEOUT_MS = 15_000;
const PROBE_REQUEST_TIMEOUT_MS = 10_000;

const decodeHello = Schema.decodeUnknownSync(DirectHello);

class RemotePeerIO extends Context.Service<
  RemotePeerIO,
  {
    connectionUpdate(update: RemoteTeamConnectionUpdate): Effect.Effect<void, RemotePeerError>;
    teamEvent(hostId: string, event: AgentEvent | TeamRealtimeEvent): Effect.Effect<void, RemotePeerError>;
  }
>()("@tommy/team-client/RemotePeerIO") {
  static layer(actions: ActionsRef) {
    return Layer.succeed(
      RemotePeerIO,
      RemotePeerIO.of({
        connectionUpdate: Effect.fn("RemotePeerIO.connectionUpdate")((update: RemoteTeamConnectionUpdate) =>
          peerCall(() => actions.current.onConnectionUpdate(update)),
        ),
        teamEvent: Effect.fn("RemotePeerIO.teamEvent")((hostId: string, event: AgentEvent | TeamRealtimeEvent) =>
          peerCall(() => actions.current.onTeamEvent(hostId, event)),
        ),
      }),
    );
  }
}

/** The highest protocol of each host, from its last compatibility read. */
export interface RemoteHostProtocols {
  get(hostId: string): number | undefined;
  set(hostId: string, protocol: number): void;
}

/** `hostProtocols` can keep the protocols after the peer ends; the default keeps them for the life of the peer. */
export function createRemoteTeamPeer(actions: ActionsRef, options: { hostProtocols?: RemoteHostProtocols } = {}) {
  const runtime = ManagedRuntime.make(RemotePeerIO.layer(actions));
  const workScope = Scope.makeUnsafe();
  const running = new Set<Promise<unknown>>();

  function runPeerEffect<A, E>(operation: Effect.Effect<A, E, RemotePeerIO>): Promise<A> {
    const pending = runtime.runPromise(Effect.result(operation)).then((result) => {
      if (Result.isFailure(result)) throw result.failure;
      return result.success;
    });
    running.add(pending);
    return pending.finally(() => running.delete(pending));
  }

  let active = true;
  let peer: PeerState | null = null;
  let generation = 0;
  const pendingRequests = new Map<string, PendingRequest>();
  const files = createRemoteFileSender(
    (data) =>
      Effect.suspend(() => {
        const state = peer;
        if (!state || !isPeerOnline(state))
          return Effect.fail(new RemotePeerError({ message: sourceText("error.remote.selectedServerOffline") }));
        return sendPayload(state, "files", data);
      }),
    () => createTeamRequestId((size) => crypto.getRandomValues(new Uint8Array(size))),
  );
  const downloads = createRemoteFileReceiver((data) =>
    Effect.suspend(() => {
      const state = peer;
      if (!state || !isPeerOnline(state))
        return Effect.fail(new RemotePeerError({ message: sourceText("error.remote.selectedServerOffline") }));
      return sendPayload(state, "files", data);
    }),
  );
  // A new peer of a known host sends the capabilities of its last protocol. With the bootstrap
  // capabilities, the host would hide the agents of the providers that protocol 7 does not know.
  const hostProtocols: RemoteHostProtocols = options.hostProtocols ?? new Map<string, number>();

  return {
    async sendHostStreamData(data: string) {
      const state = peer;
      if (!state || !isPeerOnline(state)) throw new Error(sourceText("error.remote.selectedServerOffline"));
      await runPeerEffect(sendPayload(state, "desktop", data));
    },
    cancelUpload: () => runPeerEffect(files.cancelUpload()),
    /** Tells the host which agent this member is writing to. The host clears it after a few seconds. */
    setTyping(agentId: string | null, typing: boolean) {
      const state = peer;
      if (!state || !isPeerOnline(state)) return;
      void runPeerEffect(sendEventControl(state, { type: "team-typing", agentId, typing })).catch(() => undefined);
    },
    execute: (command: RemoteTeamCommand) => runPeerEffect(executeCommand(command, actions)),
    dispose: async () => {
      active = false;
      await runPeerEffect(closePeer());
      await Promise.allSettled([...running]);
      await runPeerEffect(Scope.close(workScope, Exit.void));
      await runtime.dispose();
    },
    setActive(value: boolean) {
      const wasActive = active;
      active = value;
      const state = peer;
      if (!state) return;
      if (!active) {
        // Timers do not run in the background, so a heartbeat would read a live socket as dead.
        stopHeartbeat(state);
        // The host can commit a sent write while the app is inactive. Keep its
        // response registered so the caller does not offer to send it again.
        rejectRequests(new Error(sourceText("error.remote.appInBackground")), true);
        if (!state.authenticated) failPeer(state, new Error(sourceText("error.remote.appInBackground")), actions);
      } else if (!wasActive) {
        if (!isPeerOnline(state)) {
          failPeer(state, new Error(sourceText("error.remote.desktopRestoreNeeded")), actions);
          return;
        }
        // The recovery owner reloads workspace reads on every foreground return.
        startHeartbeat(state, actions);
        probeSocket(state, actions);
      }
    },
    /** The socket from before a network change can read as open and deliver nothing. */
    networkRestored() {
      const state = peer;
      if (active && state && !state.closed && state.authenticated) probeSocket(state, actions);
      void runPeerEffect(peerCall(() => actions.current.onNetworkRestored?.())).catch(() => undefined);
    },
  };
  function diagnosticCall(state: PeerState, step: RemoteTeamDiagnostic["step"], detail?: string) {
    markRemoteSync(`peer:${step}`);
    const diagnostic: RemoteTeamDiagnostic = { hostId: state.hostId, step, ...(detail ? { detail } : {}) };
    return peerCall(() => actions.current.onDiagnostic?.(diagnostic));
  }

  /** For native callbacks. Effect code yields `notify(diagnosticCall(...))` instead. */
  function diagnose(state: PeerState, step: RemoteTeamDiagnostic["step"], detail?: string): void {
    void runPeerEffect(diagnosticCall(state, step, detail)).catch(() => undefined);
  }

  /** Starts a consumer callback in the peer's work scope without waiting for it; a failure is ignored. */
  function notify<A, E>(operation: Effect.Effect<A, E, RemotePeerIO>) {
    return Effect.forkIn(operation.pipe(Effect.ignore), workScope, { startImmediately: true });
  }

  function isPeerOnline(state: PeerState): boolean {
    return state.authenticated && !state.closed && state.socket?.readyState === WebSocket.OPEN;
  }

  function startHeartbeat(state: PeerState, actions: ActionsRef): void {
    stopHeartbeat(state);
    state.alive = true;
    state.heartbeat = setInterval(() => {
      if (!state.alive) {
        failPeer(state, referenced(sourceText("error.remote.desktopOffline"), "direct/heartbeat"), actions);
        return;
      }
      state.alive = false;
      sendPing(state);
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat(state: PeerState): void {
    if (state.heartbeat !== null) clearInterval(state.heartbeat);
    state.heartbeat = null;
  }

  function sendPing(state: PeerState): void {
    if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(encodeDirectFrame("ping"));
  }

  /** Asks the host for a frame now. A socket that stays silent ends, and the recovery owner connects again. */
  function probeSocket(state: PeerState, actions: ActionsRef): void {
    state.alive = false;
    sendPing(state);
    setTimeout(() => {
      if (!state.alive && !state.closed && peer === state)
        failPeer(state, referenced(sourceText("error.remote.desktopOffline"), "direct/probe"), actions);
    }, PROBE_TIMEOUT_MS);
  }

  function executeCommand(
    command: RemoteTeamCommand,
    actions: ActionsRef,
  ): Effect.Effect<RemoteTeamCommandResult, RemotePeerError, RemotePeerIO> {
    return Effect.fn("RemotePeer.executeCommand")(function* () {
      let commandGeneration = generation;
      const result = yield* Effect.gen(function* () {
        if (command.type === "connect") {
          if (!active) return yield* new RemotePeerError({ message: sourceText("error.remote.appInBackground") });
          if (peer && peer.hostId === command.hostId && peer.hostPublicKey === command.hostPublicKey) {
            if (peer.connected) {
              const connected = peer.connected;
              yield* Deferred.await(connected);
              return { commandId: command.id, ok: true };
            }
            if (isPeerOnline(peer)) return { commandId: command.id, ok: true };
          }
          yield* closePeer();
          commandGeneration = generation + 1;
          yield* connectPeerEffect(command.hostId, command.hostPublicKey, actions);
          return { commandId: command.id, ok: true };
        }
        if (command.type === "disconnect") {
          yield* closePeer();
          return { commandId: command.id, ok: true };
        }
        let reported = -1;
        const response = yield* requestEffect(
          command.method,
          command.path,
          command.body,
          command.upload,
          (sent, total) => {
            const percent = total > 0 ? Math.floor((sent / total) * 100) : 100;
            if (percent === reported) return;
            reported = percent;
            void runPeerEffect(
              peerCall(() => actions.current.onUploadProgress?.({ commandId: command.id, sent, total })),
            ).catch(() => undefined);
          },
          command.timeoutMs,
          command.largeDownload,
        );
        return { commandId: command.id, ok: true, status: response.status, body: response.body };
      }).pipe(Effect.result);
      if (Result.isSuccess(result)) return result.success;
      const error = result.failure;
      {
        const message = error.message;
        const reference = failureReference(error);
        const referenceField = reference ? { reference } : {};
        if (command.type === "connect" && commandGeneration === generation) {
          yield* RemotePeerIO.use((io) =>
            io.connectionUpdate({ hostId: command.hostId, state: "offline", message, ...referenceField }),
          );
        }
        return {
          commandId: command.id,
          ok: false,
          error: message,
          ...referenceField,
        };
      }
    })();
  }

  function connectPeerEffect(hostId: string, hostPublicKey: string, actions: ActionsRef) {
    return Effect.fn("RemotePeer.connectPeer")(function* () {
      if (!active) return yield* new RemotePeerError({ message: sourceText("error.remote.appInBackground") });
      const currentGeneration = ++generation;
      yield* RemotePeerIO.use((io) => io.connectionUpdate({ hostId, state: "connecting", message: null }));
      const device = yield* peerCall(() => actions.current.getDevice(hostId));
      if (currentGeneration !== generation || !active)
        return yield* new RemotePeerError({ message: sourceText("error.remote.connectionReplaced") });
      const state: PeerState = {
        generation: currentGeneration,
        hostId,
        hostPublicKey,
        device,
        socket: null,
        filesSocket: null,
        filesDecided: Deferred.makeUnsafe<void>(),
        clientNonce: randomBase64Url(32),
        hostNonce: null,
        binding: null,
        authenticated: false,
        closed: false,
        alive: true,
        heartbeat: null,
        handled: {
          rpc: Promise.resolve(),
          events: Promise.resolve(),
          files: Promise.resolve(),
          desktop: Promise.resolve(),
        },
        lastEventSequence: 0,
        connected: null,
        abort: new AbortController(),
        connectedTimer: null,
        answeredRequest: false,
        hostProtocol: hostProtocols.get(hostId),
      };
      peer = state;
      const connected = Deferred.makeUnsafe<void, RemotePeerError>();
      state.connected = connected;
      state.connectedTimer = setTimeout(
        () => failPeer(state, referenced(sourceText("error.remote.desktopDidNotConnect"), "timeout/connect"), actions),
        CONNECT_TIMEOUT_MS,
      );
      try {
        openSocket(state, actions);
      } catch (error) {
        yield* failPeerEffect(state, error, actions);
      }
      yield* Deferred.await(connected);
    })();
  }

  function openSocket(state: PeerState, actions: ActionsRef): void {
    const socket = new WebSocket(state.device.url);
    socket.binaryType = "arraybuffer";
    state.socket = socket;
    socket.onopen = () => {
      if (state.socket === socket) diagnose(state, "socket-open");
    };
    socket.onmessage = (event) => {
      if (state.closed || state.socket !== socket) return;
      state.alive = true;
      const { data } = event;
      if (data instanceof ArrayBuffer) {
        receive(state, "files", data, actions);
        return;
      }
      const frame = isString(data) ? decodeDirectFrame(data) : null;
      if (!frame) {
        failPeer(state, new Error(sourceText("error.remote.malformedEvent")), actions, "protocol_error");
        return;
      }
      if (frame.kind === "hello") handleHello(state, frame.payload, actions);
      else if (frame.kind === "rpc" || frame.kind === "events" || frame.kind === "files" || frame.kind === "desktop")
        receive(state, frame.kind, frame.payload, actions);
      else if (frame.kind === "desktopBinary") receive(state, "desktop", base64ToBytes(frame.payload).buffer, actions);
    };
    socket.onerror = () => socket.close();
    socket.onclose = (event?: CloseEvent) => {
      if (state.socket !== socket || state.closed) return;
      diagnose(state, "socket-closed", `code ${event?.code ?? "unknown"}`);
      socketEnded(state, event?.code, actions);
    };
  }

  /** The host closes both sockets with the code of a revoke, and either close can arrive first. */
  function socketEnded(state: PeerState, code: number | undefined, actions: ActionsRef): void {
    if (code === DIRECT_CLOSE_DEVICE_REVOKED) {
      failPeer(
        state,
        referenced(sourceText("error.remote.deviceRevoked"), "direct/revoked"),
        actions,
        "session_revoked",
      );
      return;
    }
    failPeer(
      state,
      referenced(sourceText("error.remote.desktopOffline"), referenceFrom("direct", "close", code)),
      actions,
    );
  }

  function handleHello(state: PeerState, payload: string, actions: ActionsRef): void {
    try {
      const hello = decodeHello(JSON.parse(payload));
      const binding = directConnectionBinding(hello.connectionId);
      state.binding = { clientFingerprint: binding.client, hostFingerprint: binding.host };
      openFilesSocket(state, hello.filesToken, actions);
      startHeartbeat(state, actions);
      void runPeerEffect(beginAuthentication(state)).catch((error) => failPeer(state, error, actions));
    } catch (error) {
      failPeer(state, error, actions, "protocol_error");
    }
  }

  /** It opens in the background, and the first screen does not wait for it. */
  function openFilesSocket(state: PeerState, token: string, actions: ActionsRef): void {
    const url = new URL(state.device.url);
    url.pathname = DIRECT_FILES_PATH;
    url.search = "";
    url.searchParams.set(DIRECT_FILES_TOKEN_QUERY, token);
    const socket = new WebSocket(url.toString());
    socket.binaryType = "arraybuffer";
    const decide = () => Deferred.doneUnsafe(state.filesDecided, Effect.void);
    const timer = setTimeout(decide, FILES_SOCKET_TIMEOUT_MS);
    socket.onopen = () => {
      clearTimeout(timer);
      state.filesSocket = socket;
      decide();
    };
    socket.onmessage = (event) => {
      const { data } = event;
      if (!state.closed && (isString(data) || data instanceof ArrayBuffer)) receive(state, "files", data, actions);
    };
    socket.onerror = () => socket.close();
    socket.onclose = (event?: CloseEvent) => {
      clearTimeout(timer);
      decide();
      // Frames of a transfer can be lost with this socket, so the whole connection starts again.
      if (state.filesSocket === socket && !state.closed) socketEnded(state, event?.code, actions);
    };
  }

  function receive(state: PeerState, kind: ChannelKind, data: string | ArrayBuffer, actions: ActionsRef): void {
    state.handled[kind] = state.handled[kind]
      .then(() => runPeerEffect(handleChannelData(state, kind, data)))
      .catch((error) => failPeer(state, error, actions));
  }

  function beginAuthentication(state: PeerState) {
    return Effect.fn("RemotePeer.beginAuthentication")(function* () {
      const binding = state.binding;
      if (!binding) return yield* new RemotePeerError({ message: "The connection binding is unavailable." });
      const { device } = state;
      const transcript = yield* peerDecode(() =>
        teamProtocolV2AuthenticationTranscript({
          hostId: state.hostId,
          sessionId: device.sessionId,
          ticket: device.ticket,
          clientPublicKey: device.identity.publicKeyPem,
          clientNonce: state.clientNonce,
          clientFingerprint: binding.clientFingerprint,
          hostFingerprint: binding.hostFingerprint,
        }),
      );
      const signature = yield* signEd25519(new TextEncoder().encode(transcript), device.identity.secretKey);
      yield* sendPayload(
        state,
        "rpc",
        yield* peerDecode(() =>
          encodeTeamProtocolV2Frame({
            version: 2,
            type: "auth-init",
            ticket: device.ticket,
            clientPublicKey: device.identity.publicKeyPem,
            clientNonce: state.clientNonce,
            signature: bytesToBase64Url(signature),
          }),
        ),
      );
    })();
  }

  function handleChannelData(state: PeerState, kind: ChannelKind, data: string | ArrayBuffer) {
    return Effect.fn("RemotePeer.handleChannelData")(function* () {
      if (state.closed || peer !== state) return;
      if (kind === "desktop") {
        if (state.authenticated) actions.current.onHostStreamData?.(data);
        return;
      }
      if (kind === "files") {
        if (!state.authenticated)
          return yield* new RemotePeerError({ message: sourceText("error.remote.dataBeforeAuth") });
        if (!(yield* downloads.receive(data)) && isString(data)) yield* peerDecode(() => files.receive(data));
        return;
      }
      if (!isString(data)) return;
      if (kind === "rpc" && !state.authenticated) {
        yield* handleAuthenticationFrameEffect(state, yield* peerDecode(() => decodeTeamProtocolV2AuthFrame(data)));
        return;
      }
      if (!state.authenticated)
        return yield* new RemotePeerError({ message: sourceText("error.remote.dataBeforeAuth") });
      if (kind === "rpc") {
        const frame = yield* peerDecode(() => decodeTeamProtocolV2RpcFrame(data));
        if (frame.type !== "response")
          return yield* new RemotePeerError({ message: "The host returned an invalid RPC frame." });
        state.answeredRequest = true;
        const pending = pendingRequests.get(frame.requestId);
        if (!pending) return;
        pending.profile?.responded(data);
        // The host's code names its operation. Its text stays the message, as before.
        if ("error" in frame)
          pending.reject(referenced(frame.error.message, referenceFrom("host", frame.error.status, frame.error.code)));
        else if (!isDynamicRecord(frame.result) || !isNumber(frame.result.status) || !("body" in frame.result)) {
          pending.reject(new Error("The host returned an invalid response."));
        } else if (isDynamicRecord(frame.result.file) && isString(frame.result.file.transferId)) {
          // The RPC response arrived; the file receiver now owns the inactivity
          // deadline. A download failure rejects this request, not the peer. The host answers when
          // the file starts, and a transfer file can take minutes, so other answers on this channel
          // do not wait for it.
          clearTimeout(pending.timer);
          const status = frame.result.status;
          void runPeerEffect(downloads.take(frame.result.file.transferId)).then(
            (file) => pending.resolve({ status, body: { ...file } }),
            (error: unknown) => pending.reject(error instanceof Error ? error : peerError(error)),
          );
        } else {
          const sideRoute = teamSideRouteCodec(pending.path);
          const status = frame.result.status;
          const body = frame.result.body;
          if (pending.method === "GET" && pending.path === TEAM_API_ROUTES.compatibility && status === 200) {
            state.hostProtocol = (yield* peerDecode(() => decodeTeamProtocolSupportV9(body))).protocol.maximum;
            hostProtocols.set(state.hostId, state.hostProtocol);
          }
          pending.resolve({
            status: frame.result.status,
            body: sideRoute
              ? yield* peerDecode(() =>
                  sideRoute.response(pending.path, status, body, {
                    historyExtent: true,
                    channelAttention: true,
                    agentTaskUiBlocks: true,
                  }),
                )
              : yield* peerDecode(() =>
                  withWireBlockExtensions(
                    state,
                    decodeTeamProtocolV9WebRtcHttpResponse(pending.method, pending.path, status, body),
                    body,
                  ),
                ),
          });
        }
        // Keep the request registered until decoding succeeds, so failPeer can
        // reject the caller if a malformed response tears down the connection.
        clearTimeout(pending.timer);
        pendingRequests.delete(frame.requestId);
        return;
      }
      if (kind !== "events") return;
      const frame = yield* peerDecode(() => decodeTeamProtocolV2EventFrame(data));
      if (frame.type === "event-reset") {
        diagnose(state, "event-reset", `after ${state.lastEventSequence}, next ${frame.nextSequence}`);
        state.lastEventSequence = frame.nextSequence - 1;
        yield* RemotePeerIO.use((io) =>
          io.connectionUpdate({
            hostId: state.hostId,
            state: "online",
            message: null,
            resync: true,
          }),
        );
        yield* sendEventAckEffect(state);
        return;
      }
      if (frame.type !== "event")
        return yield* new RemotePeerError({ message: "The host returned an invalid event frame." });
      if (frame.sequence <= state.lastEventSequence) {
        yield* sendEventAckEffect(state);
        return;
      }
      if (frame.sequence !== state.lastEventSequence + 1) {
        diagnose(state, "event-gap", `expected ${state.lastEventSequence + 1}, got ${frame.sequence}`);
        return yield* new RemotePeerError({ message: sourceText("error.remote.eventStreamGap") });
      }
      const channel = yield* peerDecode(() => optionalTeamEvent(frame.payload, { agentTaskUiBlocks: true }));
      const decoded = channel
        ? { status: "known" as const, event: optionalTeamEventToCurrent(channel) }
        : yield* peerDecode(() => decodeTeamProtocolV8CurrentEvent(frame));
      if (decoded.status === "invalid")
        return yield* new RemotePeerError({ message: sourceText("error.remote.malformedEvent") });
      state.lastEventSequence = frame.sequence;
      if (decoded.status === "known") {
        // The frozen event codec leaves the automatic answer and the Vault request of a block out; the
        // wire frame has them.
        if (sendsBlockExtensions(state)) {
          addUiBlockAutoAnswers(decoded.event, frame.payload);
          addUiBlockVaultRequests(decoded.event, frame.payload);
        }
        yield* RemotePeerIO.use((io) => io.teamEvent(state.hostId, decoded.event));
      }
      yield* sendEventAckEffect(state);
    })();
  }

  function handleAuthenticationFrameEffect(state: PeerState, frame: TeamProtocolV2AuthFrame) {
    return Effect.fn("RemotePeer.handleAuthenticationFrame")(function* () {
      if (frame.type === "auth-ready") {
        if (!state.binding || frame.clientNonce !== state.clientNonce)
          return yield* new RemotePeerError({ message: "Host authentication did not match." });
        const binding = state.binding;
        const transcript = yield* peerDecode(() =>
          teamProtocolV2AuthenticationTranscript({
            hostId: state.hostId,
            sessionId: state.device.sessionId,
            ticket: state.device.ticket,
            clientPublicKey: state.device.identity.publicKeyPem,
            clientNonce: state.clientNonce,
            hostNonce: frame.hostNonce,
            clientFingerprint: binding.clientFingerprint,
            hostFingerprint: binding.hostFingerprint,
          }),
        );
        const valid = yield* verifyEd25519Pem(
          yield* peerDecode(() => base64UrlToBytes(frame.signature)),
          new TextEncoder().encode(transcript),
          state.hostPublicKey,
        );
        if (state.closed || peer !== state) return;
        if (!valid)
          return yield* new RemotePeerError({ message: sourceText("error.remote.desktopIdentityNotVerified") });
        state.hostNonce = frame.hostNonce;
        yield* sendPayload(
          state,
          "rpc",
          yield* peerDecode(() =>
            encodeTeamProtocolV2Frame({
              version: 2,
              type: "auth-complete",
              clientNonce: state.clientNonce,
              hostNonce: frame.hostNonce,
            }),
          ),
        );
        return;
      }
      if (
        frame.type !== "auth-confirmed" ||
        frame.clientNonce !== state.clientNonce ||
        frame.hostNonce !== state.hostNonce
      ) {
        return yield* new RemotePeerError({ message: "The desktop returned an invalid authentication confirmation." });
      }
      state.authenticated = true;
      yield* notify(diagnosticCall(state, "authenticated"));
      settleConnected(state);
      yield* sendEventAckEffect(state);
      yield* RemotePeerIO.use((io) => io.connectionUpdate({ hostId: state.hostId, state: "online", message: null }));
    })();
  }

  function requestEffect(
    method: string,
    path: string,
    body: TeamProtocolV2Json,
    upload?: RemoteFileUpload,
    onUploadProgress?: (sent: number, total: number) => void,
    timeoutMs = REQUEST_TIMEOUT_MS,
    largeDownload?: RemoteLargeDownload,
  ) {
    return Effect.fn("RemotePeer.request")(function* () {
      const state = peer;
      if (!state || !isPeerOnline(state)) {
        return yield* new RemotePeerError({ message: sourceText("error.remote.selectedServerOffline") });
      }
      const checksConnection = method === "GET" && path === TEAM_API_ROUTES.compatibility;
      const protocolRead = checksConnection ? Deferred.makeUnsafe<void>() : null;
      if (protocolRead) state.hostProtocolRead = protocolRead;
      // A read sent with the compatibility read must not go out with the bootstrap capabilities.
      else if (state.hostProtocol === undefined && state.hostProtocolRead)
        yield* Deferred.await(state.hostProtocolRead);
      const delivery = upload && onUploadProgress ? trackUploadDelivery(state, onUploadProgress) : null;
      const releaseDownload =
        largeDownload === undefined
          ? null
          : downloads.allow(Math.min(largeDownload.maxBytes, TEAM_PROTOCOL_V2_MAX_FILE_BYTES), largeDownload.mimeType);
      return yield* Effect.gen(function* () {
        const bodyTransferId = upload ? yield* files.upload(upload, delivery?.queued) : null;
        if (peer !== state || !isPeerOnline(state))
          return yield* new RemotePeerError({ message: sourceText("error.remote.attachmentConnectionChanged") });
        // Validate before registering a pending promise. A rejected local payload must not leave
        // an unobserved promise to reject again on timeout or disconnection.
        const sideRoute = teamSideRouteCodec(path);
        const payloadBody = upload
          ? null
          : sideRoute
            ? yield* peerDecode(() => sideRoute.request(path, body))
            : // A caller names a provider and model on agent creation only when the host advertises
              // `agent-create-model`, so the pair is kept whenever it is present.
              yield* peerDecode(() =>
                encodeTeamProtocolV8WebRtcHttpRequest(method, path, body, {
                  preserveSemanticTags: true,
                  agentCreateModel: true,
                }),
              );
        const requestId = createTeamRequestId((size) => crypto.getRandomValues(new Uint8Array(size)));
        const payload = yield* peerDecode(() =>
          encodeTeamProtocolV2Frame({
            version: 2,
            type: "request",
            requestId,
            operation: "http.request",
            payload: {
              method,
              path,
              body: payloadBody,
              ...(bodyTransferId && upload ? { bodyTransferId, contentType: upload.mimeType } : {}),
              capabilities: [...teamCapabilitiesForProtocol(checksConnection ? undefined : state.hostProtocol)],
            },
          }),
        );
        const answer = Deferred.makeUnsafe<{ status: number; body: TeamProtocolV2Json }, RemotePeerError>();
        const response = yield* Effect.acquireUseRelease(
          // Registered before the send, so a fast response finds its request.
          Effect.sync(() => {
            const reject = (error: Error) => Deferred.doneUnsafe(answer, Effect.fail(peerError(error)));
            const expire = () => {
              if (pendingRequests.get(requestId) !== pending) return;
              pendingRequests.delete(requestId);
              const error = new Error(sourceText("error.remote.desktopRequestTimeout"));
              reject(error);
              if (checksConnection) failPeer(state, error, actions);
            };
            const resolve = (value: { status: number; body: TeamProtocolV2Json }) =>
              Deferred.doneUnsafe(answer, Effect.succeed(value));
            const pending: PendingRequest = {
              method,
              path,
              resolve,
              reject,
              profile: startRemoteRequest(method, path, payload),
              timer: setTimeout(
                expire,
                checksConnection
                  ? Math.min(state.answeredRequest ? PROBE_REQUEST_TIMEOUT_MS : FIRST_PROBE_TIMEOUT_MS, timeoutMs)
                  : timeoutMs,
              ),
            };
            pendingRequests.set(requestId, pending);
            return pending;
          }),
          () =>
            // The frame is sent in the work scope: a request that stops waiting does not cut a frame.
            Effect.forkIn(
              sendPayload(state, "rpc", payload).pipe(
                Effect.catch((error) =>
                  Effect.sync(() => {
                    const pending = pendingRequests.get(requestId);
                    if (pending) pending.reject(peerError(error));
                  }),
                ),
              ),
              workScope,
              { startImmediately: true },
            ).pipe(Effect.andThen(Deferred.await(answer))),
          (pending, exit) =>
            Effect.sync(() => {
              clearTimeout(pending.timer);
              pendingRequests.delete(requestId);
              pending.profile?.end(exit);
            }),
        );
        // A response confirms that the host has every uploaded byte.
        delivery?.complete();
        return response;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            delivery?.stop();
            releaseDownload?.();
            if (protocolRead) Deferred.doneUnsafe(protocolRead, Effect.void);
          }),
        ),
      );
    })();
  }

  /**
   * Upload progress as bytes that have left the phone. A chunk counts once the socket has sent it,
   * not when it enters the socket's buffer. React Native gives no buffer size, so there it counts
   * when it is queued.
   */
  function trackUploadDelivery(state: PeerState, onProgress: (sent: number, total: number) => void) {
    let queued = 0;
    let total = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const report = () => {
      const buffered = (state.filesSocket ?? state.socket)?.bufferedAmount ?? 0;
      // The buffer also holds frame headers, so this can read a little low, never high.
      onProgress(Math.max(0, Math.min(total, queued - buffered)), total);
      if (buffered === 0 && queued >= total) stop();
    };
    return {
      queued(sent: number, size: number) {
        queued = sent;
        total = size;
        report();
        // Chunks stop arriving while the buffer drains, so read it until it is empty.
        timer ??= setInterval(report, 100);
      },
      complete() {
        stop();
        if (total > 0) onProgress(total, total);
      },
      stop,
    };
  }

  function sendEventAckEffect(state: PeerState) {
    return Effect.fn("RemotePeer.sendEventAck")(function* () {
      yield* sendPayload(
        state,
        "events",
        yield* peerDecode(() =>
          encodeTeamProtocolV2Frame({ version: 2, type: "event-ack", throughSequence: state.lastEventSequence }),
        ),
      );
    })();
  }

  function sendEventControl(state: PeerState, control: TeamProtocolV1CurrentEventControl) {
    return Effect.fn("RemotePeer.sendEventControl")(function* () {
      yield* sendPayload(
        state,
        "events",
        yield* peerDecode(() =>
          encodeTeamProtocolV2Frame({
            version: 2,
            type: "event-control",
            control: toWireTeamProtocolV1ClientEvent(control),
          }),
        ),
      );
    })();
  }

  function sendPayload(state: PeerState, kind: ChannelKind, data: string | ArrayBuffer) {
    return Effect.fn("RemotePeer.sendPayload")(function* () {
      if (kind === "files") yield* Deferred.await(state.filesDecided);
      const filesSocket =
        kind === "files" && state.filesSocket?.readyState === WebSocket.OPEN ? state.filesSocket : null;
      const socket = filesSocket ?? state.socket;
      if (socket?.readyState !== WebSocket.OPEN)
        return yield* new RemotePeerError({ message: sourceText("error.remote.channelNotOpen") });
      yield* waitForWritable(state, socket);
      yield* Effect.try({
        try: () => {
          if (filesSocket || !isString(data)) socket.send(data);
          else socket.send(encodeDirectFrame(kind, data));
        },
        catch: (error) =>
          new RemotePeerError({
            message: error instanceof Error ? error.message : sourceText("error.remote.requestNotSent"),
          }),
      });
    })();
  }

  /** A socket has no event for an empty buffer, so a full one is read again. React Native gives no size. */
  function waitForWritable(state: PeerState, socket: WebSocket) {
    return Effect.fn("RemotePeer.waitForWritable")(function* () {
      const started = Date.now();
      while ((socket.bufferedAmount ?? 0) > MAXIMUM_BUFFERED_BYTES) {
        if (state.closed) return yield* new RemotePeerError({ message: sourceText("error.remote.serverDisconnected") });
        if (Date.now() - started > BACKPRESSURE_TIMEOUT_MS)
          return yield* new RemotePeerError({ message: sourceText("error.remote.channelBackpressure") });
        yield* Effect.sleep(BUFFER_CHECK_INTERVAL_MS);
      }
    })();
  }

  function failPeer(
    state: PeerState,
    error: unknown,
    actions: ActionsRef,
    code?: RemoteTeamConnectionUpdate["code"],
  ): void {
    if (state.closed || peer !== state) return;
    const failure = referenced(failureMessage(error), failureReference(error));
    const message = failure.message;
    diagnose(state, "failed", code ? `${code}: ${message}` : message);
    rejectConnection(state, failure);
    void runPeerEffect(connectionOffline(state, failure, actions, code));
    void runPeerEffect(closePeer());
  }

  /** `failPeer` for Effect code: the same steps in the same order, its notices forked into the work scope. */
  function failPeerEffect(
    state: PeerState,
    error: unknown,
    actions: ActionsRef,
    code?: RemoteTeamConnectionUpdate["code"],
  ) {
    return Effect.gen(function* () {
      if (state.closed || peer !== state) return;
      const failure = referenced(failureMessage(error), failureReference(error));
      const message = failure.message;
      yield* notify(diagnosticCall(state, "failed", code ? `${code}: ${message}` : message));
      rejectConnection(state, failure);
      yield* notify(connectionOffline(state, failure, actions, code));
      yield* closePeer();
    });
  }

  function failureMessage(error: unknown): string {
    return error instanceof Error ? error.message : sourceText("error.remote.webRtcConnectionFailed");
  }

  function connectionOffline(
    state: PeerState,
    failure: RemotePeerError,
    actions: ActionsRef,
    code?: RemoteTeamConnectionUpdate["code"],
  ) {
    const reference = failure.reference;
    return peerCall(() =>
      actions.current.onConnectionUpdate({
        hostId: state.hostId,
        state: "offline",
        message: failure.message,
        ...(code ? { code } : {}),
        ...(reference ? { reference } : {}),
      }),
    );
  }

  function rejectRequests(error: Error, readsOnly = false): void {
    for (const [id, pending] of pendingRequests) {
      if (readsOnly && pending.method !== "GET" && pending.method !== "HEAD") continue;
      pendingRequests.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  function closePeer() {
    return Effect.sync(() => {
      files.cancel();
      downloads.clear();
      const state = peer;
      peer = null;
      generation += 1;
      if (!state) return;
      state.closed = true;
      state.abort.abort();
      stopHeartbeat(state);
      if (state.connectedTimer !== null) clearTimeout(state.connectedTimer);
      Deferred.doneUnsafe(state.filesDecided, Effect.void);
      state.filesSocket?.close();
      state.socket?.close();
      rejectRequests(new Error(sourceText("error.remote.serverDisconnected")));
      rejectConnection(state, new Error(sourceText("error.remote.serverDisconnected")));
    });
  }

  function settleConnected(state: PeerState): void {
    if (state.connectedTimer !== null) clearTimeout(state.connectedTimer);
    state.connectedTimer = null;
    if (state.connected) Deferred.doneUnsafe(state.connected, Effect.void);
    state.connected = null;
  }

  function rejectConnection(state: PeerState, error: Error): void {
    if (state.connectedTimer !== null) clearTimeout(state.connectedTimer);
    state.connectedTimer = null;
    if (state.connected) Deferred.doneUnsafe(state.connected, Effect.fail(peerError(error)));
    state.connected = null;
  }

  function randomBase64Url(size: number): string {
    return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(size)));
  }
}

/**
 * Whether the host can send `ui-block-auto-answer-v1` and `ui-block-vault-v1`: the client advertises
 * them only on protocol 9, so the walk is skipped for every older host.
 */
function sendsBlockExtensions(state: PeerState): boolean {
  return (state.hostProtocol ?? 0) >= TEAM_PROTOCOL_V9;
}

/**
 * A decoded response with the automatic answer and the Vault request of each block, which the frozen
 * response codec leaves out. Only a host that the client told `ui-block-auto-answer-v1` or
 * `ui-block-vault-v1` puts them on the wire.
 */
function withWireBlockExtensions<T>(state: PeerState, decoded: T, wire: unknown): T {
  if (sendsBlockExtensions(state)) {
    addUiBlockAutoAnswers(decoded, wire);
    addUiBlockVaultRequests(decoded, wire);
  }
  return decoded;
}
