import { agentProviderDescriptor } from "@tommy/contracts/agent-providers";
import type { AgentModelOption, AgentSummary } from "@tommy/contracts/ipc";
import { sourceText } from "@tommy/i18n/source";
import { createTommyLogger } from "@tommy/logging";
import { Effect } from "effect";
import type { AgentClient } from "../agent-client";
import type { ProfileClients } from "./profile-clients";
import { type GenerationObserver, GenerationUsageLimitError, generateTextWithoutTools } from "./profile-generation";
import { providerNeedsWebSearch } from "./tool-catalog";
import { ToolOperationFailed } from "./tool-operation";

const logger = createTommyLogger("web-search");

export interface WebSearchOptions {
  profileClients: ProfileClients;
  agent(agentId: string): AgentSummary | undefined;
  /** Checks the enabled Codex sign-in and returns its actual model catalog. Never enables it. */
  ready(): Effect.Effect<readonly AgentModelOption[], { readonly cause: unknown }>;
  /** A disposable client on the host's default Codex sign-in, with no local tools. */
  createClient(): AgentClient;
  usageObserver(agent: AgentSummary, model: AgentModelOption): GenerationObserver;
  stopping(): boolean;
  redact(text: string): string;
}

/** Owns a user-requested side search. Its process, directory and usage counter are separate. */
export class WebSearch {
  readonly #options: WebSearchOptions;

  constructor(options: WebSearchOptions) {
    this.#options = options;
  }

  readonly search = Effect.fn("WebSearch.search")(function* (this: WebSearch, agentId: string, query: string) {
    const options = this.#options;
    const failed = (message: string) => new ToolOperationFailed({ cause: new Error(message) });
    const agent = options.agent(agentId);
    if (!agent) return yield* failed(sourceText("error.agent.gone"));
    if (!providerNeedsWebSearch(agent.provider)) return yield* failed(sourceText("error.agent.toolRequestInvalid"));
    if (options.stopping()) return yield* failed(sourceText("error.backend.shuttingDown"));
    if (!options.profileClients.hasSpare()) return yield* failed(sourceText("error.agent.webSearchBusy"));

    const models = yield* options.ready().pipe(
      Effect.tapError((failure) =>
        Effect.sync(() =>
          logger.warn("Codex is not ready for a web search.", {
            errorName: failure.cause instanceof Error ? failure.cause.name : "Error",
          }),
        ),
      ),
      Effect.mapError(() => failed(sourceText("error.agent.webSearchSignIn"))),
    );
    // Startup can yield while another generation starts, shutdown begins or this agent is removed.
    if (options.stopping()) return yield* failed(sourceText("error.backend.shuttingDown"));
    if (!options.agent(agentId)) return yield* failed(sourceText("error.agent.gone"));
    const available = models.filter((model) => model.provider === "codex");
    const model =
      available.find((candidate) => candidate.id === agentProviderDescriptor("codex").defaultModel) ?? available[0];
    if (!model) return yield* failed(sourceText("error.provider.noModel"));
    const effort = model.supportedReasoningEfforts.includes("low") ? "low" : model.defaultReasoningEffort;
    const client = yield* Effect.try({
      try: () => options.createClient(),
      catch: () => failed(sourceText("error.agent.webSearchSignIn")),
    });
    if (client.provider !== "codex") return yield* failed(sourceText("error.agent.webSearchSignIn"));
    return yield* options.profileClients.runIfSpare(
      client,
      (cancelled) =>
        generateTextWithoutTools(
          client,
          { ...model, defaultReasoningEffort: effort },
          options.redact(query),
          () => cancelled() || options.stopping() || !options.agent(agentId),
          options.usageObserver(agent, model),
          "webSearch",
        ).pipe(
          Effect.mapError((failure) => {
            logger.warn("A web search failed.", { errorName: failure._tag });
            return failed(
              sourceText(
                failure instanceof GenerationUsageLimitError
                  ? "error.provider.usageLimitReached"
                  : "error.agent.webSearchFailed",
              ),
            );
          }),
          Effect.flatMap((answer) =>
            answer.trim()
              ? Effect.succeed(options.redact(answer))
              : Effect.fail(failed(sourceText("error.agent.webSearchFailed"))),
          ),
        ),
      failed(sourceText("error.agent.webSearchBusy")),
    );
  });
}
