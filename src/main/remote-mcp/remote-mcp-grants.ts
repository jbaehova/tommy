import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Effect, Result, Schema, Semaphore } from "effect";
import { isMissingFileError } from "../../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "../preference-file";

/** An access token lasts one hour. The client gets a new one with its refresh token. */
const REMOTE_MCP_ACCESS_SECONDS = 60 * 60;
/** A refresh token lasts 30 days and is replaced at each use. */
const REMOTE_MCP_REFRESH_SECONDS = 30 * 24 * 60 * 60;
/** How long a replaced refresh token still works, for a client that did not get the answer. */
const REFRESH_RETRY_MS = 60_000;
/** Registered clients without a grant are removed, oldest first, above this count. */
const MAX_CLIENTS = 20;
/** Sign-ins beyond this count remove the oldest grant. */
const MAX_GRANTS = 10;

const StoredClient = Schema.Struct({
  id: Schema.String,
  /** The SHA-256 of the client secret, or null for a public client. */
  secretHash: Schema.NullOr(Schema.String),
  redirectUris: Schema.Array(Schema.String),
  name: Schema.String,
  createdAt: Schema.String,
});
type StoredClient = typeof StoredClient.Type;

const StoredGrant = Schema.Struct({
  id: Schema.String,
  clientId: Schema.String,
  accessHash: Schema.String,
  accessExpiresAt: Schema.Number,
  refreshHash: Schema.String,
  refreshExpiresAt: Schema.Number,
  /** The refresh token that this one replaced. Its use again means a copy leaked: the grant ends. */
  previousRefreshHash: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  refreshedAt: Schema.String,
});
type StoredGrant = typeof StoredGrant.Type;

const StoredFile = Schema.Struct({
  version: Schema.Literal(1),
  clients: Schema.Array(StoredClient),
  grants: Schema.Array(StoredGrant),
});
type StoredFile = typeof StoredFile.Type;
const decodeFile = Schema.decodeUnknownSync(StoredFile);

export interface RemoteMcpClient {
  id: string;
  name: string;
  redirectUris: readonly string[];
  confidential: boolean;
}

