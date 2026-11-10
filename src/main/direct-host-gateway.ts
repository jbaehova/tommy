import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import {
  DIRECT_CLOSE_DEVICE_REVOKED,
  DIRECT_CLOSE_REPLACED,
  DIRECT_CONNECT_PATH,
  DIRECT_DEVICE_QUERY,
  DIRECT_FILES_PATH,
  DIRECT_FILES_TOKEN_QUERY,
  DIRECT_PAIR_PATH,
  DIRECT_SESSION_EXPIRES_AT_SECONDS,
  DirectPairRequest,
  type DirectPairResponse,
  decodeDirectFrame,
  directConnectionBinding,
  directSessionId,
  encodeDirectFrame,
} from "@tommy/contracts/direct-connection";
import { createTommyLogger } from "@tommy/logging";
import { Deferred, Effect, Exit, Fiber, Schema } from "effect";
import type * as Ws from "ws";
import type { VerifiedRemoteSessionTicket } from "./central-auth-records";
import type { DirectDevice, DirectDeviceStore } from "./direct-device-store";
import { readBodyWithin } from "./http-body";
import { RemoteWorkflowError } from "./remote-service-effects";
import type { TeamWebRtcBridgeEvents, TeamWebRtcChannel } from "./team-webrtc-bridge";
import { TeamWebRtcHostPeer, type TeamWebRtcHostPeerOptions } from "./team-webrtc-host-peer";
import { rawDataBytes, rawDataText } from "./ws-raw-data";

const requireModule = createRequire(import.meta.url);
const webSockets: typeof Ws = requireModule(join(dirname(requireModule.resolve("ws/package.json")), "index.js"));

const logger = createTommyLogger("direct-host-gateway");

/** A device that does not finish its authentication in this time is closed. */
const AUTHENTICATION_TIMEOUT_MS = 10_000;
/** A file waits this long for the files socket. After it, files go on the connect socket. */
const FILES_SOCKET_TIMEOUT_MS = 5_000;
/** The host asks each socket for a pong this often. Two missed pongs close the socket. */
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAXIMUM_PAIR_BODY_BYTES = 16 * 1024;
const MAXIMUM_MESSAGE_BYTES = 16 * 1024 * 1024;
/** One user has few devices. This limit holds back a stolen device that opens many sockets. */
const MAXIMUM_CONNECTIONS = 16;

const decodePairRequest = Schema.decodeUnknownSync(DirectPairRequest);

export interface DirectHostOwner {
  membershipId: string;
  userId: string;
}

export interface DirectHostGatewayOptions extends Omit<TeamWebRtcHostPeerOptions, "bridge" | "verifyClientTicket"> {
  publicHttp?: (request: IncomingMessage, response: ServerResponse) => Effect.Effect<boolean>;
  devices: DirectDeviceStore;
  owner: () => DirectHostOwner | null;
  /** The address of the reverse proxy's upstream. It must stay on loopback: the proxy holds TLS. */
  listen: { host: string; port: number };
}

interface PairOutcome {
  status: number;
  body: Record<string, string>;
}

interface DirectConnection {
  id: string;
  deviceId: string;
  socket: Ws.WebSocket;
  files: Ws.WebSocket | null;
  filesToken: string;
  /** Settles once: the files socket came, or this connection sends files on the connect socket. */
  filesDecided: Deferred.Deferred<void>;
  filesTimer: ReturnType<typeof setTimeout>;
  peer: TeamWebRtcHostPeer;
  alive: boolean;
  authenticationTimer: ReturnType<typeof setTimeout>;
}

/**
 * Takes each device's WebSocket and gives it a `TeamWebRtcHostPeer`. The peer sees the same events
 * and `send` as with the WebRTC bridge, so its authentication, RPC, event and file code stays one.
 */
export class DirectHostGateway extends EventEmitter<TeamWebRtcBridgeEvents> {
  readonly #options: DirectHostGatewayOptions;
  readonly #connections = new Map<string, DirectConnection>();
  readonly #operations = new Set<Fiber.Fiber<unknown, unknown>>();
  readonly #sockets = new webSockets.WebSocketServer({ noServer: true, maxPayload: MAXIMUM_MESSAGE_BYTES });
  #server: Server | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #hostId: string | null = null;
  #localApiPort: number | null = null;

