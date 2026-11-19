import { INPUT_LIMITS } from "@tommy/contracts/input-limits";
import type { AgentSummary } from "@tommy/contracts/ipc";
import type { sourceText } from "@tommy/i18n/source";
import { redactText } from "@tommy/logging";
import { Effect, Result } from "effect";
import { startingModel } from "../backend/agent/model-choice";
import type { AgentService } from "../backend/agent-service";
import type { TelegramApi } from "./telegram-api";
import { chatReady, type TelegramConnection, type TelegramDirectory } from "./telegram-directory";
import type { TelegramSettings } from "./telegram-settings";

type Translate = typeof sourceText;
type Engine = "codex" | "claude";

export class TelegramProfile {
  constructor(
    private readonly service: Pick<AgentService, "listAgents" | "listAgentModels" | "updateAgent">,
    private readonly directory: Pick<TelegramDirectory, "get" | "setDisplayName">,
    private readonly api: Pick<TelegramApi, "getManagedBotToken" | "setMyName">,
    private readonly settings: Pick<TelegramSettings, "token">,
  ) {}

  #current(binding: TelegramConnection) {
    const current = this.directory.get(binding.id);
    return Boolean(
      chatReady(current) && current.agentId === binding.agentId && current.operationId === binding.operationId,
    );
  }

  /** Called in the verified child's private owner chat. Non-commands pass through to the agent. */
  readonly handle = Effect.fn("TelegramProfile.handle")(function* (
    this: TelegramProfile,
    binding: TelegramConnection,
    text: string,
    t: Translate,
  ) {
    const match = /^\/(engine|name)(?:\s+([\s\S]*))?$/iu.exec(text.trim());
    if (!match) return null;
    const agent = this.service
      .listAgents()
      .find((entry) => entry.id === binding.agentId && entry.hiddenAt === undefined);
    if (!agent || !this.#current(binding)) return t("status.messaging.telegramUnavailable");
    const argument = match[2]?.trim() ?? "";
    if (match[1]?.toLowerCase() === "name") {
      if (
        !argument ||
        argument.length > INPUT_LIMITS.agentName ||
        [...argument].length > 64 ||
        /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u.test(argument) ||
        redactText(argument) !== argument
      ) {
        return t("status.agent.telegramNameUsage");
      }
      return yield* this.#rename(binding, agent, argument, t);
    }
    const engine = argument.toLowerCase();
    if (engine !== "codex" && engine !== "claude") return t("status.agent.telegramEngineUsage");
    return yield* this.#selectEngine(agent, engine, t);
  }).bind(this);

  readonly #selectEngine = Effect.fn("TelegramProfile.engine")(function* (
    this: TelegramProfile,
    agent: AgentSummary,
    engine: Engine,
    t: Translate,
  ) {
    let next = agent;
    if ((agent.pendingRuntime?.provider ?? agent.provider) !== engine) {
      // The host switches provider and model together, using its own connected model catalog.
      const choice =
        engine === agent.provider
          ? { id: agent.model }
          : startingModel(engine, this.service.listAgentModels({ provider: engine }), {
              provider: engine,
              model: null,
            });
      if (!choice) return t("status.agent.telegramEngineUnavailable", { engine });
      const updated = yield* Effect.result(
        this.service.updateAgent({ agentId: agent.id, provider: engine, model: choice.id }),
      );
      if (Result.isFailure(updated)) return t("status.agent.telegramEngineUnavailable", { engine });
      next = updated.success;
    }
    return next.pendingRuntime
      ? t("status.agent.telegramEngineQueued", { engine, model: next.pendingRuntime.model })
      : t("status.agent.telegramEngineSet", { engine, model: next.model });
  });

  readonly #rename = Effect.fn("TelegramProfile.rename")(function* (
    this: TelegramProfile,
    binding: TelegramConnection,
    agent: AgentSummary,
    name: string,
    t: Translate,
  ) {
    // Save the desired name on the host first. Repeating the command after a Telegram failure
    // sets the same local and remote values, including after a lost Telegram response.
    if (agent.name !== name) {
      const update = yield* Effect.result(this.service.updateAgent({ agentId: agent.id, name }));
      if (Result.isFailure(update)) return t("status.agent.telegramNameRefused");
    }
    const saved = yield* Effect.result(this.directory.setDisplayName(binding.id, name, binding.operationId));
    if (Result.isFailure(saved) || !this.#current(binding)) return t("status.messaging.telegramUnavailable");
    const token = yield* Effect.result(this.api.getManagedBotToken(this.settings.token, binding.id));
    if (!this.#current(binding)) return t("status.messaging.telegramUnavailable");
    if (Result.isFailure(token)) return t("status.agent.telegramNameRetry");
    const renamed = yield* Effect.result(this.api.setMyName(token.success, name));
    return Result.isSuccess(renamed)
      ? t("status.agent.telegramNameSet", { name })
      : t("status.agent.telegramNameRetry");
  });
}
