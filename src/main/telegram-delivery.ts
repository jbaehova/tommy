import { createHash } from "node:crypto";
import { createTommyLogger, redactText } from "@tommy/logging";
import { Effect, Result, Schema, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { readPreferenceFile, writePreferenceFile } from "./preference-file";
import type { TelegramAgentHost, TelegramAgentReply, TelegramReplyRef } from "./telegram-agent-host";
import type { TelegramApi, TelegramApiFailure } from "./telegram-api";
import { chatReady, type TelegramDirectory } from "./telegram-directory";
import { telegramHtml } from "./telegram-format";

const logger = createTommyLogger("telegram-delivery");
const textLimit = 4096;
const chunkLimit = 3500;
const keepReceiptMs = 24 * 60 * 60 * 1000;
// The owner can restart a parked delivery with /start after unblocking their agent.
const retryMs = [5_000, 30_000, 120_000, 600_000];
const id = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 ** 52 - 1 }));
const identifier = Schema.String.check(Schema.isBetweenLength(1, 512), Schema.isPattern(/^[^\p{Cc}]+$/u));
const nonnegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const refSchema = Schema.Struct({
  agentId: identifier,
  threadId: identifier,
  turnId: identifier,
  telegramId: id,
  ownerId: id,
  status: Schema.Literals(["completed", "failed", "cancelled"]),
});
const entrySchema = Schema.Struct({
  ref: refSchema,
  generation: Schema.String.check(Schema.isUUID(4)),
  offset: nonnegative,
  /** The next file to send after the text. Absent on an entry from before files were sent. */
  file: Schema.optionalKey(nonnegative),
  fileIds: Schema.optionalKey(Schema.Array(identifier)),
  attempts: nonnegative,
  next: Schema.NullOr(nonnegative),
});
const fileSchema = Schema.Struct({
  version: Schema.Literal(1),
  managerId: id,
  ownerId: id,
  pending: Schema.Array(entrySchema),
  delivered: Schema.Array(
    Schema.Struct({
      key: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      at: nonnegative,
    }),
  ),
});
const decode = Schema.decodeUnknownSync(fileSchema, { onExcessProperty: "error" });
type File = typeof fileSchema.Type;
type Entry = typeof entrySchema.Type;

export class TelegramDeliveryError extends Schema.TaggedError<TelegramDeliveryError>()("TelegramDeliveryError", {
  kind: Schema.Literals(["file", "identity", "closed"]),
}) {}

interface Options {
  path: string;
  managerId: number;
  managerToken: string;
  ownerId: number;
  directory: Pick<TelegramDirectory, "get">;
  agents: Pick<TelegramAgentHost, "readReply" | "ownsTurn">;
  api: Pick<TelegramApi, "getManagedBotToken" | "sendMessage" | "sendFile">;
  ready(): boolean;
}

function key(ref: TelegramReplyRef): string {
  return createHash("sha256")
    .update(JSON.stringify([ref.telegramId, ref.ownerId, ref.agentId, ref.threadId, ref.turnId]))
    .digest("hex");
}

/**
 * Prefer a line break, and leave room for the HTML that formatting adds. Do not split a UTF-16
 * surrogate pair at the Telegram message boundary.
 */
function nextChunk(text: string, offset: number) {
  let end = Math.min(text.length, offset + chunkLimit);
  if (end < text.length) {
    const cut = text.lastIndexOf("\n", end - 1);
    if (cut > offset + chunkLimit / 2) end = cut + 1;
  }
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
  return { text: text.slice(offset, end), end };
}

function temporary(failure: TelegramApiFailure) {
  return failure.status === 429 || failure.status >= 500 || (failure.kind !== "input" && failure.status === 0);
}

/**
 * Persist the turn address before attempting delivery. Reconstruct each part from the host's
 * authorized, completed turn. Telegram has no send idempotency key, so a lost response or a
 * crash before the progress write can repeat that one part. Previously committed parts stay sent.
 */
export class TelegramDelivery {
  readonly #options: Options;
  readonly #writes = Semaphore.makeUnsafe(1);
  #state: File | null = null;
  #closed = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #work: Promise<void> | null = null;

  constructor(options: Options) {
    this.#options = options;
  }

