import { Effect } from "effect";
import type { AgentClient } from "../agent-client";

/** How many disposable generations may run at once. */
const PROFILE_CLIENT_LIMIT = 3;

/**
 * Owns every disposable client that is generating, with the record that ends its generation: a
 * profile draft, and a channel lead's text. A client alone is not enough to stop the work: it may
 * not hold a process yet.
 *
 * It never imports the agent service facade.
 */
export class ProfileClients {
  readonly #clients = new Map<AgentClient, { cancelled: boolean }>();

  /** Whether a new profile generation must wait. */
  busy(): boolean {
    return this.#clients.size >= PROFILE_CLIENT_LIMIT;
  }

  /** Whether a background generation may start: it always leaves one slot for the user's own. */
  hasSpare(): boolean {
    return this.#clients.size < PROFILE_CLIENT_LIMIT - 1;
  }

  usesProvider(provider: AgentClient["provider"]): boolean {
    return [...this.#clients.keys()].some((client) => client.provider === provider);
  }

  /** Runs one generation on `client`, and forgets the client when it ends. */
  run<A, E, R>(
    client: AgentClient,
    generate: (cancelled: () => boolean) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> {
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const generation = { cancelled: false };
        this.#clients.set(client, generation);
        return generation;
      }),
      (generation) => generate(() => generation.cancelled),
      () =>
        Effect.sync(() => {
          this.#clients.delete(client);
        }),
    );
  }

  /** Reserves a background slot atomically and leaves one slot for direct user work. */
  runIfSpare<A, E, E2, R>(
    client: AgentClient,
    generate: (cancelled: () => boolean) => Effect.Effect<A, E, R>,
    busyError: E2,
  ): Effect.Effect<A, E | E2, R> {
    return Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (!this.hasSpare()) return Effect.fail(busyError);
        const generation = { cancelled: false };
        this.#clients.set(client, generation);
        return Effect.succeed(generation);
      }),
      (generation) => generate(() => generation.cancelled),
      () =>
        Effect.sync(() => {
          this.#clients.delete(client);
        }),
    );
  }

  /** Every client, forgotten, for the caller to stop at shutdown. */
  release(): AgentClient[] {
    const clients = [...this.#clients.keys()];
    this.#clients.clear();
    return clients;
  }
}
