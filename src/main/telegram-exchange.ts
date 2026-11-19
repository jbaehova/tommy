import { randomBytes } from "node:crypto";
import { expandAttachmentReferences } from "@tommy/contracts/attachment-references";
import { INPUT_LIMITS } from "@tommy/contracts/input-limits";
import { sourceText } from "@tommy/i18n/source";
import { redactText } from "@tommy/logging";
import { Deferred, Effect } from "effect";
import type { TelegramExchangeGate } from "../backend/agent/telegram-exchange-gate";
import { ToolOperationFailed } from "../backend/agent/tool-operation";
import { TELEGRAM_EXCHANGE_DEPTH_LIMIT } from "../backend/mailbox-store";

interface Participant {
  id: number;
  username: string;
  active: boolean;
}

interface TelegramExchangeOptions<Failure> {
  ownerId: number;
  bindingForAgent(agentId: string): Participant | null;
  send(senderId: number, chat: number | string, text: string): Effect.Effect<void, Failure>;
}

interface ExpectedDelivery {
  senderId: number;
  recipientId: number;
  arrived: Deferred.Deferred<void, ToolOperationFailed>;
}

const SENDS_PER_MINUTE = 30;
const DELIVERY_TIMEOUT_MS = 15_000;

function unavailable(): ToolOperationFailed {
  return new ToolOperationFailed({ cause: new Error(sourceText("error.messaging.telegramExchangeUnavailable")) });
}

function limitReached(): ToolOperationFailed {
  return new ToolOperationFailed({ cause: new Error(sourceText("error.messaging.telegramExchangeLimit")) });
}

/** A path may contain unquoted spaces. Hide the rest of that line if it contains a path. */
function taskExcerpt(text: string): string {
  const withoutFiles = expandAttachmentReferences(redactText(text), () => "[attachment]");
  const lines = withoutFiles.replaceAll("\r", "").split("\n");
  const excerpt = lines
    .map((line) => {
      let start = line.search(/[\\/]/u);
      if (start < 0) return line;
      while (start > 0 && !/\s/u.test(line.charAt(start - 1))) start--;
      return `${line.slice(0, start)}[path]`;
    })
    .join("\n")
    .trim();
  // Telegram allows 4,096 characters. Leave space for the delivery reference.
  return Array.from(excerpt).slice(0, 1900).join("");
}

/**
 * Each peer receives the task excerpt and a one-use reference. Only its authenticated webhook
 * can release the complete local task and its attachments.
 * A late reference after cancellation or restart cannot enqueue anything.
 */
export class TelegramExchange<Failure> {
  readonly #options: TelegramExchangeOptions<Failure>;
  readonly #pending = new Map<string, ExpectedDelivery>();
  readonly #introduced = new Set<string>();
  #sentAt: number[] = [];
  #closed = false;

  constructor(options: TelegramExchangeOptions<Failure>) {
    this.#options = options;
  }

