/**
 * T3 Code links: the T3 Code environments where the agents of this server can start, read and
 * message sessions. T3 Code answers MCP at `<origin>/mcp`. `tommy t3 link` signs in there with a
 * one-time pairing code from `t3 pair` on that computer. The access token becomes the
 * `Authorization` header of an http MCP server row, so every agent gets the tools that T3 Code
 * gives an outside client, and the access level chosen at link time is the ceiling there.
 *
 * The sign-in is the one that `t3 environment link` uses between two T3 Code computers: register a
 * client, send the pairing code as the decision, then exchange the code for a token. No browser
 * opens, and a server has none. T3 Code gives the token 30 days and no refresh, so Tommy tells the
 * owner before it ends, and the owner links again.
 *
 * The link file holds no secret: the token is only in the MCP row, which Tommy masks in logs.
 */

import { createHash, randomBytes } from "node:crypto";
import { createMcpServerId, type McpServerConfig } from "@tommy/contracts/ipc";
import { isDynamicRecord, isOneOf, isString } from "@tommy/contracts/runtime-values";
import { Effect, Result, Schema, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

/** The access levels of T3 Code, from least to most. T3 Code refuses a level above the pairing code. */
export const T3_LINK_ACCESS = ["read-only", "approval-required", "auto-accept-edits", "auto", "full-access"] as const;
export type T3LinkAccess = (typeof T3_LINK_ACCESS)[number];

export function isT3LinkAccess(value: string): value is T3LinkAccess {
  return isOneOf(T3_LINK_ACCESS, value);
}

/** A short name such as `mac` or `vps`. The MCP server row is `t3-<name>`. */
const LINK_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/u;
export const t3McpServerName = (name: string) => `t3-${name}`;

/** T3 Code sends the code back in its answer. Nothing listens at this address. */
const REDIRECT_URI = "http://127.0.0.1/tommy-t3-link";
const REQUEST_TIMEOUT_MS = 20_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** The owner gets one notice when this little time is left. */
const NOTICE_BEFORE_MS = 3 * 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 5 * 60 * 1000;

export class T3LinkError extends Schema.TaggedError<T3LinkError>()("T3LinkError", {
  message: Schema.String,
}) {}

const failure = (message: string) => new T3LinkError({ message });

/** The origin of T3 Code. A token goes only over https, or over http to this computer. */
export function t3Origin(address: string): Result.Result<string, T3LinkError> {
  const url = URL.parse(address.trim());
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password)
    return Result.fail(failure("Give the address of T3 Code, such as https://t3.example.com."));
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname))
    return Result.fail(failure("Use an https address. Plain http is only for T3 Code on this computer."));
  return Result.succeed(url.origin);
}

export interface T3SignIn {
  origin: string;
  pairingCode: string;
  access: T3LinkAccess;
  /** The name that T3 Code shows under Authorized clients. */
  clientName: string;
}

