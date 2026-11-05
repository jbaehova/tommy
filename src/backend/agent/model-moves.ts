import type { AgentModelOption, AgentSummary, UpdateAgentInput } from "@tommy/contracts/ipc";
import { defaultProviderModel } from "@tommy/contracts/ipc";
import { Effect, Schema, Semaphore } from "effect";
import type { AgentProvider } from "../agent-client";
import type { AgentStore } from "../agent-store";
import { causeHelpers } from "../effect-boundary";
import type { ProviderRuntime } from "./provider-runtime";
import { providerForAgent } from "./thread-items";

export interface ModelMovesOptions {
  store: AgentStore;
  providers: ProviderRuntime;
  /** The facade's agent update without the chain: every caller here already holds it. */
  applyAgentUpdate(input: UpdateAgentInput): Effect.Effect<AgentSummary, ModelMoveFailed>;
  emitError(code: string, error: unknown, agentId?: string): void;
}

/**
 * The models every caller may choose from, the chain that runs one agent update at a time, and the
 * move of agents off models that a provider no longer lists.
 */
export class ModelMoves {
  readonly #store: AgentStore;
  readonly #providers: ProviderRuntime;
  readonly #options: ModelMovesOptions;
  readonly #chain = Semaphore.makeUnsafe(1);

  constructor(options: ModelMovesOptions) {
    this.#store = options.store;
    this.#providers = options.providers;
    this.#options = options;
  }

  available(): AgentModelOption[] {
    return this.#providers.listModels();
  }

  /** A failed change does not stop the next one, so the chain swallows what it re-throws here. */
  runExclusive<T, E>(run: () => Effect.Effect<T, E>): Effect.Effect<T, E> {
    return this.#chain.withPermit(Effect.suspend(run));
  }

  /**
   * Moves each agent of `provider` whose model the provider no longer lists to the provider's default,
   * or to the first model it lists when the default is gone too.
   *
   * Only called with a catalogue the provider has just reported, because a stale one is no proof that
   * a model is gone. The provider stays the same, so the agent keeps its thread, and a running turn
   * keeps the model it started with. An empty catalogue moves nobody: that is a provider with no
   * usable account, not a provider with no models.
   */
  readonly moveAgentsOffUnlistedModels = Effect.fn("ModelMoves.moveAgentsOffUnlistedModels")(function* (
    this: ModelMoves,
    provider: AgentProvider,
  ) {
    const models = this.available().filter((model) => model.provider === provider);
    const fallback = models.find((model) => model.id === defaultProviderModel(provider)) ?? models[0];
    if (!fallback) return;
    const affected = this.#store
      .list()
      .filter((agent) => providerForAgent(agent) === provider && !models.some((model) => model.id === agent.model));
    for (const agent of affected) {
      yield* this.#options
        .applyAgentUpdate({
          agentId: agent.id,
          model: fallback.id,
          reasoningEffort: fallback.defaultReasoningEffort,
        })
        .pipe(
          Effect.catch((failure) =>
            Effect.sync(() => this.#options.emitError("agent_model_fallback_failed", failure.cause, agent.id)),
          ),
        );
    }
  }, Effect.uninterruptible).bind(this);
}

export class ModelMoveFailed extends Schema.TaggedError<ModelMoveFailed>()("ModelMoveFailed", {
  cause: Schema.Defect(),
}) {}

export const { rewrap: toModelMoveFailed } = causeHelpers(ModelMoveFailed);