  readonly authorize: TelegramExchangeGate = Effect.fn("TelegramExchange.authorize")(function* (
    this: TelegramExchange<Failure>,
    senderAgentId: string,
    recipients: readonly string[],
    origins: Parameters<TelegramExchangeGate>[2],
    taskText: string,
  ) {
    const ownerId = this.#options.ownerId;
    const sender = this.#options.bindingForAgent(senderAgentId);
    if (this.#closed || !sender?.active || !origins.length) return yield* unavailable();
    const first = origins[0];
    const previous = first?.exchange;
    const rootTelegramId = previous?.rootTelegramId ?? sender.id;
    const rootMessageId = previous?.rootMessageId ?? first?.messageId;
    if (!rootMessageId) return yield* unavailable();
    let depth = 1;
    for (const origin of origins) {
      if (previous) {
        const inherited = origin.exchange;
        if (
          !inherited ||
          inherited.ownerId !== ownerId ||
          inherited.rootTelegramId !== rootTelegramId ||
          inherited.rootMessageId !== rootMessageId
        )
          return yield* unavailable();
        depth = Math.max(depth, inherited.depth + 1);
      } else if (origin.senderId !== `telegram:${sender.id}:${ownerId}` || !origin.messageId) {
        return yield* unavailable();
      }
    }
    if (
      depth > TELEGRAM_EXCHANGE_DEPTH_LIMIT ||
      !recipients.length ||
      recipients.length > INPUT_LIMITS.messageRecipients
    ) {
      return yield* limitReached();
    }
    const targets: { agentId: string; peer: Participant; introduce: boolean; pair: string }[] = [];
    for (const agentId of recipients) {
      const peer = this.#options.bindingForAgent(agentId);
      if (!peer?.active || peer.id === sender.id) return yield* unavailable();
      const pair = `${sender.id}:${peer.id}`;
      targets.push({ agentId, peer, pair, introduce: !this.#introduced.has(pair) });
    }
    const now = Date.now();
    this.#sentAt = this.#sentAt.filter((at) => now - at < 60_000);
    const sends = targets.length + targets.filter((target) => target.introduce).length;
    if (this.#sentAt.length + sends > SENDS_PER_MINUTE) return yield* limitReached();
    for (let index = 0; index < sends; index++) this.#sentAt.push(now);
    const excerpt = taskExcerpt(taskText);
    yield* Effect.forEach(
      targets,
      ({ agentId, peer, pair, introduce }) =>
        Effect.gen({ self: this }, function* () {
          if (introduce) {
            // A username can move to a different account. Only a content-free challenge uses it.
            yield* this.#confirm(
              sender.id,
              peer.id,
              `@${peer.username}`,
              `Tommy peer ${randomBytes(24).toString("hex")}`,
            );
            if (this.#introduced.size >= 256) this.#introduced.clear();
            this.#introduced.add(pair);
          }
          if (!this.#active(senderAgentId, sender.id) || !this.#active(agentId, peer.id)) return yield* unavailable();
          yield* this.#confirm(
            sender.id,
            peer.id,
            peer.id,
            `Tommy relay ${randomBytes(24).toString("hex")}\n${excerpt}`.trimEnd(),
          );
        }),
      {
        concurrency: "unbounded",
        discard: true,
      },
    );
    // Either peer can be disconnected or rebound while a request is in transit.
    if (!this.#active(senderAgentId, sender.id)) return yield* unavailable();
    for (const { agentId, peer } of targets) {
      if (!this.#active(agentId, peer.id)) return yield* unavailable();
    }
    return { ownerId, rootMessageId, rootTelegramId, depth };
  }).bind(this);

  #active(agentId: string, id: number): boolean {
    const current = this.#options.bindingForAgent(agentId);
    return !this.#closed && current?.id === id && current.active;
  }

  /** The webhook handler has checked Telegram's secret, the private chat type and from.is_bot. */
  receive(recipientId: number, senderId: number, chatId: number, text: string): boolean {
    const delivery = this.#pending.get(text);
    if (!delivery || senderId !== chatId || senderId !== delivery.senderId || recipientId !== delivery.recipientId)
      return false;
    this.#pending.delete(text);
    Deferred.doneUnsafe(delivery.arrived, Effect.void);
    return true;
  }

  close(): void {
    this.#closed = true;
    for (const { arrived } of this.#pending.values()) Deferred.doneUnsafe(arrived, Effect.fail(unavailable()));
    this.#pending.clear();
  }

  readonly #confirm = Effect.fn("TelegramExchange.confirm")(function* (
    this: TelegramExchange<Failure>,
    senderId: number,
    recipientId: number,
    chat: number | string,
    text: string,
  ) {
    const arrived = Deferred.makeUnsafe<void, ToolOperationFailed>();
    this.#pending.set(text, { senderId, recipientId, arrived });
    yield* this.#options
      .send(senderId, chat, text)
      .pipe(
        Effect.mapError(unavailable),
        Effect.andThen(Deferred.await(arrived)),
        Effect.interruptible,
        Effect.timeoutOrElse({ duration: DELIVERY_TIMEOUT_MS, orElse: () => Effect.fail(unavailable()) }),
        Effect.ensuring(Effect.sync(() => this.#pending.delete(text))),
      );
  });
}
