import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolveLocale, translateFor } from "@tommy/i18n";
import type { sourceText } from "@tommy/i18n/source";
import { createTommyLogger, toLogValue } from "@tommy/logging";
import { Effect, Option, Schema } from "effect";
import { readBodyWithin } from "../http-body";
import type { RemoteMcpGrants, RemoteMcpTokens } from "./remote-mcp-grants";
import { type RemoteMcpPageText, remoteMcpPage } from "./remote-mcp-page";
import type { RemoteMcpSettings } from "./remote-mcp-settings";
import type { RemoteMcpTools } from "./remote-mcp-tools";

const logger = createTommyLogger("remote-mcp");

const REMOTE_MCP_PATH = "/mcp";
const SCOPE = "tommy.read";
/** A sign-in request waits this long for its code. */
const REQUEST_MS = 10 * 60_000;
/** An authorization code is exchanged at once; it is valid for one minute and one use. */
const CODE_MS = 60_000;
const CODE_TRIES = 5;
const MAX_PENDING = 3;
/** New sign-in requests and client registrations in one hour. Each request sends a Telegram message. */
const REQUESTS_PER_HOUR = 10;
const REGISTRATIONS_PER_HOUR = 10;
const FORM_BYTES = 16 * 1024;
const MCP_BYTES = 1024 * 1024;
const BODY_DEADLINE_MS = 10_000;

type Translate = typeof sourceText;

export interface RemoteMcpEndpointOptions {
  settings: RemoteMcpSettings;
  grants: RemoteMcpGrants;
  tools: RemoteMcpTools;
  /** A notice in the owner's Telegram manager chat. False or a failure when Telegram cannot take it. */
  tellOwner(text: (t: Translate) => string): Effect.Effect<boolean, unknown>;
  version: string;
  now?: () => number;
}

interface PendingRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string | null;
  code: string;
  tries: number;
  expiresAt: number;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  expiresAt: number;
}

class RemoteMcpBodyError extends Schema.TaggedError<RemoteMcpBodyError>()("RemoteMcpBodyError", {
  reason: Schema.Literals(["unreadable", "too_large"]),
}) {}

const readBody = Effect.fn("RemoteMcpEndpoint.readBody")(function* (request: IncomingMessage, limit: number) {
  const declared = request.headers["content-length"];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit))
    return yield* new RemoteMcpBodyError({ reason: "too_large" });
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity")
    return yield* new RemoteMcpBodyError({ reason: "unreadable" });
  const body = yield* Effect.tryPromise({
    try: async () => {
      const deadline = setTimeout(() => request.destroy(), BODY_DEADLINE_MS);
      deadline.unref();
      try {
        return await readBodyWithin(request, limit);
      } finally {
        clearTimeout(deadline);
      }
    },
    catch: () => new RemoteMcpBodyError({ reason: "unreadable" }),
  });
  if (!body) return yield* new RemoteMcpBodyError({ reason: "too_large" });
  return body;
});

function mediaType(request: IncomingMessage): string {
  return request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  response
    .writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    })
    .end(JSON.stringify(value));
}

function oauthError(response: ServerResponse, status: number, error: string, description?: string) {
  sendJson(response, status, description ? { error, error_description: description } : { error });
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The fields of a registration (RFC 7591) that Tommy reads. Others are ignored. */
const decodeClientMetadata = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      redirect_uris: Schema.Array(Schema.String),
      token_endpoint_auth_method: Schema.optional(Schema.String),
      grant_types: Schema.optional(Schema.Array(Schema.String)),
      client_name: Schema.optional(Schema.String),
    }),
  ),
);

const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;