export interface RemoteMcpTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface RemoteMcpGrantSummary {
  id: string;
  client: string;
  createdAt: string;
  refreshedAt: string;
  expiresAt: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function token(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function publicClient(client: StoredClient): RemoteMcpClient {
  return {
    id: client.id,
    name: client.name,
    redirectUris: client.redirectUris,
    confidential: client.secretHash !== null,
  };
}

/**
 * Owns the registered clients and the sign-ins (grants) of the remote MCP endpoint. The file holds
 * only SHA-256 hashes of tokens and client secrets, so a copy of it signs nothing in. Writes are
 * chained, and each one starts from the state that the one before it saved.
 */
export class RemoteMcpGrants {
  readonly #path: string;
  readonly #now: () => number;
  readonly #writes = Semaphore.makeUnsafe(1);
  #state: StoredFile = { version: 1, clients: [], grants: [] };

  constructor(options: { path: string; now?: () => number }) {
    this.#path = options.path;
    this.#now = options.now ?? Date.now;
  }

  readonly load = Effect.fn("RemoteMcpGrants.load")(function* (this: RemoteMcpGrants) {
    const loaded = yield* Effect.result(readPreferenceFile(this.#path, decodeFile));
    if (Result.isSuccess(loaded)) this.#state = loaded.success;
    else if (!isMissingFileError(loaded.failure.cause)) return yield* loaded.failure;
  }).bind(this);

  /** Applies `change` to the saved state and saves the result. Nothing changes when the write fails. */
  #commit<A>(change: (state: StoredFile) => { state: StoredFile; value: A }): Effect.Effect<A, PreferenceFileFailure> {
    return this.#writes.withPermit(
      Effect.uninterruptible(
        Effect.gen({ self: this }, function* () {
          const next = change(this.#state);
          if (next.state !== this.#state) {
            yield* writePreferenceFile(this.#path, next.state);
            this.#state = next.state;
          }
          return next.value;
        }),
      ),
    );
  }

  client(id: string): RemoteMcpClient | null {
    const client = this.#state.clients.find((entry) => entry.id === id);
    return client ? publicClient(client) : null;
  }

  /** True when the client has no secret, or `secret` is its secret. */
  clientSecretMatches(id: string, secret: string | null): boolean {
    const client = this.#state.clients.find((entry) => entry.id === id);
    if (!client) return false;
    if (client.secretHash === null) return secret === null;
    return secret !== null && sameHash(hash(secret), client.secretHash);
  }

  readonly register = Effect.fn("RemoteMcpGrants.register")(function* (
    this: RemoteMcpGrants,
    input: { name: string; redirectUris: readonly string[]; confidential: boolean },
  ) {
    const secret = input.confidential ? token("tmcs") : null;
    const client: StoredClient = {
      id: `tmc_${randomBytes(16).toString("base64url")}`,
      secretHash: secret === null ? null : hash(secret),
      redirectUris: [...input.redirectUris],
      name: input.name,
      createdAt: new Date(this.#now()).toISOString(),
    };
    yield* this.#commit((state) => {
      const used = new Set(state.grants.map((grant) => grant.clientId));
      const clients = [...state.clients, client];
      // The oldest clients that no grant uses make room. A client with a grant stays.
      while (clients.length > MAX_CLIENTS) {
        const index = clients.findIndex((entry) => !used.has(entry.id) && entry.id !== client.id);
        if (index < 0) break;
        clients.splice(index, 1);
      }
      return { state: { ...state, clients }, value: undefined };
    });
    return { client: publicClient(client), secret };
  }).bind(this);

  /** A new grant after the owner approved a sign-in. */
  readonly grant = Effect.fn("RemoteMcpGrants.grant")(function* (this: RemoteMcpGrants, clientId: string) {
    const now = this.#now();
    const tokens: RemoteMcpTokens = {
      accessToken: token("tma"),
      refreshToken: token("tmr"),
      expiresIn: REMOTE_MCP_ACCESS_SECONDS,
    };
    const grant: StoredGrant = {
      id: randomBytes(6).toString("hex"),
      clientId,
      accessHash: hash(tokens.accessToken),
      accessExpiresAt: now + REMOTE_MCP_ACCESS_SECONDS * 1000,
      refreshHash: hash(tokens.refreshToken),
      refreshExpiresAt: now + REMOTE_MCP_REFRESH_SECONDS * 1000,
      previousRefreshHash: null,
      createdAt: new Date(now).toISOString(),
      refreshedAt: new Date(now).toISOString(),
    };
    yield* this.#commit((state) => {
      const live = state.grants.filter((entry) => entry.refreshExpiresAt > now);
      return { state: { ...state, grants: [...live, grant].slice(-MAX_GRANTS) }, value: undefined };
    });
    return tokens;
  }).bind(this);

  /**
   * New tokens for a refresh token of this client. A replaced refresh token that comes again after
   * a short retry window ends its grant: only a copy of it can be used that late.
   */
  readonly refresh = Effect.fn("RemoteMcpGrants.refresh")(function* (
    this: RemoteMcpGrants,
    clientId: string,
    refreshToken: string,
  ) {
    const now = this.#now();
    const presented = hash(refreshToken);
    const tokens: RemoteMcpTokens = {
      accessToken: token("tma"),
      refreshToken: token("tmr"),
      expiresIn: REMOTE_MCP_ACCESS_SECONDS,
    };
    return yield* this.#commit((state): { state: StoredFile; value: RemoteMcpTokens | null } => {
      const previous = state.grants.find(
        (grant) => grant.previousRefreshHash !== null && sameHash(grant.previousRefreshHash, presented),
      );
      // A client whose answer was lost sends the replaced token again at once, and gets new tokens.
      // Later, only a copy can still hold that token: the grant ends.
      const retry = previous !== undefined && now - Date.parse(previous.refreshedAt) < REFRESH_RETRY_MS;
      if (previous && !retry)
        return { state: { ...state, grants: state.grants.filter((grant) => grant !== previous) }, value: null };
      const current =
        previous ?? state.grants.find((grant) => grant.clientId === clientId && sameHash(grant.refreshHash, presented));
      if (!current || current.clientId !== clientId || current.refreshExpiresAt <= now) return { state, value: null };
      const next: StoredGrant = {
        ...current,
        accessHash: hash(tokens.accessToken),
        accessExpiresAt: now + REMOTE_MCP_ACCESS_SECONDS * 1000,
        refreshHash: hash(tokens.refreshToken),
        refreshExpiresAt: now + REMOTE_MCP_REFRESH_SECONDS * 1000,
        // A retry keeps the replaced token and its time, so repeated retries cannot extend the window.
        ...(retry ? {} : { previousRefreshHash: current.refreshHash, refreshedAt: new Date(now).toISOString() }),
      };
      return {
        state: { ...state, grants: state.grants.map((grant) => (grant === current ? next : grant)) },
        value: tokens,
      };
    });
  }).bind(this);

  /** The grant of a valid access token, or null. */
  authenticate(accessToken: string): { grantId: string; clientId: string } | null {
    if (accessToken.length > 512) return null;
    const presented = hash(accessToken);
    const now = this.#now();
    const grant = this.#state.grants.find(
      (entry) => sameHash(entry.accessHash, presented) && entry.accessExpiresAt > now,
    );
    return grant ? { grantId: grant.id, clientId: grant.clientId } : null;
  }

  /** Ends the grant of an access or refresh token. An unknown token is not an error (RFC 7009). */
  readonly revokeToken = Effect.fn("RemoteMcpGrants.revokeToken")(function* (this: RemoteMcpGrants, value: string) {
    const presented = hash(value);
    yield* this.#commit((state) => {
      const grants = state.grants.filter(
        (grant) => !sameHash(grant.accessHash, presented) && !sameHash(grant.refreshHash, presented),
      );
      return { state: grants.length === state.grants.length ? state : { ...state, grants }, value: undefined };
    });
  }).bind(this);

  /** Ends one grant by id, or all of them. Returns the count that ended. */
  readonly revoke = Effect.fn("RemoteMcpGrants.revoke")(function* (this: RemoteMcpGrants, id: string | "all") {
    return yield* this.#commit((state) => {
      const grants = id === "all" ? [] : state.grants.filter((grant) => grant.id !== id);
      const count = state.grants.length - grants.length;
      return { state: count === 0 ? state : { ...state, grants }, value: count };
    });
  }).bind(this);

  list(): RemoteMcpGrantSummary[] {
    const now = this.#now();
    return this.#state.grants
      .filter((grant) => grant.refreshExpiresAt > now)
      .map((grant) => ({
        id: grant.id,
        client: this.#state.clients.find((client) => client.id === grant.clientId)?.name ?? grant.clientId,
        createdAt: grant.createdAt,
        refreshedAt: grant.refreshedAt,
        expiresAt: new Date(grant.refreshExpiresAt).toISOString(),
      }));
  }
}