export interface T3Token {
  token: string;
  expiresAt: string;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Register, decide with the pairing code, and exchange the code for a token. */
export const signInToT3 = Effect.fn("T3Link.signIn")(function* (input: T3SignIn, fetchImpl: Fetch = fetch) {
  const post = (path: string, body: string, type: string) =>
    Effect.tryPromise({
      try: async () => {
        // A redirect could carry the pairing code or the token to another origin.
        const response = await fetchImpl(`${input.origin}${path}`, {
          method: "POST",
          headers: { "content-type": type, accept: "application/json" },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const text = await response.text();
        let value: unknown = null;
        try {
          value = JSON.parse(text);
        } catch {
          // The status says what failed.
        }
        return { status: response.status, value };
      },
      catch: () => failure(`T3 Code at ${input.origin} does not answer. Check the address and that T3 Code runs.`),
    }).pipe(
      Effect.flatMap(({ status, value }) =>
        status >= 200 && status < 300 && isDynamicRecord(value)
          ? Effect.succeed(value)
          : Effect.fail(failure(`T3 Code refused the link (${path}, HTTP ${status}): ${refusal(value)}`)),
      ),
    );
  const json = (path: string, body: unknown) => post(path, JSON.stringify(body), "application/json");

  const registered = yield* json("/oauth/mcp/register", {
    client_name: input.clientName,
    redirect_uris: [REDIRECT_URI],
  });
  const clientId = registered.client_id;
  if (!isString(clientId)) return yield* failure("T3 Code answered the link in a form this Tommy cannot read.");

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const resource = `${input.origin}/mcp`;
  const decided = yield* json("/oauth/mcp/decision", {
    authorization: {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource,
    },
    decision: { _tag: "pairing-code", access: input.access, code: input.pairingCode },
  });
  const redirect = isString(decided.redirectTo) ? URL.parse(decided.redirectTo) : null;
  if (!redirect) return yield* failure("T3 Code answered the link in a form this Tommy cannot read.");
  const code = redirect.searchParams.get("code");
  if (code === null || redirect.searchParams.get("state") !== state)
    return yield* failure(
      `T3 Code did not approve the link: ${redirect.searchParams.get("error_description") ?? "check the pairing code and make a new one with t3 pair."}`,
    );

  const issued = yield* post(
    "/oauth/mcp/token",
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    }).toString(),
    "application/x-www-form-urlencoded",
  );
  const token = issued.access_token;
  const seconds = issued.expires_in;
  if (!isString(token) || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0)
    return yield* failure("T3 Code answered the link in a form this Tommy cannot read.");
  return { token, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() } satisfies T3Token;
});

/** The reason in a refusal body. T3 Code sends OAuth errors and its own `message` field. */
function refusal(value: unknown): string {
  if (!isDynamicRecord(value)) return "no reason given.";
  for (const key of ["error_description", "message", "error"]) {
    const text = value[key];
    if (isString(text) && text.trim()) return text.trim().slice(0, 300);
  }
  return "no reason given.";
}

export interface T3LinkRecord {
  name: string;
  origin: string;
  access: T3LinkAccess;
  linkedAt: string;
  expiresAt: string;
  /** The `expiresAt` that the owner got a notice for. */
  noticeFor: string | null;
}

export interface T3LinkSummary extends Omit<T3LinkRecord, "noticeFor"> {
  /** The state of its MCP server row: on, off, or removed by someone. */
  mcp: "on" | "off" | "missing";
}

function decodeRecord(value: unknown): T3LinkRecord | null {
  if (!isDynamicRecord(value)) return null;
  const { name, origin, access, linkedAt, expiresAt, noticeFor } = value;
  if (!isString(name) || !LINK_NAME.test(name) || !isString(origin) || Result.isFailure(t3Origin(origin))) return null;
  if (!isString(access) || !isT3LinkAccess(access) || !isString(linkedAt) || !isString(expiresAt)) return null;
  return { name, origin, access, linkedAt, expiresAt, noticeFor: isString(noticeFor) ? noticeFor : null };
}

/** The MCP servers of this Tommy server, as a link changes them. */
export interface T3LinkMcpServers {
  list(): McpServerConfig[];
  save(config: McpServerConfig): Effect.Effect<unknown, unknown>;
  remove(mcpServerId: string): Effect.Effect<unknown, unknown>;
}

export interface T3LinkServiceOptions {
  path: string;
  mcp: T3LinkMcpServers;
  /** The name that T3 Code shows under Authorized clients. */
  clientName: string;
  signIn?: (input: T3SignIn) => Effect.Effect<T3Token, T3LinkError>;
  now?: () => number;
}

export class T3LinkService {
  readonly #options: T3LinkServiceOptions;
  readonly #writes = Semaphore.makeUnsafe(1);
  #links: T3LinkRecord[] = [];
  #first: ReturnType<typeof setTimeout> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: T3LinkServiceOptions) {
    this.#options = options;
  }