/** A sliding count of events in the last hour. */
class HourlyLimit {
  #times: number[] = [];
  constructor(
    readonly limit: number,
    readonly now: () => number,
  ) {}
  take(): boolean {
    const now = this.now();
    this.#times = this.#times.filter((time) => time > now - 3_600_000);
    if (this.#times.length >= this.limit) return false;
    this.#times.push(now);
    return true;
  }
}

/**
 * The remote MCP endpoint of a Tommy server: an OAuth 2.1 authorization server for one owner and a
 * read-only Streamable HTTP MCP server at `/mcp`. A client such as a claude.ai connector registers
 * itself, then sends the owner to `/oauth/authorize`. Tommy sends a one-time code to the owner's
 * Telegram manager chat, and only that code typed on the page gives the client a grant. So a person
 * who starts a sign-in elsewhere gets nothing without the owner's Telegram.
 */
export class RemoteMcpEndpoint {
  readonly #options: RemoteMcpEndpointOptions;
  readonly #now: () => number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #codes = new Map<string, AuthorizationCode>();
  readonly #requests: HourlyLimit;
  readonly #registrations: HourlyLimit;

  constructor(options: RemoteMcpEndpointOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#requests = new HourlyLimit(REQUESTS_PER_HOUR, this.#now);
    this.#registrations = new HourlyLimit(REGISTRATIONS_PER_HOUR, this.#now);
  }

  get #origin(): string {
    return this.#options.settings.origin;
  }

