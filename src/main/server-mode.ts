/**
 * A self-hosted server: the packaged Linux build that `install-server.sh` installs on a computer
 * with no screen. systemd starts it with `TOMMY_SERVER=1` under a virtual display, and it is a
 * host that paired devices connect to directly.
 *
 * Nobody can use the window, so the `tommy` terminal command (`scripts/hosting/tommy`) talks to
 * this process over a Unix socket in the runtime directory that systemd makes for the service user
 * (mode 0700). Only that user and root can connect. Agents run as the same user and already have
 * full access to its files, so the socket gives them nothing new. The socket answers a closed list
 * of requests: status, the server name, a pairing code, the paired devices and the revoke of one.
 * The pairing code goes back on this socket, because a person must read it. The owner can also get
 * one from a paired device (`host-devices-v1`). It works once.
 *
 * The protocol is HTTP with form bodies and `key=value` text lines, so the command needs only
 * `curl --unix-socket`.
 */

import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { createDirectPairingLink } from "@tommy/contracts/direct-connection";
import { parseHostedServerName } from "@tommy/contracts/hosted-servers";
import { INPUT_LIMITS } from "@tommy/contracts/input-limits";
import { sourceText } from "@tommy/i18n/source";
import { Deferred, Effect } from "effect";
import QRCode from "qrcode";
import { runCauseEffect } from "../backend/effect-boundary";
import type { HostService } from "./host-service";
import { readBodyWithin } from "./http-body";
import { RemoteWorkflowError, remoteCall } from "./remote-service-effects";
import type { ServerMemory } from "./server-memory";

const CONTROL_SOCKET_FILE = "control.sock";
const MAX_BODY_BYTES = 4096;
/** The name of a server whose owner gave none. */
const DEFAULT_SERVER_NAME = "Tommy";

export interface ServerModeEnvironment {
  controlSocketPath: string;
}

/** Returns null unless this process is a self-hosted server that systemd started. */
export function takeServerModeEnvironment(
  environment: NodeJS.ProcessEnv,
  isPackaged: boolean,
  platform: NodeJS.Platform,
): ServerModeEnvironment | null {
  if (!isPackaged || platform !== "linux" || environment.TOMMY_SERVER !== "1") return null;
  // A hosted server signs in with its claim, not from a terminal.
  if (environment.TOMMY_HOSTED_SERVER === "1") return null;
  const runtimeDirectory = environment.XDG_RUNTIME_DIR?.trim() ?? "";
  if (!isAbsolute(runtimeDirectory)) return null;
  return { controlSocketPath: join(runtimeDirectory, CONTROL_SOCKET_FILE) };
}

export interface ServerModeOptions {
  environment: ServerModeEnvironment;
  version: string;
  host: Pick<
    HostService,
    | "getStatus"
    | "configure"
    | "start"
    | "updateIdentity"
    | "createPairingCode"
    | "listDirectDevices"
    | "revokeDirectDevice"
  >;
  /** The memory guard, so that `status` shows the memory ceiling and the turn limit. */
  memory: Pick<ServerMemory, "level" | "sample" | "turnLimit"> | null;
  onError: (message: string, error: unknown) => void;
  /** Tests only. */
  uid?: number;
}

interface Answer {
  status: number;
  lines: Record<string, string | number | null>;
}

export class ServerMode {
  readonly #options: ServerModeOptions;
  readonly #sockets = new Set<Socket>();
  #server: Server | null = null;
  #pendingName: string | null = null;
  /** Why the last publish failed. Nobody reads the journal, so `status` shows it. */
  #publishError: string | null = null;
  #publishing: Deferred.Deferred<void> | null = null;

  constructor(options: ServerModeOptions) {
    this.#options = options;
  }