  constructor(options: DirectHostGatewayOptions) {
    super();
    this.#options = options;
  }

  readonly start = Effect.fn("DirectHostGateway.start")(function* (
    this: DirectHostGateway,
    input: { hostId: string; localApiPort: number },
  ) {
    if (this.#server) return yield* this.address();
    this.#hostId = input.hostId;
    this.#localApiPort = input.localApiPort;
    const server = createServer((request, response) => this.#handleRequest(request, response));
    server.on("upgrade", (request, socket, head) => this.#handleUpgrade(request, socket, head));
    yield* Effect.callback<void, RemoteWorkflowError>((resume) => {
      server.once("error", (cause) => resume(Effect.fail(new RemoteWorkflowError({ cause }))));
      server.listen(this.#options.listen.port, this.#options.listen.host, () => resume(Effect.void));
    });
    this.#server = server;
    this.#heartbeat = setInterval(() => this.#beat(), HEARTBEAT_INTERVAL_MS);
    this.#heartbeat.unref?.();
    return yield* this.address();
  }).bind(this);

  readonly address = Effect.fn("DirectHostGateway.address")(function* (this: DirectHostGateway) {
    const address = this.#server?.address();
    if (!address || typeof address === "string")
      return yield* new RemoteWorkflowError({ cause: new Error("The direct gateway does not listen.") });
    return address.port;
  }).bind(this);

  readonly stop = Effect.fn("DirectHostGateway.stop")(function* (this: DirectHostGateway) {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    const connections = [...this.#connections.values()];
    yield* Effect.forEach(connections, (connection) => this.#close(connection, 1001), {
      concurrency: "unbounded",
      discard: true,
    });
    yield* Fiber.awaitAll([...this.#operations]);
    const server = this.#server;
    this.#server = null;
    if (server)
      yield* Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      });
    this.#hostId = null;
    this.#localApiPort = null;
  }, Effect.uninterruptible).bind(this);

  /** Removes a device and closes its connection now. */
  readonly revokeDevice = Effect.fn("DirectHostGateway.revokeDevice")(function* (
    this: DirectHostGateway,
    deviceId: string,
  ) {
    yield* this.#options.devices
      .revoke(deviceId)
      .pipe(Effect.mapError(({ cause }) => new RemoteWorkflowError({ cause })));
    yield* Effect.forEach(
      [...this.#connections.values()].filter((connection) => connection.deviceId === deviceId),
      (connection) => this.#close(connection, DIRECT_CLOSE_DEVICE_REVOKED),
      { concurrency: "unbounded", discard: true },
    );
  }).bind(this);

  /** The devices that are connected now, and whether each one has its files socket. */
  connectedDevices(): { deviceId: string; filesSocket: boolean }[] {
    return [...this.#connections.values()].map((connection) => ({
      deviceId: connection.deviceId,
      filesSocket: connection.files !== null,
    }));
  }

  /** Ends the socket of a device as a lost network does. The device can connect again. */
  dropDeviceConnection(deviceId: string): Effect.Effect<void> {
    return Effect.sync(() => {
      for (const connection of this.#connections.values()) {
        if (connection.deviceId === deviceId) connection.socket.terminate();
      }
    });
  }

  /**
   * Ends the access of the device of this session. An RPC can revoke its own session, so the
   * connection closes in the background and the RPC can answer.
   */
  revokeSession(sessionId: string): Effect.Effect<void> {
    return Effect.sync(() => {
      const device = this.#options.devices.list().find((candidate) => directSessionId(candidate.id) === sessionId);
      if (device) this.#run(this.revokeDevice(device.id));
    });
  }

  /** Whether any connected device has a file transfer moving right now, either direction. */
  hasActiveTransfers(): boolean {
    return [...this.#connections.values()].some((connection) => connection.peer.hasActiveTransfers());
  }

  // The peer's bridge.
  readonly send = Effect.fn("DirectHostGateway.send")(function* (
    this: DirectHostGateway,
    peerId: string,
    channel: TeamWebRtcChannel,
    data: string | ArrayBuffer,
  ) {
    const connection = this.#connections.get(peerId);
    if (!connection) return yield* new RemoteWorkflowError({ cause: new Error("The direct connection is closed.") });
    if (channel === "desktop" && typeof data !== "string")
      return yield* sendOn(connection.socket, encodeDirectFrame("desktopBinary", Buffer.from(data).toString("base64")));
    if (channel === "files") {
      yield* Deferred.await(connection.filesDecided);
      if (connection.files) return yield* sendOn(connection.files, data);
    }
    if (typeof data !== "string") return yield* sendOn(connection.socket, data);
    return yield* sendOn(connection.socket, encodeDirectFrame(channel, data));
  }).bind(this);

  // The peer's bridge.
  readonly disconnectPeer = Effect.fn("DirectHostGateway.disconnectPeer")(function* (
    this: DirectHostGateway,
    peerId: string,
  ) {
    const connection = this.#connections.get(peerId);
    if (connection) yield* this.#close(connection, 1000);
  }).bind(this);

  #run<A, E>(operation: Effect.Effect<A, E>): void {
    const fiber = Effect.runFork(operation);
    this.#operations.add(fiber);
    fiber.addObserver((exit) => {
      this.#operations.delete(fiber);
      if (Exit.isFailure(exit)) logger.warn("A direct connection operation failed.");
    });
  }

  #beat(): void {
    for (const connection of this.#connections.values()) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
      // The proxy closes a socket that stays silent, and a files socket is silent between transfers.
      if (connection.files?.readyState === webSockets.WebSocket.OPEN) connection.files.ping();
    }
  }

  #handleRequest(request: IncomingMessage, response: ServerResponse): void {
    const ingress = this.#options.publicHttp;
    if (!ingress) {
      this.#handlePairRequest(request, response);
      return;
    }
    this.#run(
      ingress(request, response).pipe(
        Effect.tap((handled) =>
          Effect.sync(() => {
            if (!handled) this.#handlePairRequest(request, response);
          }),
        ),
        // A defect in a public route must not leave the sender waiting for the proxy deadline.
        Effect.catchCause(() =>
          Effect.sync(() => {
            if (response.headersSent || response.destroyed) response.destroy();
            else answer(response, 500, { error: "failed" });
          }),
        ),
      ),
    );
  }

