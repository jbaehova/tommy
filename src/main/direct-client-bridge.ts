import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  DIRECT_CLOSE_DEVICE_REVOKED,
  DIRECT_CLOSE_REPLACED,
  DIRECT_FILES_PATH,
  DIRECT_FILES_TOKEN_QUERY,
  DirectHello,
  decodeDirectFrame,
  directConnectionBinding,
  encodeDirectFrame,
} from "@tommy/contracts/direct-connection";
import { sourceText } from "@tommy/i18n/source";
import { Deferred, Effect, Schema } from "effect";
import type * as Ws from "ws";
import { RemoteWorkflowError } from "./remote-service-effects";
import type { TeamWebRtcBridgeEvents, TeamWebRtcChannel } from "./team-webrtc-bridge";
import { rawDataBytes, rawDataText } from "./ws-raw-data";

const requireModule = createRequire(import.meta.url);
const webSockets: typeof Ws = requireModule(join(dirname(requireModule.resolve("ws/package.json")), "index.js"));

const CONNECT_TIMEOUT_MS = 10_000;
/** A file waits this long for the files socket. After it, files go on the connect socket. */
const FILES_SOCKET_TIMEOUT_MS = 5_000;
/** A silent socket that does not answer a ping in this time is closed. */
const PING_INTERVAL_MS = 15_000;

const decodeHello = Schema.decodeUnknownSync(DirectHello);

interface ClientConnection {
  url: string;
  socket: Ws.WebSocket;
  files: Ws.WebSocket | null;
  /** Settles once: the files socket opened or the connection uses the connect socket for files. */
  filesDecided: Deferred.Deferred<void>;
  alive: boolean;
  heartbeat: ReturnType<typeof setInterval> | null;
}

/**
 * The client half of the direct connection: one WebSocket to the host, in the main process. It has
 * the events and `send` of the WebRTC bridge, so `TeamWebRtcClientTransport` keeps its authentication,
 * request and event code. A connection has one files socket beside it, so a file does not hold back
 * chat. It opens in the background and the first screen does not wait for it.
 */
export class DirectClientBridge extends EventEmitter<TeamWebRtcBridgeEvents> {
  readonly #connections = new Map<string, ClientConnection>();
  readonly #deviceRevoked: () => void;

  constructor(options: { deviceRevoked?: () => void } = {}) {
    super();
    this.#deviceRevoked = options.deviceRevoked ?? (() => undefined);
  }

  /** There is no window to load. */
  start(): Effect.Effect<void, RemoteWorkflowError> {
    return Effect.void;
  }

  /** There is no Signal socket to open before the ticket. */
  prepareSignal(_peerId: string, _signalUrl: string): Effect.Effect<void, RemoteWorkflowError> {
    return Effect.void;
  }