  /** Binds the control socket. It refuses a runtime directory that another user could enter. */
  readonly listen = Effect.fn("ServerMode.listen")(function* (this: ServerMode) {
    const path = this.#options.environment.controlSocketPath;
    const directory = yield* remoteCall(() => lstat(dirname(path)));
    const uid = this.#options.uid ?? process.getuid?.();
    if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0) {
      return yield* new RemoteWorkflowError({
        cause: new Error("The server runtime directory must be a private directory of the service user."),
      });
    }
    // A socket from the last run stays after a crash. Anything else at that path is not ours.
    const existing = yield* remoteCall(() =>
      lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
    );
    if (existing && !existing.isSocket()) {
      return yield* new RemoteWorkflowError({ cause: new Error("The control socket path holds another file.") });
    }
    if (existing) yield* remoteCall(() => unlink(path));

    const server = createServer((request, response) => void this.#handle(request, response));
    server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.on("close", () => this.#sockets.delete(socket));
    });
    yield* remoteCall(
      () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(path, () => {
            server.removeListener("error", reject);
            resolve();
          });
        }),
    );
    this.#server = server;
    yield* remoteCall(() => chmod(path, 0o600));
  }).bind(this);

  readonly close = Effect.fn("ServerMode.close")(function* (this: ServerMode) {
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    yield* Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    });
  }).bind(this);

  /**
   * Names and starts the host. The entry point calls this at the start, and the start retry calls
   * it after a failure. Calls run one at a time, so two callers never name two hosts.
   */
  readonly publish = Effect.fn("ServerMode.publish")(function* (this: ServerMode) {
    const previous = this.#publishing;
    const completed = Deferred.makeUnsafe<void>();
    this.#publishing = completed;
    return yield* Effect.gen({ self: this }, function* () {
      if (previous) yield* Deferred.await(previous);
      this.#publishError = null;
      const { host } = this.#options;
      const serverName = this.#pendingName;
      if (!host.getStatus().configured) yield* host.configure({ serverName: serverName ?? DEFAULT_SERVER_NAME });
      else if (serverName && host.getStatus().serverName !== serverName) yield* host.updateIdentity({ serverName });
      this.#pendingName = null;
      yield* host.start();
    }).pipe(
      Effect.tapError(({ cause }) =>
        Effect.sync(() => {
          this.#publishError = cause instanceof Error ? cause.message : sourceText("error.host.publishFailed");
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (this.#publishing === completed) this.#publishing = null;
          Deferred.doneUnsafe(completed, Effect.void);
        }),
      ),
    );
  }, Effect.uninterruptible).bind(this);

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let answer: Answer;
    try {
      const body = await readBody(request);
      answer = body === null ? failure(413, "too_large") : await this.#route(request.method, request.url, body);
    } catch (error) {
      this.#options.onError("A server control request failed.", error);
      // The messages of the account and host services are the ones the app shows. They name no secret.
      answer = failure(400, "failed", error instanceof Error ? error.message : null);
    }
    response
      .writeHead(answer.status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
      .end(formatLines(answer.lines));
  }

  async #route(method: string | undefined, url: string | undefined, body: URLSearchParams): Promise<Answer> {
    const path = url?.split("?")[0] ?? "";
    const route = `${method ?? ""} ${path}`;
    switch (route) {
      case "GET /v1/status":
        return this.#status();
      case "POST /v1/name":
        return runCauseEffect(this.#rename(body.get("name") ?? ""));
      case "POST /v1/pair":
        return runCauseEffect(this.#pair());
      case "GET /v1/devices":
        return this.#devices();
      case "POST /v1/devices/revoke":
        return runCauseEffect(this.#revokeDevice(body.get("id") ?? ""));
      default:
        return failure(404, "not_found");
    }
  }

  #status(): Answer {
    const host = this.#options.host.getStatus();
    return {
      status: 200,
      lines: {
        version: this.#options.version,
        server: host.phase,
        server_name: host.serverName ?? this.#pendingName,
        server_message: this.#publishError ?? host.message,
        ...this.#memoryLines(),
      },
    };
  }

  #memoryLines(): Answer["lines"] {
    const memory = this.#options.memory;
    const sample = memory?.sample();
    if (!memory || !sample) return {};
    return {
      memory_level: memory.level(),
      memory_limit: sample.total,
      memory_available: sample.available,
      turn_limit: memory.turnLimit(),
    };
  }

  /**
   * A code and the same code as a QR code for a terminal, in base64 because an answer line holds no
   * line break. The Android app scans the QR code, and the Mac app takes the address and the code.
   */
  readonly #pair = Effect.fn("ServerMode.pair")(function* (
    this: ServerMode,
  ): Effect.fn.Return<Answer, RemoteWorkflowError> {
    yield* this.publish();
    const pairing = this.#options.host.createPairingCode();
    if (!pairing) return failure(409, "direct_connection_off");
    if (!pairing.publicUrl) return failure(409, "public_url_missing");
    const link = createDirectPairingLink({ url: pairing.publicUrl, code: pairing.code });
    const qr = yield* remoteCall(() => QRCode.toString(link, { type: "terminal", small: true }));
    return {
      status: 200,
      lines: {
        code: pairing.code,
        url: pairing.publicUrl,
        expires_at: pairing.expiresAt,
        qr: Buffer.from(qr).toString("base64"),
      },
    };
  });

  /** One `device_<n>` line for each device: its ID, the time it paired and its name. */
  #devices(): Answer {
    const devices = this.#options.host.listDirectDevices();
    return {
      status: 200,
      lines: {
        count: devices.length,
        ...Object.fromEntries(
          devices.map((device, index) => [`device_${index}`, `${device.id} ${device.pairedAt} ${device.name}`]),
        ),
      },
    };
  }

  readonly #revokeDevice = Effect.fn("ServerMode.revokeDevice")(function* (
    this: ServerMode,
    deviceId: string,
  ): Effect.fn.Return<Answer, RemoteWorkflowError> {
    if (!this.#options.host.listDirectDevices().some((device) => device.id === deviceId))
      return failure(404, "device_not_found");
    yield* this.#options.host.revokeDirectDevice(deviceId);
    return this.#devices();
  });

  readonly #rename = Effect.fn("ServerMode.rename")(function* (
    this: ServerMode,
    name: string,
  ): Effect.fn.Return<Answer, RemoteWorkflowError> {
    const serverName = parseHostedServerName(name);
    if (!serverName) return nameFailure(name);
    const { host } = this.#options;
    if (host.getStatus().configured) {
      yield* host.updateIdentity({ serverName });
    } else {
      this.#pendingName = serverName;
      yield* this.publish();
    }
    return this.#status();
  });
}

/** The form body, or null when it is larger than a control request can be. */
async function readBody(request: IncomingMessage): Promise<URLSearchParams | null> {
  const body = await readBodyWithin(request, MAX_BODY_BYTES);
  return body === null ? null : new URLSearchParams(body.toString("utf8"));
}

function failure(status: number, error: string, message: string | null = null): Answer {
  return { status, lines: { error, message } };
}

/** The message of the team store for a name that it refuses. */
function nameFailure(name: string): Answer {
  const length = name.trim().length;
  const message =
    length < INPUT_LIMITS.serverNameMin || length > INPUT_LIMITS.serverName
      ? sourceText("error.team.serverNameLength", { min: INPUT_LIMITS.serverNameMin, max: INPUT_LIMITS.serverName })
      : sourceText("error.team.serverNameHostname");
  return failure(400, "invalid_name", message);
}

/** One `key=value` line for each value. A value never breaks its line. */
function formatLines(lines: Answer["lines"]): string {
  return Object.entries(lines)
    .filter((entry): entry is [string, string | number] => entry[1] !== null && entry[1] !== "")
    .map(([key, value]) => `${key}=${String(value).replace(/[\r\n]+/gu, " ")}\n`)
    .join("");
}
