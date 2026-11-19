import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { type AccountUsageWindow, AGENT_ACCESS_MODES, type AgentAccess, type AgentSummary } from "@tommy/contracts/ipc";
import type { sourceText } from "@tommy/i18n/source";
import { Effect, Result } from "effect";
import { readAgentInstructionsFile, saveAgentInstructionsFile } from "../backend/agent/workspace-instructions";
import type { AgentService } from "../backend/agent-service";
import type { TelegramReplyMarkup } from "./telegram-api";
import { escapeTelegramHtml, maskEmails } from "./telegram-format";

type Translate = typeof sourceText;

export type TelegramCommandService = Pick<
  AgentService,
  | "listAgents"
  | "listAgentModels"
  | "updateAgent"
  | "deleteAgent"
  | "compactAgentContext"
  | "listQueue"
  | "cancelQueuedMessage"
  | "getUsage"
  | "listMemories"
  | "listRoutines"
  | "updateRoutine"
  | "testRoutine"
  | "readConversation"
  | "getRuntimeSnapshot"
  | "instructionsSaving"
>;

export interface TelegramCommandReply {
  html: string;
  markup?: TelegramReplyMarkup;
}

interface Options {
  service: TelegramCommandService;
  /** Tommy's own data. An agent never gets a folder in it. */
  dataRoot: string;
  /** The real path of an existing directory, or null. Tests replace the file system. */
  realDirectory?: (path: string) => Promise<string | null>;
  instructions?: {
    read: (workspace: string) => Effect.Effect<{ text: string; exists: boolean }, unknown>;
    save: (workspace: string, text: string, expected: string) => Effect.Effect<unknown, unknown>;
  };
}

const REMOVE_KEYBOARD: TelegramReplyMarkup = { remove_keyboard: true };

/** Telegram refuses a message over 4096 characters. Leave room for the HTML that formatting adds. */
const LIMIT = 3900;
const NAMES = [
  "status",
  "model",
  "effort",
  "access",
  "instructions",
  "folders",
  "delete",
  "compact",
  "cancel",
  "queue",
  "usage",
  "memory",
  "routines",
  "history",
] as const;
type Name = (typeof NAMES)[number];

function commandName(value: string | undefined): Name | null {
  return NAMES.find((name) => name === value) ?? null;
}

async function defaultRealDirectory(path: string): Promise<string | null> {
  try {
    const real = await realpath(path);
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

/** Cut a list of lines to the message limit, with a marker when lines were left out. */
function fitLines(lines: readonly string[]): string {
  const out: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > LIMIT) {
      out.push("…");
      break;
    }
    out.push(line);
    size += line.length + 1;
  }
  return out.join("\n");
}

function clip(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function html(text: string): string {
  return escapeTelegramHtml(maskEmails(text));
}

function time(epoch: number, timeZone: string, language: "en" | "ko"): string {
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  };
  try {
    return new Date(epoch).toLocaleString(language === "ko" ? "ko-KR" : "en-US", options);
  } catch {
    return new Date(epoch).toISOString().slice(0, 16).replace("T", " ");
  }
}

/**
 * The chat commands that change or show the agent of one Telegram chat. The manager chat is the
 * root agent's chat; each agent bot is the chat of its own agent. Every reply is Telegram HTML.
 */
export class TelegramCommands {
  readonly #options: Options;

  constructor(options: Options) {
    this.#options = options;
  }

  static readonly names: readonly string[] = NAMES;

