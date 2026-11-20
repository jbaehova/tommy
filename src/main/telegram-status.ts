import type { AgentEvent } from "@tommy/contracts/ipc";
import { localizeSourceText, sourceTranslateFor } from "@tommy/i18n/source";
import { createTommyLogger, redactText } from "@tommy/logging";
import { Effect } from "effect";
import { maskEmails } from "./telegram-format";

const logger = createTommyLogger("telegram-status");

/** A turn shorter than this shows only "typing". */
const FIRST_STATUS_MS = 30_000;
/** The status message changes at most this often. An edit makes no notification. */
const STATUS_EDIT_MS = 20_000;
/** A turn that never reports its end keeps its status this long at most. */
const STATUS_LIFETIME_MS = 3 * 60 * 60_000;
const NOTE_CHARACTERS = 240;
const STEP_CHARACTERS = 120;

export interface TelegramStatusOptions {
  /** The chat that shows this turn, or null when none does or Telegram is not ready. */
  chat(agentId: string, turnId: string): number | null;
  /** Sends a silent message to the chat, and answers its id. */
  send(chat: number, text: string): Effect.Effect<number, Error>;
  edit(chat: number, messageId: number, text: string): Effect.Effect<void, Error>;
  remove(chat: number, messageId: number): Effect.Effect<void, Error>;
  /** The newest note that the agent wrote in the running turn, or null. */
  note(agentId: string, threadId: string, turnId: string): string | null;
  language(): "en" | "ko";
  now?: () => number;
  /** Runs `run` after `ms`, and answers the cancel. Omitted, an unreferenced timer. */
  delay?: (run: () => void, ms: number) => () => void;
}

interface RunningTurn {
  readonly agentId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly startedAt: number;
  /** The newest tool step that the turn reported. */
  step: string | null;
  /** The status message, once Telegram answered the send. */
  message: { chat: number; id: number; text: string } | null;
  /** A send or an edit runs, so the next tick waits for it. */
  busy: boolean;
  ended: boolean;
  cancel: (() => void) | null;
}

/**
 * Owns the status message of a long turn: one message in the chat of the turn that says the agent
 * still works, what it last wrote and its newest tool step. It comes after `FIRST_STATUS_MS`, is
 * edited in place, and is deleted when the turn ends, so a chat keeps only answers. "typing" stays
 * the sign of a short turn. A routine turn has none: nobody waits for it.
 *
 * The message lives in memory only. A server that stops while a turn runs deletes it in `close`; a
 * crash leaves it in the chat.
 */
export class TelegramStatus {
  readonly #options: TelegramStatusOptions;
  readonly #turns = new Map<string, RunningTurn>();
  readonly #now: () => number;
  readonly #delay: (run: () => void, ms: number) => () => void;

  constructor(options: TelegramStatusOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#delay =
      options.delay ??
      ((run, ms) => {
        const timer = setTimeout(run, ms);
        timer.unref();
        return () => clearTimeout(timer);
      });
  }

  observe(event: AgentEvent): void {
    if (event.type === "turn-started") {
      if (event.origin === "routine") return;
      const key = `${event.agentId}:${event.turnId}`;
      this.#end(key);
      const turn: RunningTurn = {
        agentId: event.agentId,
        threadId: event.threadId,
        turnId: event.turnId,
        startedAt: this.#now(),
        step: null,
        message: null,
        busy: false,
        ended: false,
        cancel: null,
      };
      this.#turns.set(key, turn);
      turn.cancel = this.#delay(() => this.#tick(key), FIRST_STATUS_MS);
    } else if (event.type === "turn-progress") {
      const turn = this.#turns.get(`${event.agentId}:${event.turnId}`);
      if (turn) turn.step = event.detail;
    } else if (event.type === "turn-completed") this.#end(`${event.agentId}:${event.turnId}`);
  }

  /** Deletes every status message. The turns that still run get none again. */
  close(): void {
    for (const key of [...this.#turns.keys()]) this.#end(key);
  }

  #tick(key: string): void {
    const turn = this.#turns.get(key);
    if (!turn || turn.ended) return;
    if (this.#now() - turn.startedAt > STATUS_LIFETIME_MS) {
      this.#end(key);
      return;
    }
    turn.cancel = this.#delay(() => this.#tick(key), STATUS_EDIT_MS);
    if (turn.busy) return;
    const text = this.#text(turn);
    const { message } = turn;
    if (message?.text === text) return;
    const chat = message?.chat ?? this.#options.chat(turn.agentId, turn.turnId);
    if (chat === null) return;
    turn.busy = true;
    const change = message
      ? this.#options.edit(chat, message.id, text).pipe(Effect.as(message.id))
      : this.#options.send(chat, text);
    void Effect.runPromise(change)
      .then((id) => {
        turn.message = { chat, id, text };
        // The turn ended while Telegram answered, so `#end` saw no message to delete.
        if (turn.ended) this.#remove(turn);
      })
      .catch(() => logger.warn("Telegram could not show the status of a turn."))
      .finally(() => {
        turn.busy = false;
      });
  }

  #end(key: string): void {
    const turn = this.#turns.get(key);
    if (!turn) return;
    this.#turns.delete(key);
    turn.ended = true;
    turn.cancel?.();
    this.#remove(turn);
  }

  #remove(turn: RunningTurn): void {
    const { message } = turn;
    if (!message) return;
    turn.message = null;
    void Effect.runPromise(this.#options.remove(message.chat, message.id)).catch(() =>
      logger.warn("Telegram could not delete the status of a turn."),
    );
  }

  /** The line that the agent works, with the minutes from the second minute, its note and its step. */
  #text(turn: RunningTurn): string {
    const language = this.#options.language();
    const t = sourceTranslateFor(language);
    const minutes = Math.floor((this.#now() - turn.startedAt) / 60_000);
    const head =
      minutes < 1
        ? t("status.messaging.telegramWorking")
        : t("status.messaging.telegramWorkingFor", { minutes: String(minutes) });
    const note = lead(this.#options.note(turn.agentId, turn.threadId, turn.turnId) ?? "", NOTE_CHARACTERS);
    const step = turn.step === null ? "" : lead(localizeSourceText(turn.step, language), STEP_CHARACTERS);
    return [`⏳ ${head}`, note, step === note ? "" : step]
      .filter((line) => line !== "")
      .map((line) => redactText(maskEmails(line)))
      .join("\n");
  }
}

/**
 * The last paragraph of a note as one plain line, cut to `size` characters: a note grows while the
 * agent works, so its end is what the agent does now. Code blocks and Markdown marks are left out.
 */
function lead(text: string, size: number): string {
  const paragraphs = text
    .replace(/```[\s\S]*?(```|$)/gu, " ")
    .split(/\n{2,}/u)
    .map((paragraph) =>
      paragraph
        .replace(/^#{1,6}\s+/gmu, "")
        .replace(/\*\*|__|`/gu, "")
        .replace(/\s+/gu, " ")
        .trim(),
    )
    .filter((paragraph) => paragraph !== "");
  const letters = Array.from(paragraphs.at(-1) ?? "");
  return letters.length > size
    ? `${letters
        .slice(0, size - 1)
        .join("")
        .trimEnd()}…`
    : letters.join("");
}