  get #resource(): string {
    return `${this.#origin}${REMOTE_MCP_PATH}`;
  }

  readonly handle = Effect.fn("RemoteMcpEndpoint.handle")(function* (
    this: RemoteMcpEndpoint,
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const url = URL.parse(request.url ?? "", this.#origin);
    if (!url || !request.url?.startsWith("/")) return false;
    const path = url.pathname;
    const method = request.method ?? "";
    const known =
      path === REMOTE_MCP_PATH ||
      path.startsWith("/.well-known/oauth-protected-resource") ||
      path.startsWith("/.well-known/oauth-authorization-server") ||
      path.startsWith("/oauth/");
    if (!known) return false;
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    this.#sweep();
    if (path === REMOTE_MCP_PATH) {
      yield* this.#mcp(request, response);
      return true;
    }
    if (method === "GET" && /^\/\.well-known\/oauth-protected-resource(\/mcp)?$/.test(path)) {
      sendJson(response, 200, {
        resource: this.#resource,
        authorization_servers: [this.#origin],
        scopes_supported: [SCOPE],
        bearer_methods_supported: ["header"],
        resource_name: "Tommy",
      });
      return true;
    }
    if (method === "GET" && /^\/\.well-known\/oauth-authorization-server(\/mcp)?$/.test(path)) {
      sendJson(response, 200, {
        issuer: this.#origin,
        authorization_endpoint: `${this.#origin}/oauth/authorize`,
        token_endpoint: `${this.#origin}/oauth/token`,
        registration_endpoint: `${this.#origin}/oauth/register`,
        revocation_endpoint: `${this.#origin}/oauth/revoke`,
        scopes_supported: [SCOPE],
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
        revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      });
      return true;
    }
    if (path === "/oauth/register" && method === "POST") yield* this.#register(request, response);
    else if (path === "/oauth/authorize" && method === "GET") yield* this.#authorize(request, response, url);
    else if (path === "/oauth/authorize" && method === "POST") yield* this.#decide(request, response);
    else if (path === "/oauth/token" && method === "POST") yield* this.#token(request, response);
    else if (path === "/oauth/revoke" && method === "POST") yield* this.#revoke(request, response);
    else response.writeHead(path.startsWith("/oauth/") ? 405 : 404, { "Cache-Control": "no-store" }).end();
    return true;
  }).bind(this);

  #sweep(): void {
    const now = this.#now();
    for (const [id, entry] of this.#pending) if (entry.expiresAt <= now) this.#pending.delete(id);
    for (const [code, entry] of this.#codes) if (entry.expiresAt <= now) this.#codes.delete(code);
  }

  #locale(request: IncomingMessage) {
    return resolveLocale("system", request.headers["accept-language"]?.split(",")[0]?.trim() ?? "en");
  }

  #page(
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    text: RemoteMcpPageText,
    formTarget?: string,
  ) {
    const nonce = randomBytes(18).toString("base64");
    // Browsers check a form's redirect target against form-action, so the client's address is in it.
    const formAction = ["'self'", ...(formTarget ? [formTarget] : [])].join(" ");
    response
      .writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
        "X-Frame-Options": "DENY",
      })
      .end(remoteMcpPage(nonce, this.#locale(request), text));
  }

  #endedPage(request: IncomingMessage, response: ServerResponse, status = 400) {
    const t = translateFor(this.#locale(request));
    this.#page(request, response, status, {
      title: t("status.messaging.remoteMcpEndedTitle"),
      body: t("status.messaging.remoteMcpEndedBody"),
    });
  }

  #invalidPage(request: IncomingMessage, response: ServerResponse) {
    const t = translateFor(this.#locale(request));
    this.#page(request, response, 400, {
      title: t("status.messaging.remoteMcpInvalidTitle"),
      body: t("status.messaging.remoteMcpInvalidBody"),
    });
  }

  readonly #register = Effect.fn("RemoteMcpEndpoint.register")(function* (
    this: RemoteMcpEndpoint,
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    if (mediaType(request) !== "application/json") return oauthError(response, 415, "invalid_client_metadata");
    const body = yield* Effect.result(readBody(request, FORM_BYTES));
    if (body._tag === "Failure") return oauthError(response, 400, "invalid_client_metadata");
    const decoded = decodeClientMetadata(body.success.toString("utf8"));
    if (Option.isNone(decoded)) return oauthError(response, 400, "invalid_client_metadata");
    const metadata = decoded.value;
    const redirects = metadata.redirect_uris;
    if (
      redirects.length < 1 ||
      redirects.length > 5 ||
      !redirects.every((uri) => this.#options.settings.redirectUris.includes(uri))
    )
      return oauthError(response, 400, "invalid_redirect_uri", "This server accepts only known connector addresses.");
    const method = metadata.token_endpoint_auth_method ?? "client_secret_basic";
    if (method !== "none" && method !== "client_secret_post" && method !== "client_secret_basic")
      return oauthError(response, 400, "invalid_client_metadata", "Unsupported token_endpoint_auth_method.");
    if (!(metadata.grant_types ?? []).every((type) => type === "authorization_code" || type === "refresh_token"))
      return oauthError(response, 400, "invalid_client_metadata", "Unsupported grant_types.");
    if (!this.#registrations.take()) return oauthError(response, 429, "temporarily_unavailable");
    const rawName = metadata.client_name ?? "";
    const name =
      rawName
        .replace(/[^\p{L}\p{N} ._()-]/gu, "")
        .slice(0, 60)
        .trim() || "MCP client";
    const registered = yield* Effect.result(
      this.#options.grants.register({ name, redirectUris: redirects, confidential: method !== "none" }),
    );
    if (registered._tag === "Failure") {
      logger.warn("Tommy could not save a remote MCP client.", toLogValue(registered.failure));
      return oauthError(response, 500, "server_error");
    }
    const { client, secret } = registered.success;
    sendJson(response, 201, {
      client_id: client.id,
      ...(secret === null ? {} : { client_secret: secret, client_secret_expires_at: 0 }),
      client_id_issued_at: Math.floor(this.#now() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SCOPE,
    });
  }).bind(this);

  /** The client's own redirect with an error, after the client and its address are known to be valid. */
  #redirect(response: ServerResponse, redirectUri: string, params: Record<string, string | null>) {
    const target = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) if (value !== null) target.searchParams.set(key, value);
    target.searchParams.set("iss", this.#origin);
    response.writeHead(302, { Location: target.href, "Cache-Control": "no-store" }).end();
  }

  readonly #authorize = Effect.fn("RemoteMcpEndpoint.authorize")(function* (
    this: RemoteMcpEndpoint,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ) {
    const query = url.searchParams;
    const single = (name: string) => (query.getAll(name).length === 1 ? (query.get(name) ?? "") : null);
    const client = this.#options.grants.client(single("client_id") ?? "");
    const redirectUri = single("redirect_uri") ?? (client?.redirectUris.length === 1 ? client.redirectUris[0] : null);
    // Without a valid client and address, an error must not redirect: the address could be anyone's.
    if (!client || !redirectUri || !client.redirectUris.includes(redirectUri))
      return this.#invalidPage(request, response);
    const state = single("state");
    if (state !== null && state.length > 1024) return this.#invalidPage(request, response);
    const fail = (error: string) => this.#redirect(response, redirectUri, { error, state });
    if (single("response_type") !== "code") return fail("unsupported_response_type");
    const challenge = single("code_challenge");
    if (!challenge || !PKCE_VALUE.test(challenge) || single("code_challenge_method") !== "S256")
      return fail("invalid_request");
    const resource = single("resource");
    if (resource !== null && resource.replace(/\/$/, "") !== this.#resource) return fail("invalid_target");
    if (!this.#requests.take()) {
      const t = translateFor(this.#locale(request));
      return this.#page(request, response, 429, {
        title: t("status.messaging.remoteMcpBusyTitle"),
        body: t("status.messaging.remoteMcpBusyBody"),
      });
    }
    const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
    const pending: PendingRequest = {
      id: randomBytes(24).toString("base64url"),
      clientId: client.id,
      redirectUri,
      challenge,
      state,
      code,
      tries: 0,
      expiresAt: this.#now() + REQUEST_MS,
    };
    const shownClient = new URL(redirectUri).host;
    const told = yield* this.#options
      .tellOwner((t) => {
        const params = { client: shownClient, code: `${code.slice(0, 4)} ${code.slice(4)}` };
        return this.#options.settings.knowledgeAgent
          ? t("status.messaging.remoteMcpCodeSave", params)
          : t("status.messaging.remoteMcpCode", params);
      })
      .pipe(Effect.orElseSucceed(() => false));
    if (!told) {
      const t = translateFor(this.#locale(request));
      return this.#page(request, response, 503, {
        title: t("status.messaging.remoteMcpUnavailableTitle"),
        body: t("status.messaging.remoteMcpUnavailableBody"),
      });
    }
    // The oldest waiting request makes room. Each one has its own code.
    while (this.#pending.size >= MAX_PENDING) {
      const oldest = this.#pending.keys().next().value;
      if (oldest === undefined) break;
      this.#pending.delete(oldest);
    }
    this.#pending.set(pending.id, pending);
    this.#codePage(request, response, 200, pending, null);
  }).bind(this);

  #codePage(
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    pending: PendingRequest,
    error: string | null,
  ) {
    const t = translateFor(this.#locale(request));
    const target = new URL(pending.redirectUri);
    this.#page(
      request,
      response,
      status,
      {
        title: t("status.messaging.remoteMcpTitle"),
        body: this.#options.settings.knowledgeAgent
          ? t("status.messaging.remoteMcpBodySave")
          : t("status.messaging.remoteMcpBody"),
        form: {
          request: pending.id,
          client: target.host,
          clientLabel: t("status.messaging.remoteMcpClient"),
          codeLabel: t("status.messaging.remoteMcpCodeLabel"),
          approve: t("status.messaging.remoteMcpAllow"),
          deny: t("status.messaging.remoteMcpDeny"),
          error,
        },
      },
      target.origin,
    );
  }

  readonly #decide = Effect.fn("RemoteMcpEndpoint.decide")(function* (
    this: RemoteMcpEndpoint,
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    if (mediaType(request) !== "application/x-www-form-urlencoded") return this.#invalidPage(request, response);
    const body = yield* Effect.result(readBody(request, FORM_BYTES));
    if (body._tag === "Failure") return this.#invalidPage(request, response);
    const form = new URLSearchParams(body.success.toString("utf8"));
    const pending = this.#pending.get(form.get("request") ?? "");
    if (!pending || pending.expiresAt <= this.#now()) return this.#endedPage(request, response);
    if (form.get("decision") === "deny") {
      this.#pending.delete(pending.id);
      return this.#redirect(response, pending.redirectUri, { error: "access_denied", state: pending.state });
    }
    const typed = (form.get("code") ?? "").replace(/\s/g, "");
    if (!sameText(typed, pending.code)) {
      pending.tries += 1;
      if (pending.tries >= CODE_TRIES) {
        this.#pending.delete(pending.id);
        return this.#endedPage(request, response, 403);
      }
      const t = translateFor(this.#locale(request));
      return this.#codePage(
        request,
        response,
        400,
        pending,
        t("status.messaging.remoteMcpWrongCode", { count: CODE_TRIES - pending.tries }),
      );
    }
    this.#pending.delete(pending.id);
    const code = randomBytes(32).toString("base64url");
    this.#codes.set(code, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      challenge: pending.challenge,
      expiresAt: this.#now() + CODE_MS,
    });
    this.#redirect(response, pending.redirectUri, { code, state: pending.state });
  }).bind(this);

  /** The client of a token or revocation request, or null when its authentication fails. */
  #client(request: IncomingMessage, form: URLSearchParams): string | null {
    const header = request.headers.authorization;
    let id = form.get("client_id");
    let secret = form.get("client_secret");
    if (header?.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const split = decoded.indexOf(":");
      if (split < 0) return null;
      let headerId: string;
      try {
        headerId = decodeURIComponent(decoded.slice(0, split));
        secret = decodeURIComponent(decoded.slice(split + 1));
      } catch {
        return null;
      }
      if (id !== null && id !== headerId) return null;
      id = headerId;
    }
    if (!id || !this.#options.grants.client(id)) return null;
    return this.#options.grants.clientSecretMatches(id, secret || null) ? id : null;
  }

  #tokens(response: ServerResponse, tokens: RemoteMcpTokens) {
    sendJson(
      response,
      200,
      {
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: SCOPE,
      },
      { Pragma: "no-cache" },
    );
  }

  readonly #token = Effect.fn("RemoteMcpEndpoint.token")(function* (
    this: RemoteMcpEndpoint,
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    if (mediaType(request) !== "application/x-www-form-urlencoded") return oauthError(response, 400, "invalid_request");
    const body = yield* Effect.result(readBody(request, FORM_BYTES));
    if (body._tag === "Failure") return oauthError(response, 400, "invalid_request");
    const form = new URLSearchParams(body.success.toString("utf8"));
    const clientId = this.#client(request, form);
    if (!clientId) return oauthError(response, 401, "invalid_client");
    const resource = form.get("resource");
    if (resource !== null && resource.replace(/\/$/, "") !== this.#resource)
      return oauthError(response, 400, "invalid_target");
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      const value = form.get("code") ?? "";
      const code = this.#codes.get(value);
      // One use: a failed exchange spends the code too.
      this.#codes.delete(value);
      const verifier = form.get("code_verifier") ?? "";
      if (
        !code ||
        code.expiresAt <= this.#now() ||
        code.clientId !== clientId ||
        code.redirectUri !== (form.get("redirect_uri") ?? code.redirectUri) ||
        !PKCE_VALUE.test(verifier) ||
        !sameText(sha256Base64Url(verifier), code.challenge)
      )
        return oauthError(response, 400, "invalid_grant");
      const granted = yield* Effect.result(this.#options.grants.grant(clientId));
      if (granted._tag === "Failure") {
        logger.warn("Tommy could not save a remote MCP sign-in.", toLogValue(granted.failure));
        return oauthError(response, 500, "server_error");
      }
      this.#tokens(response, granted.success);
      const client = new URL(code.redirectUri).host;
      yield* this.#options
        .tellOwner((t) =>
          this.#options.settings.knowledgeAgent
            ? t("status.messaging.remoteMcpConnectedSave", { client })
            : t("status.messaging.remoteMcpConnected", { client }),
        )
        .pipe(Effect.ignore);
      return;
    }
    if (grantType === "refresh_token") {
      const refreshed = yield* Effect.result(this.#options.grants.refresh(clientId, form.get("refresh_token") ?? ""));
      if (refreshed._tag === "Failure") {
        logger.warn("Tommy could not save a remote MCP sign-in.", toLogValue(refreshed.failure));
        return oauthError(response, 500, "server_error");
      }
      if (!refreshed.success) return oauthError(response, 400, "invalid_grant");
      return this.#tokens(response, refreshed.success);
    }
    return oauthError(response, 400, "unsupported_grant_type");
  }).bind(this);

  readonly #revoke = Effect.fn("RemoteMcpEndpoint.revoke")(function* (
    this: RemoteMcpEndpoint,
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    if (mediaType(request) !== "application/x-www-form-urlencoded") return oauthError(response, 400, "invalid_request");
    const body = yield* Effect.result(readBody(request, FORM_BYTES));
    if (body._tag === "Failure") return oauthError(response, 400, "invalid_request");
    const form = new URLSearchParams(body.success.toString("utf8"));
    if (!this.#client(request, form)) return oauthError(response, 401, "invalid_client");
    const token = form.get("token");
    if (token) yield* this.#options.grants.revokeToken(token).pipe(Effect.ignore);
    response.writeHead(200, { "Cache-Control": "no-store" }).end();
  }).bind(this);

  #unauthorized(response: ServerResponse, invalid: boolean) {
    const challenge = [
      `Bearer resource_metadata="${this.#origin}/.well-known/oauth-protected-resource${REMOTE_MCP_PATH}"`,
      `scope="${SCOPE}"`,
      ...(invalid ? ['error="invalid_token"'] : []),
    ].join(", ");
    sendJson(response, 401, { error: invalid ? "invalid_token" : "unauthorized" }, { "WWW-Authenticate": challenge });
  }

  readonly #mcp = Effect.fn("RemoteMcpEndpoint.mcp")(function* (
    this: RemoteMcpEndpoint,
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const header = request.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
    const access = bearer ? this.#options.grants.authenticate(bearer) : null;
    if (!access) return this.#unauthorized(response, bearer !== null);
    // The server keeps no session: each POST carries its own messages, and a stream is not offered.
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST", "Cache-Control": "no-store" }).end();
      return;
    }
    const body = yield* Effect.result(readBody(request, MCP_BYTES));
    if (body._tag === "Failure") {
      if (!response.destroyed)
        sendJson(response, body.failure.reason === "too_large" ? 413 : 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Unreadable request." },
        });
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(body.success.toString("utf8"));
    } catch {
      return sendJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
    }
    const tools = this.#options.tools;
    // The client's redirect host names it in the owner's chats. Its registered name is its own text.
    const redirect = this.#options.grants.client(access.clientId)?.redirectUris[0];
    const caller = { client: redirect ? (URL.parse(redirect)?.host ?? "a remote MCP client") : "a remote MCP client" };
    const server = new Server(
      { name: "tommy", title: "Tommy", version: this.#options.version },
      { capabilities: { tools: {} }, instructions: tools.instructions },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.list() }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      try {
        const result = await tools.call(params.name, params.arguments, caller);
        return { content: [{ type: "text" as const, text: result.text }], isError: result.isError };
      } catch (error) {
        logger.warn("A remote MCP tool failed.", { tool: params.name, error: toLogValue(error) });
        return { content: [{ type: "text" as const, text: "Tommy could not do this now." }], isError: true };
      }
    });
    // No `sessionIdGenerator`: the transport runs stateless, one transport for each request.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    yield* Effect.tryPromise({
      try: async () => {
        await server.connect(transport);
        await transport.handleRequest(request, response, message);
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          logger.warn("A remote MCP request failed.", toLogValue(cause));
          if (!response.headersSent)
            sendJson(response, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error." } });
        }),
      ),
      Effect.ensuring(
        Effect.promise(async () => {
          await transport.close().catch(() => undefined);
          await server.close().catch(() => undefined);
        }),
      ),
    );
  }).bind(this);
}
