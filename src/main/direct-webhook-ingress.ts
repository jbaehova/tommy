import type { IncomingMessage, ServerResponse } from "node:http";
import { WEBHOOK_DELIVERY_BODY_BYTES_LIMIT } from "@tommy/contracts/signal-protocol/messages";
import {
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "@tommy/contracts/signal-protocol/webhook-route";
import { Effect, Schema } from "effect";
import type { HostWebhookRelay, WebhookIngressDelivery } from "./host-events-service";
import { readBodyWithin } from "./http-body";
import { GITHUB_WEBHOOK_BODY_BYTES_LIMIT, type WorkflowConnectors } from "./workflow-connectors";

const ROUTE_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROUTINE_PATH = new RegExp(`^/hooks/(${ROUTE_ID})$`, "i");
const CONNECTION_PATH = /^\/hooks\/(slack|telegram)\/([A-Za-z0-9_-]{1,128})$/;
const BODY_DEADLINE_MS = 15_000;

class DirectWebhookFailure extends Schema.TaggedError<DirectWebhookFailure>()("DirectWebhookFailure", {
  code: Schema.Literals(["read_failed", "not_configured", "invalid_route"]),
}) {}

export interface DirectWebhookIngressOptions {
  /** A getter avoids construction cycles with the workflow and event services. */
  events(): {
    receive(input: WebhookIngressDelivery): Effect.Effect<{ status: number }, { readonly cause: unknown }>;
  } | null;
  connectors?: WorkflowConnectors;
  /** Enabled only for an explicit public HTTPS origin. */
  enabled(): boolean;
}

/** A local URL adapter for the existing durable route store. It opens no account or relay socket. */
export class DirectWebhookRoutes implements HostWebhookRelay {
  readonly #origin: string | null;
  #enabled = false;
  #active = true;
  #listening = false;

  constructor(publicOrigin: string | null) {
    if (publicOrigin !== null) {
      const url = new URL(publicOrigin);
      if (url.protocol !== "https:" || url.origin !== publicOrigin)
        throw new DirectWebhookFailure({ code: "not_configured" });
    }
    this.#origin = publicOrigin;
  }

  connected(): boolean {
    return this.#origin !== null && this.#listening && this.#active;
  }

  configured(): boolean {
    return this.#origin !== null;
  }

  setListening(listening: boolean): void {
    this.#listening = listening;
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  setAccountActive(active: boolean): void {
    this.#active = active;
  }

  refresh(): void {
    // Route authorization is read from SQLite for every delivery, not cached by this adapter.
  }

  readonly registerRoute = Effect.fn("DirectWebhookRoutes.registerRoute")(function* (
    this: DirectWebhookRoutes,
    routeId: string,
  ) {
    if (!this.#origin || !this.#active)
      return yield* Effect.fail({ cause: new DirectWebhookFailure({ code: "not_configured" }) });
    if (!new RegExp(`^${ROUTE_ID}$`, "i").test(routeId))
      return yield* Effect.fail({ cause: new DirectWebhookFailure({ code: "invalid_route" }) });
    return `${this.#origin}/hooks/${routeId}`;
  }).bind(this);

  readonly revokeRoute = Effect.fn("DirectWebhookRoutes.revokeRoute")(function* (
    this: DirectWebhookRoutes,
    _routeId: string,
  ) {
    // Deletion has already removed the durable route. There is no external route claim to revoke.
    yield* Effect.void;
  }).bind(this);

  hasRoutes(): boolean {
    return this.#enabled;
  }
}

/** The single value of an HTTP header. Duplicate security headers are refused. */
function header(request: IncomingMessage, name: string): string {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  const value = request.headers[name];
  return count === 1 && typeof value === "string" ? value : "";
}

function reply(response: ServerResponse, status: number, challenge?: string): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(challenge === undefined ? JSON.stringify({ accepted: status < 300 }) : JSON.stringify({ challenge }));
}

const readWebhookBody = Effect.fn("DirectWebhookIngress.readBody")(function* (
  request: IncomingMessage,
  limitBytes: number,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const deadline = setTimeout(() => request.destroy(), BODY_DEADLINE_MS);
      deadline.unref();
      try {
        return await readBodyWithin(request, limitBytes);
      } finally {
        clearTimeout(deadline);
      }
    },
    catch: () => new DirectWebhookFailure({ code: "read_failed" }),
  });
});

