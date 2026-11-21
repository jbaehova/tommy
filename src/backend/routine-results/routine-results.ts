import type { AgentEvent } from "@tommy/contracts/ipc";
import { createTommyLogger } from "@tommy/logging";
import { Context, Effect, Exit, Fiber, Layer, ManagedRuntime, Scope } from "effect";
import { isNoUpdateAnswer } from "../agent/routine-quiet-runs";
import { coalescedPasses } from "../coalesced-passes";
import type { RoutineResultStore } from "./routine-result-store";

const logger = createTommyLogger("routine-results");
const SWEEP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const STORAGE_RETRY_MS = 60_000;

interface RoutineResultsDependencies {
  store: RoutineResultStore;
  delivery(deliveryId: string): { turnId: string | null } | null;
  turnAnswer(agentId: string, turnId: string): string | null;
  now?: () => Date;
}

interface RoutineResultsShape {
  recover(): Effect.Effect<void>;
  notice(event: AgentEvent): Effect.Effect<void>;
}

/** Records answers and reconciles unfinished local history for retired messaging destinations. */
class RoutineResults extends Context.Service<RoutineResults, RoutineResultsShape>()("tommy/backend/RoutineResults") {
  static layer({ store, delivery, turnAnswer, now = () => new Date() }: RoutineResultsDependencies) {
    return Layer.effect(
      RoutineResults,
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        let timer: Fiber.Fiber<void> | null = null;
        const reconcile = () => {
          const at = now();
          const since = new Date(at.getTime() - SWEEP_WINDOW_MS).toISOString();
          for (const run of store.runsWithoutDelivery(since)) {
            const turnId = run.deliveryId ? delivery(run.deliveryId)?.turnId : null;
            const answer = turnId ? turnAnswer(run.agentId, turnId) : null;
            store.createDelivery(
              run,
              answer && !isNoUpdateAnswer(answer) ? resultText(run.routineName, answer) : null,
              at,
            );
          }
          store.finishDue(at.toISOString());
          const next = store.nextAttemptAt();
          return next === null ? null : Math.max(0, Date.parse(next) - now().getTime());
        };

        const sweep: () => Effect.Effect<void> = coalescedPasses(() =>
          Effect.gen(function* () {
            const delay = yield* Effect.sync(reconcile).pipe(
              Effect.catchCause(() =>
                Effect.sync(() => {
                  logger.warn("Could not reconcile routine result history.");
                  return STORAGE_RETRY_MS;
                }),
              ),
            );
            if (timer) yield* Fiber.interrupt(timer);
            timer =
              delay === null
                ? null
                : yield* Effect.forkIn(
                    Effect.sleep(delay).pipe(
                      Effect.andThen(() => {
                        timer = null;
                        return sweep();
                      }),
                    ),
                    scope,
                  );
          }),
        );

        return RoutineResults.of({
          recover: Effect.fn("RoutineResults.recover")(function* () {
            yield* Effect.sync(() => store.interruptSending(now().toISOString())).pipe(
              Effect.catchCause(() => Effect.sync(() => logger.warn("Could not mark interrupted routine results."))),
            );
            yield* Effect.forkIn(sweep(), scope);
          }),
          notice: Effect.fn("RoutineResults.notice")(function* (event: AgentEvent) {
            if (event.type === "turn-completed" || event.type === "queue-changed" || event.type === "routines-changed")
              yield* Effect.forkIn(sweep(), scope);
          }),
        });
      }),
    );
  }
}

export const createRoutineResults = Effect.fn("createRoutineResults")(function* (
  dependencies: RoutineResultsDependencies,
) {
  const runtime = ManagedRuntime.make(RoutineResults.layer(dependencies));
  const context = yield* runtime.contextEffect.pipe(
    Effect.onExit((exit) => (Exit.isFailure(exit) ? runtime.disposeEffect : Effect.void)),
  );
  return { ...Context.get(context, RoutineResults), close: () => runtime.disposeEffect };
});

/** The routine or workflow name above its answer. Stored copies keep this format. */
export function resultText(routineName: string, answer: string): string {
  return `**${routineName}**\n\n${answer}`;
}