  /** `signalUrl` is the address of the connect socket, with the device ID. */
  connect(input: { peerId: string; signalUrl: string }): Effect.Effect<void, RemoteWorkflowError> {
    return Effect.sync(() => this.#open(input.peerId, input.signalUrl));
  }

  disconnect(peerId: string): Effect.Effect<void, RemoteWorkflowError> {
    return Effect.sync(() => this.#close(peerId));
  }

  /** The transfers of a peer end its connection through this. */
  disconnectPeer(peerId: string): Effect.Effect<void, RemoteWorkflowError> {
    return this.disconnect(peerId);
  }

  readonly send = Effect.fn("DirectClientBridge.send")(function* (
    this: DirectClientBridge,
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
      if (connection.files?.readyState === webSockets.WebSocket.OPEN) return yield* sendOn(connection.files, data);
    }
    return yield* sendOn(connection.socket, typeof data === "string" ? encodeDirectFrame(channel, data) : data);
  }).bind(this);

  stop(): Effect.Effect<void, RemoteWorkflowError> {
    return Effect.sync(() => {
      for (const peerId of [...this.#connections.keys()]) this.#close(peerId);
    });
  }

  #open(peerId: string, url: string): void {
    this.#close(peerId);
    const socket = new webSockets.WebSocket(url, { handshakeTimeout: CONNECT_TIMEOUT_MS, perMessageDeflate: false });
    const connection: ClientConnection = {
      url,
      socket,
      files: null,
      filesDecided: Deferred.makeUnsafe<void>(),
      alive: true,
      heartbeat: null,
    };
    this.#connections.set(peerId, connection);
    socket.on("open", () => this.emit("signalOpen", peerId));
    socket.on("pong", () => {
      connection.alive = true;
    });
    socket.on("message", (data, isBinary) => this.#receive(peerId, connection, data, isBinary));
    // `close` follows an error. The error can hold the URL, so only a fixed code goes on.
    socket.on("error", () => undefined);
    socket.on("unexpected-response", (request, response) => {
      request.destroy();
      socket.terminate();
      if (this.#connections.get(peerId) !== connection) return;
      if (response.statusCode === 401) this.#revoked(peerId);
      else this.emit("error", peerId, "host_unavailable", "host_unavailable", false);
    });
    socket.on("close", (code) => this.#socketEnded(peerId, connection, code));
  }

  #receive(peerId: string, connection: ClientConnection, data: Ws.RawData, isBinary: boolean): void {
    if (this.#connections.get(peerId) !== connection) return;
    connection.alive = true;
    if (isBinary) {
      this.emit("data", peerId, "files", arrayBufferOf(data));
      return;
    }
    const frame = decodeDirectFrame(rawDataText(data));
    if (!frame) {
      connection.socket.terminate();
      return;
    }
    if (frame.kind === "pong" || frame.kind === "ping") return;
    if (frame.kind === "hello") {
      this.#ready(peerId, connection, frame.payload);
      return;
    }
    if (frame.kind === "desktopBinary") {
      this.emit("data", peerId, "desktop", arrayBufferOf(Buffer.from(frame.payload, "base64")));
      return;
    }
    this.emit("data", peerId, frame.kind, frame.payload);
  }

  #ready(peerId: string, connection: ClientConnection, payload: string): void {
    let hello: DirectHello;
    try {
      hello = decodeHello(JSON.parse(payload));
    } catch {
      connection.socket.terminate();
      return;
    }
    connection.heartbeat = setInterval(() => {
      if (!connection.alive) {
        connection.socket.terminate();
        return;
      }
      connection.alive = false;
      connection.socket.ping();
    }, PING_INTERVAL_MS);
    connection.heartbeat.unref?.();
    this.#openFiles(peerId, connection, hello.filesToken);
    const binding = directConnectionBinding(hello.connectionId);
    this.emit("signalReady", peerId);
    this.emit("connected", peerId, { localFingerprint: binding.client, remoteFingerprint: binding.host });
  }

  #openFiles(peerId: string, connection: ClientConnection, token: string): void {
    const url = new URL(connection.url);
    url.pathname = DIRECT_FILES_PATH;
    url.search = "";
    url.searchParams.set(DIRECT_FILES_TOKEN_QUERY, token);
    const files = new webSockets.WebSocket(url, {
      handshakeTimeout: FILES_SOCKET_TIMEOUT_MS,
      perMessageDeflate: false,
    });
    const decide = () => Deferred.doneUnsafe(connection.filesDecided, Effect.void);
    const timer = setTimeout(decide, FILES_SOCKET_TIMEOUT_MS);
    timer.unref?.();
    files.on("open", () => {
      clearTimeout(timer);
      connection.files = files;
      decide();
    });
    files.on("message", (data, isBinary) => {
      if (this.#connections.get(peerId) !== connection) return;
      this.emit("data", peerId, "files", isBinary ? arrayBufferOf(data) : rawDataText(data));
    });
    files.on("error", () => undefined);
    files.on("close", (code) => {
      clearTimeout(timer);
      decide();
      // Frames of a transfer can be lost with this socket, so the whole connection starts again.
      if (connection.files === files) this.#socketEnded(peerId, connection, code);
    });
    connection.files = null;
  }

  #revoked(peerId: string): void {
    this.emit("error", peerId, "device_revoked", sourceText("error.remote.deviceRevoked"), true);
    this.#deviceRevoked();
  }

  /** The host closes both sockets with its code, and either close can arrive first. */
  #socketEnded(peerId: string, connection: ClientConnection, code: number): void {
    if (this.#connections.get(peerId) !== connection) return;
    if (code === DIRECT_CLOSE_DEVICE_REVOKED) this.#revoked(peerId);
    if (code === DIRECT_CLOSE_REPLACED) this.emit("error", peerId, "connection_replaced", "connection_replaced", true);
    this.#close(peerId);
  }

  #close(peerId: string): void {
    const connection = this.#connections.get(peerId);
    if (!connection) return;
    this.#connections.delete(peerId);
    if (connection.heartbeat) clearInterval(connection.heartbeat);
    Deferred.doneUnsafe(connection.filesDecided, Effect.void);
    connection.files?.terminate();
    connection.socket.terminate();
    this.emit("disconnected", peerId);
  }
}

function sendOn(socket: Ws.WebSocket, data: string | ArrayBuffer): Effect.Effect<void, RemoteWorkflowError> {
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