  readonly start = Effect.fn("TelegramDelivery.start")(function* (this: TelegramDelivery) {
    const { managerId, ownerId, path } = this.#options;
    yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        if (this.#closed) return yield* new TelegramDeliveryError({ kind: "closed" });
        if (this.#state) return;
        const loaded = yield* Effect.result(readPreferenceFile(path, decode));
        if (Result.isSuccess(loaded)) {
          const state = loaded.success;
          if (
            state.managerId !== managerId ||
            state.ownerId !== ownerId ||
            state.pending.some(({ ref }) => ref.ownerId !== ownerId)
          ) {
            return yield* new TelegramDeliveryError({ kind: "identity" });
          }
          const keys = state.pending.map(({ ref }) => key(ref));
          if (new Set(keys).size !== keys.length) return yield* new TelegramDeliveryError({ kind: "file" });
          this.#state = state;
        } else if (isMissingFileError(loaded.failure.cause)) {
          this.#state = { version: 1, managerId, ownerId, pending: [], delivered: [] };
        } else return yield* new TelegramDeliveryError({ kind: "file" });
      }),
    );
    this.#schedule();
  }).bind(this);

  readonly enqueue = Effect.fn("TelegramDelivery.enqueue")(function* (
    this: TelegramDelivery,
    reply: TelegramAgentReply,
  ) {
    const { agentId, threadId, turnId, telegramId, ownerId, status } = reply;
    const ref: TelegramReplyRef = { agentId, threadId, turnId, telegramId, ownerId, status };
    const record = this.#options.directory.get(telegramId);
    if (!chatReady(record) || !this.#allowed(ref, record.operationId)) return;
    const receipt = key(ref);
    const fileIds = reply.files.flatMap((file) => (file.attachmentId ? [file.attachmentId] : []));
    yield* this.#change((state) => {
      if (
        state.pending.some((item) => key(item.ref) === receipt) ||
        state.delivered.some((item) => item.key === receipt)
      )
        return state;
      return {
        ...state,
        pending: [
          ...state.pending,
          {
            ref,
            generation: record.operationId,
            offset: 0,
            attempts: 0,
            next: 0,
            ...(fileIds.length === reply.files.length ? { fileIds } : {}),
          },
        ],
      };
    });
    this.#schedule();
  }).bind(this);

  readonly retryChat = Effect.fn("TelegramDelivery.retryChat")(function* (this: TelegramDelivery, telegramId: number) {
    yield* this.#change((state) =>
      state.pending.some((e) => e.ref.telegramId === telegramId && e.next === null)
        ? {
            ...state,
            pending: state.pending.map((e) =>
              e.ref.telegramId === telegramId && e.next === null ? { ...e, next: 0, attempts: 0 } : e,
            ),
          }
        : state,
    );
    this.#schedule();
  }).bind(this);

  readonly stop = Effect.fn("TelegramDelivery.stop")(function* (this: TelegramDelivery) {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#work) yield* Effect.promise(() => this.#work ?? Promise.resolve());
    yield* this.#writes.withPermit(Effect.void);
  }).bind(this);

  #change(change: (state: File) => File) {
    return this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        if (!this.#state) return yield* new TelegramDeliveryError({ kind: "closed" });
        const state = change(this.#state);
        if (state === this.#state) return;
        const next = { ...state, delivered: state.delivered.filter((item) => item.at > Date.now() - keepReceiptMs) };
        yield* writePreferenceFile(this.#options.path, next, { createDirectory: true }).pipe(
          Effect.mapError(() => new TelegramDeliveryError({ kind: "file" })),
        );
        this.#state = next;
      }).pipe(Effect.uninterruptible),
    );
  }

  #allowed(ref: TelegramReplyRef, generation: string, queued = false) {
    const { directory, agents, ownerId } = this.#options;
    const bot = directory.get(ref.telegramId);
    return (
      !this.#closed &&
      ownerId === ref.ownerId &&
      chatReady(bot) &&
      bot.agentId === ref.agentId &&
      bot.operationId === generation &&
      agents.ownsTurn(ref.agentId, ref.turnId, ref.telegramId, ref.ownerId, queued ? generation : undefined)
    );
  }

  #schedule(minimumDelay = 0) {
    if (this.#closed || !this.#state || this.#work) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    let next = Infinity;
    for (const item of this.#state.pending) if (item.next !== null) next = Math.min(next, item.next);
    if (!Number.isFinite(next)) return;
    const delay = Math.max(minimumDelay, next - Date.now(), this.#options.ready() ? 0 : 2_000);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const entry = this.#state?.pending.find((item) => item.next !== null && item.next <= Date.now());
      if (!entry || !this.#options.ready()) {
        this.#schedule();
        return;
      }
      let backoff = 0;
      this.#work = Effect.runPromise(this.#part(entry))
        .catch(() => {
          backoff = 5_000;
          logger.warn("Could not update the Telegram delivery queue.");
        })
        .finally(() => {
          this.#work = null;
          this.#schedule(backoff);
        });
    }, delay);
    this.#timer.unref();
  }

  #update(entry: Entry, update: Entry | null, delivered: boolean) {
    const receipt = key(entry.ref);
    return this.#change((state) => ({
      ...state,
      pending: state.pending.flatMap((item) => (key(item.ref) === receipt ? (update ? [update] : []) : [item])),
      delivered: delivered ? [...state.delivered, { key: receipt, at: Date.now() }] : state.delivered,
    }));
  }

  readonly #part = Effect.fn("TelegramDelivery.part")(function* (this: TelegramDelivery, entry: Entry) {
    const { api, agents, managerToken } = this.#options;
    const { ref } = entry;
    // A shutdown retains the cursor. A revoked or rebound destination loses it.
    if (this.#closed) return;
    if (!this.#allowed(ref, entry.generation, true)) return yield* this.#update(entry, null, false);
    const reply = yield* agents.readReply(ref, entry.generation);
    if (this.#closed) return;
    if (!reply || !this.#allowed(ref, entry.generation, true)) return yield* this.#update(entry, null, false);
    const files = entry.fileIds
      ? entry.fileIds.map((id) => reply.files.find((file) => file.attachmentId === id))
      : reply.files;
    const body = redactText(reply.text);
    const chunk = nextChunk(body, entry.offset);
    const hasText = entry.offset < body.length;
    const send = Effect.gen({ self: this }, function* () {
      // The root agent answers in the manager's own chat.
      const token =
        ref.telegramId === this.#options.managerId
          ? managerToken
          : yield* api.getManagedBotToken(managerToken, ref.telegramId);
      if (this.#closed || !this.#allowed(ref, entry.generation, true)) return false;
      if (hasText) {
        if (chunk.text.trim()) {
          // Formatted first. Telegram rejects HTML it cannot parse with 400: then send plain text.
          const html = telegramHtml(chunk.text);
          const rich =
            html.length <= textLimit
              ? yield* Effect.result(api.sendMessage(token, ref.ownerId, html, undefined, true))
              : null;
          if (rich === null || (Result.isFailure(rich) && rich.failure.kind === "api" && rich.failure.status === 400)) {
            if (this.#closed || !this.#allowed(ref, entry.generation, true)) return false;
            yield* api.sendMessage(token, ref.ownerId, chunk.text);
          } else if (Result.isFailure(rich)) return yield* Effect.fail(rich.failure);
        }
      } else {
        const file = files[entry.file ?? 0];
        if (file) yield* api.sendFile(token, ref.ownerId, file);
      }
      return true;
    });
    const sent = yield* Effect.result(send);
    if (Result.isFailure(sent)) {
      const delay = temporary(sent.failure) ? retryMs[entry.attempts] : undefined;
      yield* this.#update(
        entry,
        { ...entry, attempts: entry.attempts + 1, next: delay === undefined ? null : Date.now() + delay },
        false,
      );
      return;
    }
    if (!sent.success && this.#closed) return;
    if (!sent.success) return yield* this.#update(entry, null, false);
    const nextFile = hasText ? 0 : (entry.file ?? 0) + 1;
    const done = hasText ? chunk.end === body.length && files.length === 0 : nextFile >= files.length;
    yield* this.#update(
      entry,
      done ? null : { ...entry, offset: hasText ? chunk.end : entry.offset, file: nextFile, attempts: 0, next: 0 },
      done,
    );
  });
}