  readonly handle = Effect.fn("TelegramCommands.handle")(function* (
    this: TelegramCommands,
    agentId: string,
    text: string,
    t: Translate,
    context: { timeZone: string; language: "en" | "ko"; isRoot: boolean },
  ): Effect.fn.Return<TelegramCommandReply | null> {
    const match = /^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/iu.exec(text.trim());
    const name = commandName(match?.[1]?.toLowerCase());
    if (!name) return null;
    const agent = this.#options.service.listAgents().find((entry) => entry.id === agentId && !entry.hiddenAt);
    if (!agent) return { html: html(t("status.messaging.telegramUnavailable")) };
    const argument = match?.[2]?.trim() ?? "";
    const result = yield* Effect.result(this.#run(name, agent, argument, t, context));
    return Result.isSuccess(result) ? result.success : { html: html(t("status.messaging.telegramCommandFailed")) };
  }).bind(this);

  #run(
    name: Name,
    agent: AgentSummary,
    argument: string,
    t: Translate,
    context: { timeZone: string; language: "en" | "ko"; isRoot: boolean },
  ): Effect.Effect<TelegramCommandReply, unknown> {
    switch (name) {
      case "status":
        return Effect.sync(() => this.#status(agent, t));
      case "model":
        return this.#model(agent, argument, t);
      case "effort":
        return this.#effort(agent, argument, t);
      case "access":
        return this.#access(agent, argument, t);
      case "instructions":
        return this.#instructions(agent, argument, t);
      case "folders":
        return this.#folders(agent, argument, t);
      case "delete":
        return this.#delete(agent, argument, t, context.isRoot);
      case "compact":
        return this.#compact(agent, t);
      case "cancel":
        return this.#cancel(agent, t);
      case "queue":
        return Effect.sync(() => this.#queue(agent, t));
      case "usage":
        return this.#usage(agent, t, context);
      case "memory":
        return Effect.sync(() => this.#memory(agent, t));
      case "routines":
        return this.#routines(agent, argument, t, context);
      case "history":
        return this.#history(agent, argument, t);
    }
  }

  #waiting(agent: AgentSummary): number {
    return this.#options.service.listQueue(agent.id).deliveries.filter((delivery) => delivery.status === "queued")
      .length;
  }

  #accessLabel(access: AgentAccess, t: Translate): string {
    return access === "full" ? t("status.messaging.telegramAccessFull") : t("status.messaging.telegramAccessWorkspace");
  }

  #status(agent: AgentSummary, t: Translate): TelegramCommandReply {
    const working = this.#options.service.getRuntimeSnapshot().activeTurns.some((turn) => turn.agentId === agent.id);
    const pending = agent.pendingRuntime;
    const lines = [
      `<b>${html(agent.name)}</b>`,
      `${html(t("status.messaging.telegramLabelEngine"))}: ${html(agent.provider)} · <code>${html(agent.model)}</code>`,
      `${html(t("status.messaging.telegramLabelEffort"))}: ${html(agent.reasoningEffort)}`,
      `${html(t("status.messaging.telegramLabelAccess"))}: ${html(this.#accessLabel(agent.access ?? "full", t))}`,
      `${html(t("status.messaging.telegramLabelState"))}: ${html(working ? t("status.messaging.telegramStateWorking") : t("status.messaging.telegramStateIdle"))}`,
      `${html(t("status.messaging.telegramLabelQueue"))}: ${this.#waiting(agent)}`,
    ];
    if (pending)
      lines.push(html(t("status.messaging.telegramPendingRuntime", { model: `${pending.provider} ${pending.model}` })));
    return { html: lines.join("\n") };
  }

