import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createTommyLogger, toLogValue } from "@tommy/logging";
import { Effect } from "effect";
import { RemoteWorkflowError } from "./remote-service-effects";

const logger = createTommyLogger("public-http");

export type PublicHttpRoute = (request: IncomingMessage, response: ServerResponse) => Effect.Effect<boolean>;

/**
 * The one public entry of the server: Telegram webhooks, the Telegram Mini App and workflow
 * webhooks. It listens on loopback only; the reverse proxy holds TLS and forwards these paths.
 * Each route answers the requests that it owns and returns false for the others.
 */
export class PublicHttpServer {
  #server: Server | null = null;

  constructor(
    private readonly listen: { host: string; port: number },
    private readonly routes: () => readonly PublicHttpRoute[],
  ) {}

  get listening(): boolean {
    return this.#server !== null;
  }

  readonly start = Effect.fn("PublicHttpServer.start")(function* (this: PublicHttpServer) {
    if (this.#server) return;
    const server = createServer((request, response) => this.#handle(request, response));
    yield* Effect.callback<void, RemoteWorkflowError>((resume) => {
      server.once("error", (cause) => resume(Effect.fail(new RemoteWorkflowError({ cause }))));
      server.listen(this.listen.port, this.listen.host, () => resume(Effect.void));
    });
    this.#server = server;
  }).bind(this);

  readonly stop = Effect.fn("PublicHttpServer.stop")(function* (this: PublicHttpServer) {
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    server.closeAllConnections();
    yield* Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    });
  }).bind(this);

  #handle(request: IncomingMessage, response: ServerResponse): void {
    const routes = this.routes();
    const next = (index: number): Effect.Effect<boolean> => {
      const route = routes[index];
      return route
        ? route(request, response).pipe(Effect.flatMap((handled) => (handled ? Effect.succeed(true) : next(index + 1))))
        : Effect.succeed(false);
    };
    void Effect.runPromise(
      next(0).pipe(
        Effect.tap((handled) =>
          Effect.sync(() => {
            if (!handled && !response.headersSent) response.writeHead(404, { "cache-control": "no-store" }).end();
          }),
        ),
        // A defect in a public route must not leave the sender waiting for the proxy deadline.
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            logger.warn("A public request failed.", toLogValue(cause));
            if (response.headersSent || response.destroyed) response.destroy();
            else response.writeHead(500, { "cache-control": "no-store" }).end();
          }),
        ),
      ),
    );
  }
}