  #handlePairRequest(request: IncomingMessage, response: ServerResponse): void {
    const path = new URL(request.url ?? "/", "http://loopback").pathname;
    if (request.method !== "POST" || path !== DIRECT_PAIR_PATH) {
      answer(response, 404, { error: "not_found" });
      return;
    }
    this.#run(
      this.#pair(request).pipe(
        Effect.match({
          onFailure: (): PairOutcome => ({ status: 500, body: { error: "pair_failed" } }),
          onSuccess: (outcome) => outcome,
        }),
        Effect.map((outcome) => answer(response, outcome.status, outcome.body)),
      ),
    );
  }

  readonly #pair = Effect.fn("DirectHostGateway.pair")(function* (
    this: DirectHostGateway,
    request: IncomingMessage,
  ): Effect.fn.Return<PairOutcome, RemoteWorkflowError> {
    const hostId = this.#hostId;
    const identity = this.#options.store.getIdentity();
    if (!hostId || !identity) return { status: 503, body: { error: "host_not_ready" } };
    const body = yield* Effect.tryPromise({
      try: () => readBodyWithin(request, MAXIMUM_PAIR_BODY_BYTES),
      catch: (cause) => new RemoteWorkflowError({ cause }),
    });
    if (body === null) return { status: 413, body: { error: "too_large" } };
    let input: DirectPairRequest;
    try {
      input = decodePairRequest(JSON.parse(body.toString("utf8")));
    } catch {
      return { status: 400, body: { error: "invalid_request" } };
    }
    const device = yield* this.#options.devices
      .redeem(input)
      .pipe(Effect.mapError(({ cause }) => new RemoteWorkflowError({ cause })));
    if (device === "invalid_code") return { status: 403, body: { error: "invalid_code" } };
    if (device === "invalid_key") return { status: 400, body: { error: "invalid_key" } };
    logger.info("A device paired with this host.");
    const paired: DirectPairResponse = {
      hostId,
      hostFingerprint: identity.fingerprint,
      hostPublicKey: identity.publicKey,
      deviceId: device.id,
    };
    return { status: 200, body: paired };
  });

  #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", "http://loopback");
    if (url.pathname === DIRECT_CONNECT_PATH) {
      const device = this.#options.devices.get(url.searchParams.get(DIRECT_DEVICE_QUERY) ?? "");
      if (!device || !this.#hostId || this.#localApiPort === null || this.#connections.size >= MAXIMUM_CONNECTIONS) {
        refuseUpgrade(socket, device ? 503 : 401);
        return;
      }
      this.#sockets.handleUpgrade(request, socket, head, (client) => this.#run(this.#open(client, device)));
      return;
    }
    if (url.pathname === DIRECT_FILES_PATH) {
      const token = url.searchParams.get(DIRECT_FILES_TOKEN_QUERY);
      const connection = [...this.#connections.values()].find((candidate) => candidate.filesToken === token);
      if (!connection || !token || connection.files || Deferred.isDoneUnsafe(connection.filesDecided)) {
        refuseUpgrade(socket, 401);
        return;
      }
      this.#sockets.handleUpgrade(request, socket, head, (client) => this.#attachFiles(connection, client));
      return;
    }
    refuseUpgrade(socket, 404);
  }

  readonly #open = Effect.fn("DirectHostGateway.open")(function* (
    this: DirectHostGateway,
    socket: Ws.WebSocket,
    device: DirectDevice,
  ) {
    // Listen first: a client can send as soon as the socket opens. It sends nothing before the hello.
    socket.on("error", () => socket.terminate());
    // A newer connection replaces the older one. The peer closes the store's session by its ID, so
    // the older peer must end before the newer one opens the same session.
    yield* Effect.forEach(
      [...this.#connections.values()].filter((connection) => connection.deviceId === device.id),
      (connection) => this.#close(connection, DIRECT_CLOSE_REPLACED),
      { concurrency: "unbounded", discard: true },
    );
    const hostId = this.#hostId;
    const localApiPort = this.#localApiPort;
    const owner = this.#options.owner();
    if (!hostId || localApiPort === null || !owner || socket.readyState !== webSockets.WebSocket.OPEN) {
      socket.close(1013);
      return;
    }
    const id = randomBytes(32).toString("base64url");
    const peer = new TeamWebRtcHostPeer(
      {
        ...this.#options,
        bridge: this,
        verifyClientTicket: (ticket) => this.#verifyTicket(ticket, hostId, owner),
      },
      { peerId: id, hostId, localApiPort },
    );
    const filesDecided = Deferred.makeUnsafe<void>();
    const connection: DirectConnection = {
      id,
      deviceId: device.id,
      socket,
      files: null,
      filesToken: randomBytes(32).toString("base64url"),
      filesDecided,
      filesTimer: setTimeout(() => Deferred.doneUnsafe(filesDecided, Effect.void), FILES_SOCKET_TIMEOUT_MS),
      peer,
      alive: true,
      authenticationTimer: setTimeout(() => {
        if (!peer.authenticated()) socket.terminate();
      }, AUTHENTICATION_TIMEOUT_MS),
    };
    connection.authenticationTimer.unref?.();
    connection.filesTimer.unref?.();
    this.#connections.set(id, connection);
    socket.on("pong", () => {
      connection.alive = true;
    });
    socket.on("message", (data, isBinary) => this.#receive(connection, data, isBinary));
    socket.on("close", () => this.#run(this.#close(connection, 1000)));
    yield* peer.incoming({
      hostId,
      connectionId: id,
      sessionId: directSessionId(device.id),
      userId: owner.userId,
      membershipId: owner.membershipId,
      role: "owner",
      sessionExpiresAt: DIRECT_SESSION_EXPIRES_AT_SECONDS,
    });
    const binding = directConnectionBinding(id);
    this.emit("connected", id, { localFingerprint: binding.host, remoteFingerprint: binding.client });
    yield* sendOn(
      socket,
      encodeDirectFrame("hello", JSON.stringify({ connectionId: id, filesToken: connection.filesToken })),
    );
  });

  readonly #verifyTicket = Effect.fn("DirectHostGateway.verifyTicket")(function* (
    this: DirectHostGateway,
    deviceId: string,
    hostId: string,
    owner: DirectHostOwner,
  ): Effect.fn.Return<VerifiedRemoteSessionTicket, RemoteWorkflowError> {
    const device = this.#options.devices.get(deviceId);
    if (!device) return yield* new RemoteWorkflowError({ cause: new Error("The device is not paired.") });
    return {
      hostId,
      sessionId: directSessionId(device.id),
      userId: owner.userId,
      membershipId: owner.membershipId,
      role: "owner",
      authEpoch: 0,
      clientPublicKey: device.publicKey,
      sessionExpiresAt: DIRECT_SESSION_EXPIRES_AT_SECONDS,
    };
  });

  #attachFiles(connection: DirectConnection, files: Ws.WebSocket): void {
    if (connection.files || !this.#connections.has(connection.id)) {
      files.close(1008);
      return;
    }
    connection.files = files;
    clearTimeout(connection.filesTimer);
    Deferred.doneUnsafe(connection.filesDecided, Effect.void);
    files.on("error", () => files.terminate());
    // Frames of a transfer can be lost with this socket, so the whole connection starts again.
    files.on("close", () => {
      if (connection.files === files && this.#connections.get(connection.id) === connection)
        connection.socket.terminate();
    });
    files.on("message", (data, isBinary) => {
      this.emit("data", connection.id, "files", isBinary ? arrayBufferOf(data) : rawDataText(data));
    });
  }

  #receive(connection: DirectConnection, data: Ws.RawData, isBinary: boolean): void {
    if (!this.#connections.has(connection.id)) return;
    connection.alive = true;
    if (isBinary) {
      this.emit("data", connection.id, "files", arrayBufferOf(data));
      return;
    }
    const frame = decodeDirectFrame(rawDataText(data));
    if (!frame || frame.kind === "hello" || frame.kind === "pong") {
      connection.socket.terminate();
      return;
    }
    if (frame.kind === "ping") {
      // The answer shows a client that this socket works, as after a return to the app.
      connection.socket.send(encodeDirectFrame("pong"));
      return;
    }
    if (frame.kind === "desktopBinary") {
      this.emit("data", connection.id, "desktop", arrayBufferOf(Buffer.from(frame.payload, "base64")));
      return;
    }
    this.emit("data", connection.id, frame.kind, frame.payload);
  }

  /**
   * The peer ends its session before this returns, so that a newer connection can open the same
   * session. This does not wait for the peer's operations, because one of them can be the caller.
   */
  readonly #close = Effect.fn("DirectHostGateway.close")(function* (
    this: DirectHostGateway,
    connection: DirectConnection,
    code: number,
  ) {
    if (this.#connections.get(connection.id) !== connection) return;
    this.#connections.delete(connection.id);
    clearTimeout(connection.authenticationTimer);
    clearTimeout(connection.filesTimer);
    Deferred.doneUnsafe(connection.filesDecided, Effect.void);
    closeSocket(connection.files, code);
    closeSocket(connection.socket, code);
    // The peer reports a lost path first: a device with no connection gets its push notifications.
    this.emit("pathLost", connection.id);
    this.emit("disconnected", connection.id);
    const disposal = yield* connection.peer.retire();
    this.#operations.add(disposal);
    disposal.addObserver(() => this.#operations.delete(disposal));
  });
}

function closeSocket(socket: Ws.WebSocket | null, code: number): void {
  if (!socket) return;
  if (socket.readyState === webSockets.WebSocket.OPEN) socket.close(code);
  else socket.terminate();
}

function sendOn(socket: Ws.WebSocket, data: string | ArrayBuffer): Effect.Effect<void, RemoteWorkflowError> {
  // The callback runs when the bytes reach the system, so that a slow client slows the sender.
  return Effect.callback((resume) => {
    if (socket.readyState !== webSockets.WebSocket.OPEN) {
      resume(Effect.fail(new RemoteWorkflowError({ cause: new Error("The direct connection is closed.") })));
      return;
    }
    socket.send(data, (cause) => resume(cause ? Effect.fail(new RemoteWorkflowError({ cause })) : Effect.void));
  });
}

function arrayBufferOf(data: Ws.RawData): ArrayBuffer {
  const bytes = rawDataBytes(data);
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function answer(response: ServerResponse, status: number, body: Record<string, string>): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function refuseUpgrade(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