/** Public POST routes run before paired-device authentication. Every route has its own signature check. */
export class DirectWebhookIngress {
  readonly #options: DirectWebhookIngressOptions;

  constructor(options: DirectWebhookIngressOptions) {
    this.#options = options;
  }

  readonly handle = Effect.fn("DirectWebhookIngress.handle")(function* (
    this: DirectWebhookIngress,
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    // Query strings, encoded separators and other HTTP methods do not claim a public route.
    if (request.method !== "POST" || !request.url || request.url.includes("?")) return false;
    const routine = ROUTINE_PATH.exec(request.url);
    const connection = CONNECTION_PATH.exec(request.url);
    const github = request.url === "/hooks/github";
    if (!routine && !connection && !github) return false;
    if (!this.#options.enabled()) {
      reply(response, 404);
      return true;
    }
    // A GitHub event holds the full pull request or issue and is often larger than a routine delivery.
    const limitBytes = github ? GITHUB_WEBHOOK_BODY_BYTES_LIMIT : WEBHOOK_DELIVERY_BODY_BYTES_LIMIT;
    const contentLength = header(request, "content-length");
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > limitBytes)) {
      reply(response, 413);
      return true;
    }
    if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") {
      reply(response, 415);
      return true;
    }
    const read = yield* Effect.result(readWebhookBody(request, limitBytes));
    if (read._tag === "Failure") {
      if (!response.destroyed) reply(response, 400);
      return true;
    }
    if (!read.success) {
      if (!response.destroyed) reply(response, 413);
      return true;
    }
    const body = read.success;
    if (routine?.[1]) {
      const events = this.#options.events();
      if (!events) {
        reply(response, 503);
        return true;
      }
      const standardHeaders = ["webhook-id", "webhook-timestamp", "webhook-signature"];
      const standard = standardHeaders.some((name) => request.headers[name] !== undefined);
      const tommy = [WEBHOOK_DELIVERY_ID_HEADER, WEBHOOK_TIMESTAMP_HEADER, WEBHOOK_SIGNATURE_HEADER].some(
        (name) => request.headers[name] !== undefined,
      );
      // Mixed formats can otherwise make proxies and verifiers authenticate different deliveries.
      if (standard && tommy) {
        reply(response, 401);
        return true;
      }
      const result = yield* Effect.result(
        events.receive({
          routeId: routine[1],
          deliveryId: header(request, standard ? "webhook-id" : WEBHOOK_DELIVERY_ID_HEADER),
          timestamp: header(request, standard ? "webhook-timestamp" : WEBHOOK_TIMESTAMP_HEADER),
          signature: header(request, standard ? "webhook-signature" : WEBHOOK_SIGNATURE_HEADER),
          body,
          ...(standard ? { format: "standard" } : {}),
        }),
      );
      reply(response, result._tag === "Success" ? result.success.status : 503);
      return true;
    }
    const connectors = this.#options.connectors;
    if (!connectors) {
      reply(response, 404);
      return true;
    }
    const input = { header: (name: string) => header(request, name), body };
    const result = github
      ? yield* connectors.receiveGitHub(input)
      : connection?.[1] === "slack"
        ? yield* connectors.receiveSlack(connection[2] ?? "", input)
        : yield* connectors.receiveTelegram(connection?.[2] ?? "", input);
    reply(response, result.status, result.challenge);
    return true;
  }).bind(this);
}
