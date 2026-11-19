import { randomBytes } from "node:crypto";
import type { sourceText } from "@tommy/i18n/source";
import { Effect, Result } from "effect";
import type { TelegramDirectory } from "./telegram-directory";

interface Confirmation {
  id: number;
  operationId: string;
  username: string;
  updateId: number;
  code: string;
  expires: number;
}

/** Each instance belongs to one manager. Its caller admits only the owner's authenticated private chat. */
export class TelegramDisconnect {
  #confirmation: Confirmation | null = null;

  constructor(private readonly directory: Pick<TelegramDirectory, "get" | "list" | "revoke">) {}

  readonly handle = Effect.fn("TelegramDisconnect.handle")(function* (
    this: TelegramDisconnect,
    text: string,
    updateId: number,
    t: typeof sourceText,
  ) {
    const [command, target, code, extra] = text.trim().split(/\s+/u);
    if (command?.toLowerCase() !== "/disconnect") return null;
    if (!target || !/^@[A-Za-z0-9_]{1,32}$/.test(target) || extra) {
      return t("status.host.telegramDisconnectUsage");
    }
    const username = target.slice(1).toLowerCase();
    const matches = this.directory.list().filter((candidate) => candidate.username.toLowerCase() === username);
    if (matches.length > 1) return t("status.host.telegramDisconnectAmbiguous", { username });
    const binding = matches[0];
    if (!binding) return t("status.host.telegramDisconnectedAlready", { username });

    const now = Date.now();
    let pending = this.#confirmation;
    const current =
      pending !== null &&
      pending.expires > now &&
      pending.id === binding.id &&
      pending.operationId === binding.operationId &&
      pending.username === username;
    if (!code) {
      if (!current || pending?.updateId !== updateId) {
        pending = {
          id: binding.id,
          operationId: binding.operationId,
          username,
          updateId,
          code: randomBytes(8).toString("hex"),
          expires: now + 5 * 60_000,
        };
        this.#confirmation = pending;
      }
      return t("status.host.telegramDisconnectConfirm", { username, code: pending.code });
    }
    if (!current || !pending || code !== pending.code || updateId <= pending.updateId) {
      return t("status.host.telegramDisconnectExpired", { username });
    }

    const revoked = yield* Effect.result(this.directory.revoke(binding.id, updateId, binding.operationId));
    if (Result.isFailure(revoked)) {
      if (revoked.failure.code === "stale") return t("status.host.telegramDisconnectExpired", { username });
      return yield* revoked.failure;
    }
    if (this.directory.get(binding.id)) return t("status.host.telegramDisconnectExpired", { username });
    this.#confirmation = null;
    return t("status.host.telegramDisconnected", { username });
  }).bind(this);
}
