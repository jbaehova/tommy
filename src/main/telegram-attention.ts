import type { AgentApproval, AgentEvent, AgentPromptQuestion } from "@tommy/contracts/ipc";
import { sourceTranslateFor } from "@tommy/i18n/source";
import { createTommyLogger } from "@tommy/logging";
import { Effect } from "effect";
import type { TelegramReplyMarkup } from "./telegram-api";
import { escapeTelegramHtml, maskEmails, telegramHtml } from "./telegram-format";

const logger = createTommyLogger("telegram-attention");

interface Prompt {
  kind: "prompt";
  requestId: string | number;
  agentId: string;
  questions: AgentPromptQuestion[];
  index: number;
  answers: Record<string, string[]>;
  picked: string[];
}

interface Approval {
  kind: "approval";
  requestId: string | number;
  agentId: string;
}

/** A prompt that needs private input. The Mini App answers it; the chat only points there. */
interface Private {
  kind: "private";
  requestId: string | number;
  agentId: string;
}

type Pending = Prompt | Approval | Private;

interface Options {
  /** The bot chat that shows this turn's requests, or null when the owner did not start it in Telegram. */
  chatFor: (agentId: string, turnId: string) => number | null;
  agentName: (agentId: string) => string;
  send: (chat: number, html: string, markup?: TelegramReplyMarkup) => Effect.Effect<void, Error>;
  deleteMessage: (chat: number, messageId: number) => Effect.Effect<void, Error>;
  /**
   * The button that opens this chat's Mini App. With it, a secret question or a Vault or API key
   * form is answered there and never typed into the chat.
   */
  appButton?: (chat: number) => TelegramReplyMarkup;
  /** A Vault or API key form, which needs the Mini App even without a secret question. */
  isPrivate?: (requestId: string | number) => boolean;
  respondToPrompt: (requestId: string | number, answers: Record<string, string[]>) => Effect.Effect<void, Error>;
  respondToApproval: (requestId: string | number, decision: "accept" | "decline") => Effect.Effect<void, Error>;
  language: () => "en" | "ko";
}

/**
 * Agent questions and approval requests in the chat of the bot that the work belongs to. The owner
 * answers with keyboard buttons or a text message. One request at a time per chat; later ones wait.
 */
export class TelegramAttention {
  readonly #options: Options;
  readonly #active = new Map<number, Pending>();
  readonly #queued = new Map<number, Pending[]>();

  constructor(options: Options) {
    this.#options = options;
  }