  /** A missing or unreadable file reads as no links; the MCP rows stay as they are. */
  load(): Effect.Effect<void, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      const loaded = yield* Effect.result(
        readPreferenceFile(this.#path, (parsed) =>
          isDynamicRecord(parsed) && parsed.version === 1 && Array.isArray(parsed.links)
            ? parsed.links.flatMap((entry) => decodeRecord(entry) ?? [])
            : [],
        ),
      );
      if (Result.isSuccess(loaded)) this.#links = loaded.success;
      else if (!isMissingFileError(loaded.failure.cause) && !(loaded.failure.cause instanceof SyntaxError))
        return yield* loaded.failure;
    });
  }

  get #path() {
    return this.#options.path;
  }

  list(): T3LinkSummary[] {
    const rows = this.#options.mcp.list();
    return this.#links.map(({ noticeFor: _, ...link }) => {
      const row = rows.find((config) => config.name === t3McpServerName(link.name));
      return { ...link, mcp: row ? (row.enabled ? "on" : "off") : "missing" };
    });
  }

  /** Signs in, then adds or replaces the MCP server row `t3-<name>`. Agents get its tools from their next turn. */
  readonly link = Effect.fn("T3LinkService.link")(function* (
    this: T3LinkService,
    input: { name: string; address: string; pairingCode: string; access: T3LinkAccess },
  ) {
    const name = input.name.trim().toLowerCase();
    if (!LINK_NAME.test(name))
      return yield* failure("Give a short name of lowercase letters, digits and dashes, such as mac or vps.");
    const origin = yield* Effect.fromResult(t3Origin(input.address));
    const pairingCode = input.pairingCode.trim();
    if (!pairingCode) return yield* failure("Give the pairing code that t3 pair shows on that computer.");
    const serverName = t3McpServerName(name);
    const existing = this.#options.mcp.list().find((config) => config.name === serverName);
    if (existing && !this.#links.some((link) => link.name === name))
      return yield* failure(`An MCP server named ${serverName} exists and is not a T3 Code link. Use another name.`);

    const signIn = this.#options.signIn ?? ((request: T3SignIn) => signInToT3(request));
    const issued = yield* signIn({ origin, pairingCode, access: input.access, clientName: this.#options.clientName });
    const config: McpServerConfig = {
      id: existing?.id ?? createMcpServerId(),
      name: serverName,
      transport: "http",
      enabled: true,
      command: "",
      args: [],
      env: [],
      envPassthrough: [],
      workingDirectory: "",
      url: `${origin}/mcp`,
      headers: [{ key: "Authorization", value: `Bearer ${issued.token}` }],
    };
    yield* this.#options.mcp
      .save(config)
      .pipe(Effect.mapError(() => failure(`Tommy could not save the MCP server ${serverName}. Read the log.`)));
    const record: T3LinkRecord = {
      name,
      origin,
      access: input.access,
      linkedAt: new Date(this.#now()).toISOString(),
      expiresAt: issued.expiresAt,
      noticeFor: null,
    };
    yield* this.#write([...this.#links.filter((link) => link.name !== name), record]);
    return { ...record, mcpServer: serverName };
  });

  /** Removes the link and its MCP server row. The session stays in T3 Code until it is revoked there. */
  readonly unlink = Effect.fn("T3LinkService.unlink")(function* (this: T3LinkService, name: string) {
    const link = this.#links.find((entry) => entry.name === name.trim().toLowerCase());
    if (!link) return yield* failure(`No T3 Code link is named ${name}.`);
    const row = this.#options.mcp.list().find((config) => config.name === t3McpServerName(link.name));
    if (row)
      yield* this.#options.mcp
        .remove(row.id)
        .pipe(Effect.mapError(() => failure(`Tommy could not remove the MCP server ${row.name}. Read the log.`)));
    yield* this.#write(this.#links.filter((entry) => entry !== link));
    return link;
  });

  /**
   * Checks the links soon after startup, when Telegram can send, and then every six hours. `notify`
   * gets each link that ends in three days or less, once for each token, and returns whether the
   * owner got the notice.
   */
  watch(notify: (link: T3LinkRecord) => Effect.Effect<boolean>): void {
    if (this.#first || this.#timer) return;
    const check = () => void Effect.runPromise(this.check(notify)).catch(() => undefined);
    this.#first = setTimeout(check, FIRST_CHECK_MS);
    this.#first.unref();
    this.#timer = setInterval(check, CHECK_EVERY_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#first) clearTimeout(this.#first);
    if (this.#timer) clearInterval(this.#timer);
    this.#first = null;
    this.#timer = null;
  }

  /** One check of the links, as `watch` runs it. */
  readonly check = Effect.fn("T3LinkService.check")(function* (
    this: T3LinkService,
    notify: (link: T3LinkRecord) => Effect.Effect<boolean>,
  ) {
    const now = this.#now();
    let changed = false;
    const links: T3LinkRecord[] = [];
    for (const link of this.#links) {
      const ends = Date.parse(link.expiresAt);
      if (link.noticeFor !== link.expiresAt && Number.isFinite(ends) && ends - now <= NOTICE_BEFORE_MS) {
        if (yield* notify(link)) {
          links.push({ ...link, noticeFor: link.expiresAt });
          changed = true;
          continue;
        }
      }
      links.push(link);
    }
    if (changed) yield* this.#write(links);
  });

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #write(links: T3LinkRecord[]) {
    return this.#writes
      .withPermit(
        Effect.uninterruptible(
          writePreferenceFile(this.#path, { version: 1, links }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                this.#links = links;
              }),
            ),
          ),
        ),
      )
      .pipe(Effect.mapError(() => failure("Tommy could not save the T3 Code links. Read the log.")));
  }
}
