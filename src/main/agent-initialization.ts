import { Deferred, Effect, Exit } from "effect";

export class AgentInitializationGate<E> {
  readonly #initialize: () => Effect.Effect<void, E>;
  #pending: Deferred.Deferred<void, E> | null = null;
  #settled = false;
  #closed = false;

  constructor(initialize: () => Effect.Effect<void, E>) {
    this.#initialize = initialize;
  }

  /** True only after initialization succeeds, never before start or after failure. */
  get succeeded(): boolean {
    return !this.#closed && this.#settled && this.#pending !== null;
  }

  readonly start = Effect.fn("AgentInitializationGate.start")(function* (this: AgentInitializationGate<E>) {
    if (this.#closed) return;
    if (this.#pending) return yield* Deferred.await(this.#pending);
    const completion = Deferred.makeUnsafe<void, E>();
    this.#pending = completion;
    this.#settled = false;
    // Migrations must settle before shutdown can close the database.
    const exit = yield* Effect.exit(Effect.suspend(this.#initialize));
    this.#settled = true;
    if (Exit.isFailure(exit)) this.#pending = null;
    yield* Deferred.done(completion, exit);
    return yield* Deferred.await(completion);
  }, Effect.uninterruptible).bind(this);
  /** Block new starts and join the current operation before its services close. */
  readonly stop = Effect.fn("AgentInitializationGate.stop")(function* (this: AgentInitializationGate<E>) {
    this.#closed = true;
    if (this.#pending) yield* Effect.exit(Deferred.await(this.#pending));
  }, Effect.uninterruptible).bind(this);
}
