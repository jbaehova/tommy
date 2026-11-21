import { createHash, randomUUID } from "node:crypto";
import { Effect, Result, Schema, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { readPreferenceFile, writePreferenceFile } from "./preference-file";

const retention = 24 * 60 * 60 * 1_000;
const observationInterval = 60 * 60 * 1_000;
const accountId = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 ** 52 - 1 }));
const nonnegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const username = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_]{1,32}$/));
const displayName = Schema.String.check(Schema.isBetweenLength(1, 256));
const agentKey = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
const connection = Schema.Struct({
  id: accountId,
  username,
  name: displayName,
  agentId: Schema.NullOr(agentKey),
  operationId: Schema.String.check(Schema.isUUID(4)),
  verified: Schema.Boolean,
  ownerConfirmed: Schema.optionalKey(Schema.Boolean),
});
export type TelegramConnection = typeof connection.Type;
const change = Schema.Struct({ updateId: nonnegative, time: nonnegative });
type ManagementChange = typeof change.Type;
const file = Schema.Struct({
  version: Schema.Literal(1),
  managerId: accountId,
  ownerId: accountId,
  managerObservedAt: Schema.optionalKey(nonnegative),
  /** The root agent, which answers the owner in the manager's own chat. A new choice gets a new operation. */
  managerAgent: Schema.optionalKey(
    Schema.Struct({ agentId: agentKey, operationId: Schema.String.check(Schema.isUUID(4)) }),
  ),
  entries: Schema.Array(Schema.Struct({ connection, change })),
  revoked: Schema.Array(Schema.Struct({ id: accountId, change })),
  foreignChange: Schema.NullOr(change),
  receipts: Schema.Array(
    Schema.Struct({
      id: accountId,
      digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      time: nonnegative,
    }),
  ),
});
type DirectoryFile = typeof file.Type;
const decodeFile = Schema.decodeUnknownSync(file, { onExcessProperty: "error" });
const validAccount = Schema.is(accountId);
const validSequence = Schema.is(nonnegative);
const validUsername = Schema.is(username);
const validName = Schema.is(displayName);
const validAgent = Schema.is(agentKey);

export class TelegramDirectoryError extends Schema.TaggedError<TelegramDirectoryError>()("TelegramDirectoryError", {
  code: Schema.Literals(["unavailable", "invalid", "identity", "stale", "write"]),
}) {}

/** The owner can chat with a bot as soon as its creation is confirmed and it has an agent. */
export function chatReady(entry: TelegramConnection | undefined): entry is TelegramConnection & { agentId: string } {
  return entry?.ownerConfirmed === true && entry.agentId !== null;
}

function receiptDigest(value: string | number): string {
  // A reply marker cannot put a message, path, or provider identifier in the directory.
  return createHash("sha256")
    .update(`${typeof value}:${value}`)
    .digest("hex");
}

function recent(mark: ManagementChange | null | undefined): mark is ManagementChange {
  return mark != null && mark.time > Date.now() - retention;
}

function currentTime(time: number | undefined, now: number): boolean {
  return time !== undefined && time <= now && now - time < retention;
}

type DirectoryEntry = DirectoryFile["entries"][number];

function ownershipCurrent(state: DirectoryFile, entry: DirectoryEntry, now: number): boolean {
  return (
    entry.connection.ownerConfirmed !== false &&
    (currentTime(state.managerObservedAt, now) || currentTime(entry.change.time, now))
  );
}

function publicConnection(state: DirectoryFile, entry: DirectoryEntry, now: number): TelegramConnection {
  const ownerConfirmed = ownershipCurrent(state, entry, now);
  return { ...entry.connection, ownerConfirmed, verified: ownerConfirmed && entry.connection.verified };
}

function validDirectory(state: DirectoryFile): boolean {
  const ids = [...state.entries.map((entry) => entry.connection.id), ...state.revoked.map((entry) => entry.id)];
  const operations = state.entries.map(({ connection }) => connection.operationId);
  const agents = state.entries.flatMap(({ connection }) => (connection.agentId === null ? [] : [connection.agentId]));
  return (
    !ids.includes(state.managerId) &&
    !ids.includes(state.ownerId) &&
    new Set(ids).size === ids.length &&
    new Set(operations).size === operations.length &&
    new Set(agents).size === agents.length
  );
}

interface DirectoryChange<A> {
  state: DirectoryFile;
  value: A;
}

/** The service has one writer. A failed load leaves all routes closed and the existing file intact. */
export class TelegramDirectory {
  readonly #writes = Semaphore.makeUnsafe(1);
  #state: DirectoryFile | null = null;

  constructor(
    private readonly path: string,
    private readonly managerId: number,
    private readonly ownerId: number,
  ) {}

