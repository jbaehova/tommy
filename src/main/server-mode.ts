/**
 * The Tommy server: the packaged Linux build that `tommy-install` installs on a computer with no
 * screen. systemd starts it with `TOMMY_SERVER=1` under a virtual display. People use it through
 * Telegram; there is no app that connects to it.
 *
 * The `tommy` terminal command (`scripts/hosting/tommy`) talks to this process over a Unix socket
 * in the runtime directory that systemd makes for the service user (mode 0700). Only that user and
 * root can connect. The socket answers one request: the status of the server.
 *
 * The protocol is HTTP with `key=value` text lines, so the command needs only `curl --unix-socket`.
 */

import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { Effect } from "effect";
import { readBodyWithin } from "./http-body";
import { RemoteWorkflowError, remoteCall } from "./remote-service-effects";
import type { ServerMemory } from "./server-memory";

const CONTROL_SOCKET_FILE = "control.sock";
const MAX_BODY_BYTES = 4096;

export interface ServerModeEnvironment {
  controlSocketPath: string;
}

/** Returns null unless this process is a server that systemd started. */
export function takeServerModeEnvironment(
  environment: NodeJS.ProcessEnv,
  isPackaged: boolean,
  platform: NodeJS.Platform,
): ServerModeEnvironment | null {
  if (!isPackaged || platform !== "linux" || environment.TOMMY_SERVER !== "1") return null;
  const runtimeDirectory = environment.XDG_RUNTIME_DIR?.trim() ?? "";
  if (!isAbsolute(runtimeDirectory)) return null;
  return { controlSocketPath: join(runtimeDirectory, CONTROL_SOCKET_FILE) };
}

export interface ServerModeOptions {
  environment: ServerModeEnvironment;
  version: string;
  /** Extra status lines, such as whether Telegram listens. */
  status: () => Record<string, string | number | null>;
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

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let answer: Answer;
    try {
      const body = await readBody(request);
      answer = body === null ? failure(413, "too_large") : await this.#route(request.method, request.url);
    } catch (error) {
      this.#options.onError("A server control request failed.", error);
      // The status lines name no secret.
      answer = failure(400, "failed", error instanceof Error ? error.message : null);
    }
    response
      .writeHead(answer.status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
      .end(formatLines(answer.lines));
  }

  async #route(method: string | undefined, url: string | undefined): Promise<Answer> {
    const path = url?.split("?")[0] ?? "";
    const route = `${method ?? ""} ${path}`;
    switch (route) {
      case "GET /v1/status":
        return this.#status();
      default:
        return failure(404, "not_found");
    }
  }

  #status(): Answer {
    return {
      status: 200,
      lines: { version: this.#options.version, ...this.#options.status(), ...this.#memoryLines() },
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
}

/** The form body, or null when it is larger than a control request can be. */
async function readBody(request: IncomingMessage): Promise<URLSearchParams | null> {
  const body = await readBodyWithin(request, MAX_BODY_BYTES);
  return body === null ? null : new URLSearchParams(body.toString("utf8"));
}

function failure(status: number, error: string, message: string | null = null): Answer {
  return { status, lines: { error, message } };
}

/** One `key=value` line for each value. A value never breaks its line. */
function formatLines(lines: Answer["lines"]): string {
  return Object.entries(lines)
    .filter((entry): entry is [string, string | number] => entry[1] !== null && entry[1] !== "")
    .map(([key, value]) => `${key}=${String(value).replace(/[\r\n]+/gu, " ")}\n`)
    .join("");
}
