import { Deferred, Effect } from "effect";

export interface RemoteTeamHost {
  hostId: string;
  name: string;
  logoKey: string | null;
  devicePublicKey: string;
  membershipId: string;
  role: "owner" | "admin" | "member";
  /** The active members that the host's plan allows. An account server from before plans sends none. */
  memberLimit?: number;
  /**
   * A hosted server with a plan: its owner and its admins can restart it. An older account server sends none.
   */
  hosted?: boolean;
  /**
   * When the host last changed its key, from a handover that both keys signed. Absent when the host
   * kept its first key or the account service sends no handovers.
   */
  keyChangedAt?: number;
}

export const REMOTE_ACCOUNT_CHECK_INTERVAL_MS = 15 * 60_000;

/** Refresh on demand or foreground entry; coalesce requests and rate-limit automatic retries. */
export function createRemoteDirectoryRefresh<E, R>(load: () => Effect.Effect<void, E, R>, now = Date.now) {
  let pending: Deferred.Deferred<void, E> | null = null;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  const refresh = Effect.fn("RemoteDirectory.refresh")(function* (force = false) {
    if (pending) return yield* Deferred.await(pending);
    if (!force && now() - lastAttempt < REMOTE_ACCOUNT_CHECK_INTERVAL_MS) return;
    lastAttempt = now();
    const operation = Deferred.makeUnsafe<void, E>();
    pending = operation;
    return yield* load().pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          yield* Deferred.done(operation, exit);
          if (pending === operation) pending = null;
        }),
      ),
    );
  });
  return {
    refresh,
    invalidate(): void {
      pending = null;
      lastAttempt = Number.NEGATIVE_INFINITY;
    },
  };
}