  readonly load = Effect.fn("TelegramDirectory.load")(function* (this: TelegramDirectory) {
    yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        this.#state = null;
        if (!validAccount(this.managerId) || !validAccount(this.ownerId) || this.managerId === this.ownerId) {
          return yield* new TelegramDirectoryError({ code: "identity" });
        }
        const result = yield* Effect.result(readPreferenceFile(this.path, decodeFile));
        if (Result.isFailure(result)) {
          if (!isMissingFileError(result.failure.cause)) return yield* new TelegramDirectoryError({ code: "invalid" });
          this.#state = {
            version: 1,
            managerId: this.managerId,
            ownerId: this.ownerId,
            entries: [],
            revoked: [],
            foreignChange: null,
            receipts: [],
          };
          return;
        }
        const state = result.success;
        if (state.managerId !== this.managerId || state.ownerId !== this.ownerId) {
          return yield* new TelegramDirectoryError({ code: "identity" });
        }
        if (!validDirectory(state)) return yield* new TelegramDirectoryError({ code: "invalid" });
        this.#state = state;
      }),
    );
  }).bind(this);

  list(): readonly TelegramConnection[] {
    const state = this.#state;
    const now = Date.now();
    return state?.entries.map((entry) => publicConnection(state, entry, now)) ?? [];
  }

  get(id: number): TelegramConnection | undefined {
    const state = this.#state;
    const entry = state?.entries.find(({ connection }) => connection.id === id);
    return state && entry ? publicConnection(state, entry, Date.now()) : undefined;
  }

  managerAgent(): { agentId: string; operationId: string } | null {
    const binding = this.#state?.managerAgent;
    return binding ? { ...binding } : null;
  }

  /** Only an authenticated owner message to the manager may enter here. The root has no agent bot. */
  setManagerAgent(agentId: string) {
    return this.#change((state) => {
      if (!validAgent(agentId) || state.entries.some((entry) => entry.connection.agentId === agentId))
        throw new TelegramDirectoryError({ code: "invalid" });
      if (state.managerAgent?.agentId === agentId) return { state, value: undefined };
      return { state: { ...state, managerAgent: { agentId, operationId: randomUUID() } }, value: undefined };
    });
  }

  /**
   * Call only when Telegram reports that the expected manager webhook accepts managed_bot updates
   * and has drained its queue. After an outage, the empty queue can have lost transfer notices.
   * Freeze expired grants before advancing this timestamp. A later check can never renew them.
   */
  observeManager() {
    return this.#change((state) => {
      const now = Date.now();
      if (currentTime(state.managerObservedAt, now) && now - (state.managerObservedAt ?? 0) < observationInterval)
        return { state, value: undefined };
      const entries = state.entries.map((entry) =>
        ownershipCurrent(state, entry, now)
          ? entry
          : { ...entry, connection: { ...entry.connection, verified: false, ownerConfirmed: false } },
      );
      return { state: { ...state, managerObservedAt: now, entries }, value: undefined };
    });
  }

  /** Only an authenticated manager update naming this owner may enter here. Replaying it preserves verification. */
  ensureManaged(input: { id: number; username: string; first_name: string }, updateId: number) {
    return this.#change<TelegramConnection | null>((state) => {
      if (
        !this.#validManagement(input.id, updateId) ||
        !validUsername(input.username) ||
        !validName(input.first_name)
      ) {
        throw new TelegramDirectoryError({ code: "invalid" });
      }
      const previous = state.entries.find((entry) => entry.connection.id === input.id);
      const lastChange = previous?.change ?? state.revoked.find((entry) => entry.id === input.id)?.change;
      if (previous?.change.updateId === updateId) {
        const replay = publicConnection(state, previous, Date.now());
        return { state, value: replay.ownerConfirmed ? replay : null };
      }
      if (recent(lastChange) && updateId <= lastChange.updateId) return { state, value: null };
      if (!previous && recent(state.foreignChange) && updateId <= state.foreignChange.updateId) {
        return { state, value: null };
      }
      const next: TelegramConnection = {
        id: input.id,
        username: input.username,
        name: input.first_name,
        agentId: previous?.connection.agentId ?? null,
        operationId: previous?.connection.operationId ?? randomUUID(),
        verified: false,
        ownerConfirmed: true,
      };
      const entries = state.entries.filter((entry) => entry.connection.id !== input.id);
      return {
        state: {
          ...state,
          entries: [...entries, { connection: next, change: { updateId, time: Date.now() } }],
          revoked: state.revoked.filter((entry) => entry.id !== input.id),
        },
        value: { ...next },
      };
    });
  }

  /** An owner transfer discards the agent mapping. A new grant cannot reuse the old profile operation. */
  revoke(id: number, updateId: number, operationId?: string) {
    return this.#change((state) => {
      if (!this.#validManagement(id, updateId)) throw new TelegramDirectoryError({ code: "invalid" });
      const previous = state.entries.find((entry) => entry.connection.id === id);
      if (operationId !== undefined && previous?.connection.operationId !== operationId)
        throw new TelegramDirectoryError({ code: "stale" });
      const lastChange = previous?.change ?? state.revoked.find((entry) => entry.id === id)?.change;
      const mark = { updateId, time: Date.now() };
      if (recent(lastChange) && updateId <= lastChange.updateId) return { state, value: undefined };
      if (!lastChange) {
        // One cursor bounds storage when other Telegram users create accounts through this manager.
        const foreignChange = state.foreignChange;
        if (recent(foreignChange) && updateId <= foreignChange.updateId) return { state, value: undefined };
        return { state: { ...state, foreignChange: mark }, value: undefined };
      }
      return {
        state: {
          ...state,
          entries: state.entries.filter((entry) => entry.connection.id !== id),
          revoked: [...state.revoked.filter((entry) => entry.id !== id), { id, change: mark }],
        },
        value: undefined,
      };
    });
  }

  #validManagement(id: number, updateId: number): boolean {
    return validAccount(id) && id !== this.ownerId && id !== this.managerId && validSequence(updateId);
  }

  setDisplayName(id: number, name: string, operationId: string) {
    return this.#edit(id, operationId, (current) => {
      if (!chatReady(current) || !validName(name)) throw new TelegramDirectoryError({ code: "stale" });
      return current.name === name ? current : { ...current, name };
    });
  }

  bindAgent(id: number, agentId: string, operationId?: string) {
    return this.#edit(id, operationId, (current, state) => {
      if (!current.ownerConfirmed) throw new TelegramDirectoryError({ code: "stale" });
      if (!validAgent(agentId)) throw new TelegramDirectoryError({ code: "invalid" });
      if (current.agentId === agentId) return current;
      if (
        current.agentId !== null ||
        state.managerAgent?.agentId === agentId ||
        state.entries.some((entry) => entry.connection.agentId === agentId)
      ) {
        throw new TelegramDirectoryError({ code: "stale" });
      }
      return { ...current, agentId };
    });
  }

  #edit(
    id: number,
    operationId: string | undefined,
    edit: (current: TelegramConnection, state: DirectoryFile) => TelegramConnection,
  ) {
    return this.#change((state) => {
      const entry = state.entries.find(({ connection }) => connection.id === id);
      if (!entry || (operationId !== undefined && entry.connection.operationId !== operationId)) {
        throw new TelegramDirectoryError({ code: "stale" });
      }
      const current = publicConnection(state, entry, Date.now());
      const updated = edit(current, state);
      const next =
        updated === current
          ? state
          : {
              ...state,
              entries: state.entries.map((other) => (other === entry ? { ...entry, connection: updated } : other)),
            };
      return { state: next, value: undefined };
    });
  }

  seen(id: number, key: number | string): boolean {
    const digest = receiptDigest(key);
    const cutoff = Date.now() - retention;
    return (
      this.#state?.receipts.some((mark) => mark.id === id && mark.digest === digest && mark.time > cutoff) ?? false
    );
  }

  markSeen(id: number, key: number | string) {
    return this.#change((state) => {
      if (id !== this.managerId && !state.entries.some((entry) => entry.connection.id === id)) {
        throw new TelegramDirectoryError({ code: "stale" });
      }
      if (typeof key === "number" ? !validSequence(key) : !key || key.length > 512) {
        throw new TelegramDirectoryError({ code: "invalid" });
      }
      if (this.seen(id, key)) return { state, value: undefined };
      return {
        state: { ...state, receipts: [...state.receipts, { id, digest: receiptDigest(key), time: Date.now() }] },
        value: undefined,
      };
    });
  }

  #change<A>(make: (previous: DirectoryFile) => DirectoryChange<A>): Effect.Effect<A, TelegramDirectoryError> {
    return this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        const current = this.#state;
        if (!current) return yield* new TelegramDirectoryError({ code: "unavailable" });
        const { state, value } = yield* Effect.try({
          try: () => make(current),
          catch: (cause) =>
            cause instanceof TelegramDirectoryError ? cause : new TelegramDirectoryError({ code: "invalid" }),
        });
        if (state !== current) {
          const cutoff = Date.now() - retention;
          const next = {
            ...state,
            revoked: state.revoked.filter(({ change }) => change.time > cutoff),
            receipts: state.receipts.filter((entry) => entry.time > cutoff),
          };
          yield* writePreferenceFile(this.path, next, { createDirectory: true }).pipe(
            Effect.mapError(() => new TelegramDirectoryError({ code: "write" })),
          );
          this.#state = next;
        }
        return value;
      }).pipe(Effect.uninterruptible),
    );
  }
}