  #models(agent: AgentSummary) {
    return this.#options.service.listAgentModels({
      provider: agent.pendingRuntime?.provider ?? agent.provider,
      providerAccountId: agent.providerAccountId,
    });
  }

  #model(agent: AgentSummary, argument: string, t: Translate) {
    return Effect.gen({ self: this }, function* () {
      const models = this.#models(agent);
      if (!argument) {
        const current = agent.pendingRuntime?.model ?? agent.model;
        const lines = [`<b>${html(t("status.messaging.telegramModelChoose"))}</b>`];
        for (const model of models)
          lines.push(`${model.id === current ? "✓ " : "• "}<code>${html(model.id)}</code> ${html(model.name)}`);
        return {
          html: fitLines(lines),
          markup: {
            keyboard: models.slice(0, 30).map((model) => [{ text: `/model ${model.id}`.slice(0, 120) }]),
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        } satisfies TelegramCommandReply;
      }
      const wanted = argument.toLowerCase();
      const model = models.find((item) => item.id.toLowerCase() === wanted || item.name.toLowerCase() === wanted);
      if (!model) return { html: html(t("status.messaging.telegramModelUnknown", { name: argument })) };
      yield* this.#options.service.updateAgent({ agentId: agent.id, model: model.id });
      return { html: html(t("status.messaging.telegramModelSet", { model: model.id })), markup: REMOVE_KEYBOARD };
    });
  }

  #effort(agent: AgentSummary, argument: string, t: Translate) {
    return Effect.gen({ self: this }, function* () {
      const model = this.#models(agent).find((item) => item.id === (agent.pendingRuntime?.model ?? agent.model));
      if (!model || model.reasoningEffortConfigurable === false)
        return { html: html(t("status.messaging.telegramEffortUnsupported")) } satisfies TelegramCommandReply;
      const levels = model.supportedReasoningEfforts;
      if (!argument)
        return {
          html: `<b>${html(t("status.messaging.telegramEffortChoose"))}</b>\n${levels
            .map((level) => `${level === agent.reasoningEffort ? "✓" : "•"} ${html(level)}`)
            .join("\n")}`,
          markup: {
            keyboard: levels.map((level) => [{ text: `/effort ${level}` }]),
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        } satisfies TelegramCommandReply;
      const level = levels.find((item) => item === argument.toLowerCase());
      if (!level) return { html: html(t("status.messaging.telegramEffortUnknown", { levels: levels.join(", ") })) };
      yield* this.#options.service.updateAgent({ agentId: agent.id, reasoningEffort: level });
      return { html: html(t("status.messaging.telegramEffortSet", { effort: level })), markup: REMOVE_KEYBOARD };
    });
  }

  #access(agent: AgentSummary, argument: string, t: Translate) {
    return Effect.gen({ self: this }, function* () {
      const wanted = argument.toLowerCase();
      const access = AGENT_ACCESS_MODES.find((mode) => mode === wanted);
      if (!access)
        return {
          html: `<b>${html(t("status.messaging.telegramAccessChoose"))}</b>\n${AGENT_ACCESS_MODES.map(
            (mode) =>
              `${mode === (agent.access ?? "full") ? "✓" : "•"} <code>${mode}</code> ${html(this.#accessLabel(mode, t))}`,
          ).join("\n")}`,
          markup: {
            keyboard: AGENT_ACCESS_MODES.map((mode) => [{ text: `/access ${mode}` }]),
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        } satisfies TelegramCommandReply;
      yield* this.#options.service.updateAgent({ agentId: agent.id, access });
      return {
        html: html(t("status.messaging.telegramAccessSet", { access: this.#accessLabel(access, t) })),
        markup: REMOVE_KEYBOARD,
      };
    });
  }

  #instructions(agent: AgentSummary, argument: string, t: Translate) {
    const files = this.#options.instructions ?? {
      read: (workspace: string) => readAgentInstructionsFile(workspace),
      save: (workspace: string, text: string, expected: string) => saveAgentInstructionsFile(workspace, text, expected),
    };
    return Effect.gen({ self: this }, function* () {
      const current = yield* files.read(agent.workspacePath);
      const action = /^(set|add)\s+([\s\S]+)$/iu.exec(argument);
      if (!action) {
        if (!current.exists || !current.text.trim())
          return { html: html(t("status.messaging.telegramInstructionsEmpty")) } satisfies TelegramCommandReply;
        const body = current.text.length > LIMIT - 300 ? `${current.text.slice(0, LIMIT - 300)}…` : current.text;
        return {
          html: `<pre>${escapeTelegramHtml(body)}</pre>\n${html(t("status.messaging.telegramInstructionsHelp"))}`,
        } satisfies TelegramCommandReply;
      }
      const added = action[2]?.trim() ?? "";
      const next =
        action[1]?.toLowerCase() === "set"
          ? `${added}\n`
          : `${current.text.replace(/\s*$/u, "")}${current.text.trim() ? "\n" : ""}${added}\n`;
      const done = this.#options.service.instructionsSaving(agent.id, next);
      const saved = yield* Effect.result(files.save(agent.workspacePath, next, current.text));
      done(Result.isSuccess(saved));
      return {
        html: html(
          t(
            Result.isSuccess(saved)
              ? "status.messaging.telegramInstructionsSaved"
              : "status.messaging.telegramInstructionsFailed",
          ),
        ),
      } satisfies TelegramCommandReply;
    });
  }

  #folders(agent: AgentSummary, argument: string, t: Translate) {
    return Effect.gen({ self: this }, function* () {
      const folders = agent.additionalFolders ?? [];
      const action = /^(add|remove)\s+(.+)$/iu.exec(argument);
      if (!action) {
        const lines = folders.length
          ? folders.map((folder) => `• <code>${html(folder)}</code>`)
          : [html(t("status.messaging.telegramFoldersNone"))];
        return {
          html: `${fitLines(lines)}\n${html(t("status.messaging.telegramFoldersHelp"))}`,
        } satisfies TelegramCommandReply;
      }
      const path = action[2]?.trim() ?? "";
      if (action[1]?.toLowerCase() === "remove") {
        if (!folders.includes(path)) return { html: html(t("status.messaging.telegramFoldersUnknown")) };
        yield* this.#options.service.updateAgent({
          agentId: agent.id,
          additionalFolders: folders.filter((folder) => folder !== path),
        });
        return { html: html(t("status.messaging.telegramFoldersSaved")) };
      }
      const real = isAbsolute(path)
        ? yield* Effect.promise(() => (this.#options.realDirectory ?? defaultRealDirectory)(path))
        : null;
      const dataRoot =
        (yield* Effect.promise(() => (this.#options.realDirectory ?? defaultRealDirectory)(this.#options.dataRoot))) ??
        this.#options.dataRoot;
      const workspace =
        (yield* Effect.promise(() => (this.#options.realDirectory ?? defaultRealDirectory)(agent.workspacePath))) ??
        agent.workspacePath;
      if (!real || real === sep || inside(real, dataRoot) || inside(dataRoot, real) || inside(workspace, real))
        return { html: html(t("status.messaging.telegramFoldersInvalid")) } satisfies TelegramCommandReply;
      if (folders.includes(real)) return { html: html(t("status.messaging.telegramFoldersSaved")) };
      yield* this.#options.service.updateAgent({
        agentId: agent.id,
        additionalFolders: [...folders, real],
      });
      return { html: html(t("status.messaging.telegramFoldersSaved")) } satisfies TelegramCommandReply;
    });
  }

  #delete(agent: AgentSummary, argument: string, t: Translate, isRoot: boolean) {
    return Effect.gen({ self: this }, function* () {
      if (isRoot) return { html: html(t("status.messaging.telegramDeleteRoot")) } satisfies TelegramCommandReply;
      if (argument !== agent.name)
        return {
          html: html(t("status.messaging.telegramDeleteConfirm", { name: agent.name })),
        } satisfies TelegramCommandReply;
      yield* this.#options.service.deleteAgent(agent.id);
      return { html: html(t("status.messaging.telegramDeleted", { name: agent.name })) } satisfies TelegramCommandReply;
    });
  }

  #compact(agent: AgentSummary, t: Translate) {
    return Effect.gen({ self: this }, function* () {
      const result = yield* Effect.result(this.#options.service.compactAgentContext(agent.id));
      return {
        html: html(
          t(
            Result.isSuccess(result) ? "status.messaging.telegramCompacted" : "status.messaging.telegramCompactRefused",
          ),
        ),
      } satisfies TelegramCommandReply;
    });
  }

  #cancel(agent: AgentSummary, t: Translate) {
    return Effect.gen({ self: this }, function* () {
      const waiting = this.#options.service
        .listQueue(agent.id)
        .deliveries.filter((delivery) => delivery.status === "queued");
      if (!waiting.length)
        return { html: html(t("status.messaging.telegramQueueEmpty")) } satisfies TelegramCommandReply;
      let canceled = 0;
      for (const delivery of waiting) {
        const result = yield* Effect.result(this.#options.service.cancelQueuedMessage(agent.id, delivery.id));
        if (Result.isSuccess(result)) canceled += 1;
      }
      return {
        html: html(t("status.messaging.telegramCanceled", { count: String(canceled) })),
      } satisfies TelegramCommandReply;
    });
  }

  #queue(agent: AgentSummary, t: Translate): TelegramCommandReply {
    const deliveries = this.#options.service
      .listQueue(agent.id)
      .deliveries.filter(
        (delivery) => delivery.status === "queued" || delivery.status === "running" || delivery.status === "starting",
      );
    if (!deliveries.length) return { html: html(t("status.messaging.telegramQueueEmpty")) };
    return {
      html: fitLines(
        deliveries.map(
          (delivery, index) =>
            `${index + 1}. ${delivery.status === "queued" ? "⏳" : "▶️"} ${html(clip(delivery.text || "…", 160))}`,
        ),
      ),
    };
  }

  #window(window: AccountUsageWindow | null, context: { timeZone: string; language: "en" | "ko" }): string {
    if (!window) return "";
    const reset =
      window.resetsAt === null ? "" : ` (${time(window.resetsAt * 1000, context.timeZone, context.language)})`;
    return `${Math.round(window.usedPercent)}%${reset}`;
  }

  #usage(agent: AgentSummary, t: Translate, context: { timeZone: string; language: "en" | "ko" }) {
    return Effect.gen({ self: this }, function* () {
      const usage = yield* this.#options.service.getUsage(agent.id);
      const lines = usage.limits.flatMap((limit) => {
        const windows = [limit.primary, limit.secondary].map((window) => this.#window(window, context)).filter(Boolean);
        return windows.length ? [`<b>${html(limit.id)}</b>: ${html(windows.join(" · "))}`] : [];
      });
      return {
        html: lines.length
          ? `${html(t("status.messaging.telegramUsageTitle"))}\n${fitLines(lines)}`
          : html(t("status.messaging.telegramUsageNone")),
      } satisfies TelegramCommandReply;
    });
  }

  #memory(agent: AgentSummary, t: Translate): TelegramCommandReply {
    const memories = this.#options.service.listMemories(agent.id);
    if (!memories.length) return { html: html(t("status.messaging.telegramMemoryNone")) };
    return { html: fitLines(memories.map((memory, index) => `${index + 1}. ${html(clip(memory.text, 300))}`)) };
  }

  #routines(agent: AgentSummary, argument: string, t: Translate, context: { timeZone: string; language: "en" | "ko" }) {
    return Effect.gen({ self: this }, function* () {
      const routines = this.#options.service.listRoutines(agent.id);
      const action = /^(on|off|run)\s+(.+)$/iu.exec(argument);
      if (!action) {
        if (!routines.length)
          return { html: html(t("status.messaging.telegramRoutinesNone")) } satisfies TelegramCommandReply;
        const lines = routines.map((routine) => {
          const state = routine.active
            ? t("status.messaging.telegramRoutineOn")
            : t("status.messaging.telegramRoutineOff");
          const next = routine.active
            ? ` · ${time(Date.parse(routine.trigger.nextRunAt), context.timeZone, context.language)}`
            : "";
          return `• <b>${html(routine.name)}</b> (${html(state)}${html(next)})`;
        });
        return {
          html: `${fitLines(lines)}\n${html(t("status.messaging.telegramRoutinesHelp"))}`,
        } satisfies TelegramCommandReply;
      }
      const name = action[2]?.trim().toLowerCase() ?? "";
      const routine = routines.find((item) => item.name.trim().toLowerCase() === name);
      if (!routine)
        return {
          html: html(t("status.messaging.telegramRoutineUnknown", { name: action[2]?.trim() ?? "" })),
        } satisfies TelegramCommandReply;
      const verb = action[1]?.toLowerCase();
      if (verb === "run") {
        yield* this.#options.service.testRoutine({ agentId: agent.id, routineId: routine.id });
        return {
          html: html(t("status.messaging.telegramRoutineStarted", { name: routine.name })),
        } satisfies TelegramCommandReply;
      }
      const active = verb === "on";
      yield* Effect.try(() =>
        this.#options.service.updateRoutine({ agentId: agent.id, routineId: routine.id, active }),
      );
      return {
        html: html(
          t("status.messaging.telegramRoutineSaved", {
            name: routine.name,
            state: active ? t("status.messaging.telegramRoutineOn") : t("status.messaging.telegramRoutineOff"),
          }),
        ),
      } satisfies TelegramCommandReply;
    });
  }

  #history(agent: AgentSummary, argument: string, t: Translate) {
    return Effect.gen({ self: this }, function* () {
      const requested = Number.parseInt(argument, 10);
      const count = Number.isFinite(requested) ? Math.min(30, Math.max(1, requested)) : 10;
      const conversation = yield* this.#options.service.readConversation(agent.id);
      const messages = conversation.messages
        .filter(
          (message) =>
            (message.author === "user" || message.author === "assistant") &&
            message.status === "completed" &&
            message.text.trim() &&
            (message.itemType === undefined ||
              message.itemType === "agentMessage" ||
              message.itemType === "userMessage"),
        )
        .slice(-count);
      if (!messages.length)
        return { html: html(t("status.messaging.telegramHistoryNone")) } satisfies TelegramCommandReply;
      const perMessage = Math.max(120, Math.floor((LIMIT - 200) / messages.length) - 40);
      const lines = messages.map(
        (message) =>
          `<b>${html(message.author === "user" ? t("status.messaging.telegramHistoryYou") : agent.name)}</b>: ${html(clip(message.text, perMessage))}`,
      );
      return { html: fitLines(lines) } satisfies TelegramCommandReply;
    });
  }
}

/** For the "/" menu: the command and its description key. */
export const TELEGRAM_COMMAND_MENU = [
  ["status", "status.messaging.telegramCommandStatus"],
  ["model", "status.messaging.telegramCommandModel"],
  ["effort", "status.messaging.telegramCommandEffort"],
  ["access", "status.messaging.telegramCommandAccess"],
  ["instructions", "status.messaging.telegramCommandInstructions"],
  ["folders", "status.messaging.telegramCommandFolders"],
  ["compact", "status.messaging.telegramCommandCompact"],
  ["cancel", "status.messaging.telegramCommandCancel"],
  ["queue", "status.messaging.telegramCommandQueue"],
  ["usage", "status.messaging.telegramCommandUsage"],
  ["memory", "status.messaging.telegramCommandMemory"],
  ["routines", "status.messaging.telegramCommandRoutines"],
  ["history", "status.messaging.telegramCommandHistory"],
  ["delete", "status.messaging.telegramCommandDelete"],
] as const;