  observe(event: AgentEvent): void {
    if (event.type === "prompt") {
      const chat = this.#options.chatFor(event.agentId, event.turnId);
      if (chat === null || event.questions.length === 0) return;
      const hidden =
        event.questions.some((question) => question.isSecret) || this.#options.isPrivate?.(event.requestId) === true;
      if (hidden && this.#options.appButton) {
        this.#enqueue(chat, { kind: "private", requestId: event.requestId, agentId: event.agentId });
        return;
      }
      this.#enqueue(chat, {
        kind: "prompt",
        requestId: event.requestId,
        agentId: event.agentId,
        questions: event.questions,
        index: 0,
        answers: {},
        picked: [],
      });
    } else if (event.type === "approval") {
      const approval = event.approval;
      const chat = this.#options.chatFor(approval.agentId, approval.turnId);
      if (chat === null) return;
      this.#enqueue(chat, { kind: "approval", requestId: approval.requestId, agentId: approval.agentId }, approval);
    } else if (event.type === "agent-input-resolved") {
      this.#resolved(event.requestId, event.agentId);
    }
  }

  close(): void {
    this.#active.clear();
    this.#queued.clear();
  }

  #t() {
    return sourceTranslateFor(this.#options.language());
  }

  #enqueue(chat: number, item: Pending, approval?: AgentApproval) {
    if (this.#active.has(chat)) {
      const queue = this.#queued.get(chat) ?? [];
      queue.push(item);
      this.#queued.set(chat, queue);
      this.#approvals.set(item.requestId, approval);
      return;
    }
    this.#approvals.set(item.requestId, approval);
    this.#active.set(chat, item);
    this.#show(chat, item);
  }

  readonly #approvals = new Map<string | number, AgentApproval | undefined>();

  #resolved(requestId: string | number, agentId: string) {
    for (const [chat, queue] of this.#queued) {
      const rest = queue.filter((item) => item.requestId !== requestId || item.agentId !== agentId);
      if (rest.length) this.#queued.set(chat, rest);
      else this.#queued.delete(chat);
    }
    for (const [chat, item] of this.#active)
      if (item.requestId === requestId && item.agentId === agentId) this.#next(chat, true);
    this.#approvals.delete(requestId);
  }

  #next(chat: number, quiet = false) {
    const current = this.#active.get(chat);
    if (current) this.#approvals.delete(current.requestId);
    this.#active.delete(chat);
    const queue = this.#queued.get(chat) ?? [];
    const item = queue.shift();
    if (queue.length) this.#queued.set(chat, queue);
    else this.#queued.delete(chat);
    if (item) {
      this.#active.set(chat, item);
      this.#show(chat, item);
    } else if (!quiet)
      this.#post(chat, escapeTelegramHtml(this.#t()("status.messaging.telegramAnswerSent")), { remove_keyboard: true });
  }

  #post(chat: number, html: string, markup?: TelegramReplyMarkup) {
    // Telegram refuses a keyboard that redaction would change. The text alone still lets the owner answer.
    const send = this.#options
      .send(chat, html, markup)
      .pipe(Effect.catch((error) => (markup ? this.#options.send(chat, html) : Effect.fail(error))));
    void Effect.runPromise(send).catch(() => logger.warn("Telegram could not show an agent request."));
  }

  #show(chat: number, item: Pending) {
    const t = this.#t();
    const name = escapeTelegramHtml(this.#options.agentName(item.agentId));
    if (item.kind === "private") {
      const text = t("status.messaging.telegramPrivateInput", { name: this.#options.agentName(item.agentId) });
      this.#post(chat, escapeTelegramHtml(text), this.#options.appButton?.(chat));
      return;
    }
    if (item.kind === "approval") {
      const approval = this.#approvals.get(item.requestId);
      const lines = [
        `<b>${escapeTelegramHtml(t("status.messaging.telegramApprovalTitle", { name: this.#options.agentName(item.agentId) }))}</b>`,
      ];
      if (approval?.reason) lines.push(telegramHtml(approval.reason));
      if (approval?.command) lines.push(`<pre>${escapeTelegramHtml(approval.command.slice(0, 3000))}</pre>`);
      if (approval?.cwd) lines.push(`<code>${escapeTelegramHtml(approval.cwd)}</code>`);
      this.#post(chat, lines.join("\n"), {
        keyboard: [[{ text: t("status.messaging.telegramApprove") }, { text: t("status.messaging.telegramDecline") }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      });
      return;
    }
    const question = item.questions[item.index];
    if (!question) return;
    const lines = [`<b>${name}</b>`];
    if (question.header) lines.push(`<b>${escapeTelegramHtml(maskEmails(question.header))}</b>`);
    lines.push(telegramHtml(maskEmails(question.question)));
    for (const option of question.options ?? [])
      lines.push(
        `• <b>${escapeTelegramHtml(maskEmails(option.label))}</b>${option.description ? ` ${escapeTelegramHtml(maskEmails(option.description))}` : ""}`,
      );
    if (question.isSecret) lines.push(`<i>${escapeTelegramHtml(t("status.messaging.telegramSecretAnswer"))}</i>`);
    if (question.multiSelect) lines.push(`<i>${escapeTelegramHtml(t("status.messaging.telegramPickMany"))}</i>`);
    const rows = (question.options ?? []).map((option) => [{ text: maskEmails(option.label).slice(0, 120) }]);
    if (question.multiSelect) rows.push([{ text: t("status.messaging.telegramDone") }]);
    rows.push([{ text: t("status.messaging.telegramSkip") }]);
    this.#post(chat, lines.join("\n"), {
      keyboard: rows,
      resize_keyboard: true,
      one_time_keyboard: !question.multiSelect,
    });
  }

  /** Takes the owner's message as the answer when a request waits in this chat. */
  take(chat: number, text: string, messageId: number): boolean {
    const item = this.#active.get(chat);
    // The Mini App answers a private prompt. A chat message goes to the agent as usual.
    if (!item || item.kind === "private") return false;
    const t = this.#t();
    const value = text.trim();
    if (item.kind === "approval") {
      const decision =
        value === t("status.messaging.telegramApprove")
          ? "accept"
          : value === t("status.messaging.telegramDecline")
            ? "decline"
            : null;
      if (decision === null) {
        this.#show(chat, item);
        return true;
      }
      this.#run(this.#options.respondToApproval(item.requestId, decision));
      this.#next(chat);
      return true;
    }
    const question = item.questions[item.index];
    if (!question) return false;
    if (question.isSecret) void Effect.runPromise(this.#options.deleteMessage(chat, messageId)).catch(() => {});
    const skip = value === t("status.messaging.telegramSkip");
    if (question.multiSelect && !skip && value !== t("status.messaging.telegramDone")) {
      const label = this.#option(question, value);
      if (label) {
        if (!item.picked.includes(label)) item.picked.push(label);
        return true;
      }
    }
    const answer = skip
      ? null
      : question.multiSelect
        ? item.picked.length
          ? [...item.picked]
          : value === t("status.messaging.telegramDone")
            ? []
            : [this.#option(question, value) ?? value]
        : [this.#option(question, value) ?? value];
    // A skipped question has no answer, which is what the provider gets when nobody answers.
    if (answer?.length) item.answers[question.id] = answer;
    item.picked = [];
    item.index += 1;
    if (item.index < item.questions.length) {
      this.#show(chat, item);
      return true;
    }
    this.#run(this.#options.respondToPrompt(item.requestId, item.answers));
    this.#next(chat);
    return true;
  }

  /** The option that a keyboard button shows, by its full or shown label. */
  #option(question: AgentPromptQuestion, value: string): string | undefined {
    return question.options?.find(
      (option) => option.label === value || maskEmails(option.label).slice(0, 120) === value,
    )?.label;
  }

  #run(effect: Effect.Effect<void, Error>) {
    void Effect.runPromise(effect).catch(() => logger.warn("Telegram could not answer an agent request."));
  }
}
