import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { AgentTelegramExchange } from "../backend/agent/telegram-exchange-gate";
import { runCauseEffect } from "../backend/effect-boundary";
import { MailboxStore } from "../backend/mailbox-store";
import { TommyDatabase } from "../backend/tommy-database";
import { TelegramExchange } from "./telegram-exchange";

const owner = 7;
const first = { id: 101, username: "first_example_bot", active: true };
const second = { id: 202, username: "second_example_bot", active: true };
const rootMessageId = "owner-request";
const source = [{ senderId: `telegram:${first.id}:${owner}`, messageId: rootMessageId }];
const task =
  "Prepare a report.\nPassword: example-secret\nRead /Users/user/private folder.\nUse @[a.png](attachment:example-id).";

function fixture() {
  const peers = new Map([
    ["a", first],
    ["b", second],
  ]);
  const sent = Deferred.makeUnsafe<string>();
  const intro = Deferred.makeUnsafe<string>();
  const exchange = new TelegramExchange({
    ownerId: owner,
    bindingForAgent: (agentId) => peers.get(agentId) ?? null,
    send: (sender, chat, text) =>
      Effect.sync(() => {
        expect(sender).toBe(first.id);
        if (chat === `@${second.username}`) {
          expect(text).toMatch(/^Tommy peer [0-9a-f]{48}$/u);
          Deferred.doneUnsafe(intro, Effect.succeed(text));
          return;
        }
        expect(chat).toBe(second.id);
        Deferred.doneUnsafe(sent, Effect.succeed(text));
      }),
  });
  return {
    exchange,
    peers,
    intro: Effect.runPromise(Deferred.await(intro)),
    sent: Effect.runPromise(Deferred.await(sent)),
  };
}

describe("Telegram peer delivery", () => {
  it("releases one handoff only for the expected recipient, sender, private chat and reference", async () => {
    const { exchange, intro, sent } = fixture();
    const result = Effect.runPromise(exchange.authorize("a", ["b"], source, task));
    const challenge = await intro;
    expect(exchange.receive(999, first.id, first.id, challenge)).toBe(false);
    expect(exchange.receive(second.id, first.id, first.id, challenge)).toBe(true);
    const reference = await sent;
    expect(reference).toContain("Prepare a report.");
    expect(reference).not.toContain("example-secret");
    expect(reference).not.toContain("/Users/user");
    expect(reference).not.toContain("private folder");
    expect(reference).not.toContain("a.png");
    expect(reference).not.toContain("example-id");

    expect(exchange.receive(first.id, second.id, second.id, reference)).toBe(false);
    expect(exchange.receive(second.id, first.id, -1000, reference)).toBe(false);
    expect(exchange.receive(second.id, first.id, first.id, `${reference}!`)).toBe(false);
    expect(exchange.receive(second.id, first.id, first.id, reference)).toBe(true);
    expect(exchange.receive(second.id, first.id, first.id, reference)).toBe(false);
    await expect(result).resolves.toEqual({ ownerId: owner, rootTelegramId: first.id, rootMessageId, depth: 1 });
  });

  it("checks the binding again after the receipt", async () => {
    const { exchange, peers, intro, sent } = fixture();
    const result = Effect.runPromise(Effect.result(exchange.authorize("a", ["b"], source, task)));
    exchange.receive(second.id, first.id, first.id, await intro);
    const reference = await sent;
    peers.delete("b");
    exchange.receive(second.id, first.id, first.id, reference);
    expect((await result)._tag).toBe("Failure");
  });

  it("expires a missing receipt and refuses its later replay", async () => {
    const { exchange, intro } = fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        const run = yield* Effect.forkChild(Effect.result(exchange.authorize("a", ["b"], source, task)));
        const text = yield* Effect.promise(() => intro);
        yield* TestClock.adjust("16 seconds");
        expect((yield* Fiber.join(run))._tag).toBe("Failure");
        expect(exchange.receive(second.id, first.id, first.id, text)).toBe(false);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  it("rejects other owners, unrelated work in the turn and exchanges past the hop limit", async () => {
    const { exchange } = fixture();
    for (const origins of [
      [{ senderId: "telegram:101:999" }],
      [...source, {}],
      [{ exchange: { ownerId: 999, depth: 1, rootTelegramId: first.id, rootMessageId } }],
      [{ exchange: { ownerId: owner, depth: 8, rootTelegramId: first.id, rootMessageId } }],
    ]) {
      expect((await Effect.runPromise(Effect.result(exchange.authorize("a", ["b"], origins, task))))._tag).toBe(
        "Failure",
      );
    }
  });

  it("cancels in-flight receipts during shutdown; stale messages cannot authorize a later task", async () => {
    const { exchange, intro } = fixture();
    const result = Effect.runPromise(Effect.result(exchange.authorize("a", ["b"], source, task)));
    const reference = await intro;
    exchange.close();
    expect((await result)._tag).toBe("Failure");
    expect(exchange.receive(second.id, first.id, first.id, reference)).toBe(false);
  });

  it("returns a failed peer startup only after the recipient confirms the safe notice", async () => {
    const path = await mkdtemp(join(tmpdir(), "tommy-telegram-failure-"));
    const database = new TommyDatabase(path);
    const mailbox = new MailboxStore(path, join(path, "shared"), database);
    try {
      await runCauseEffect(mailbox.initialize());
      const ownerRequest = await runCauseEffect(
        mailbox.enqueue({
          sender: { kind: "user" },
          senderMember: { id: `telegram:${second.id}:${owner}`, name: "Telegram" },
          recipientAgentIds: ["b"],
          text: "Prepare a report",
        }),
      );
      const request = await runCauseEffect(
        mailbox.enqueue({
          sender: { kind: "agent", agentId: "b" },
          recipientAgentIds: ["a"],
          text: "Prepare a report",
          telegramExchange: {
            ownerId: owner,
            rootTelegramId: second.id,
            rootMessageId: ownerRequest.messageId,
            depth: 1,
          },
        }),
      );
      const delivery = request.deliveries[0];
      if (!delivery) throw new Error("Missing test delivery");
      await runCauseEffect(mailbox.markStarting(delivery.id));
      await runCauseEffect(mailbox.markTerminal(delivery.id, "failed", "failed /Users/user/private folder"));
      const { exchange, intro, sent } = fixture();
      const gate = new AgentTelegramExchange(mailbox);
      gate.gate = exchange.authorize;
      const reply = runCauseEffect(
        mailbox.answerFailedRequest(
          delivery.id,
          () => true,
          () => true,
          gate.confirmFailure,
        ),
      );
      const early = reply.then(() => {
        throw new Error("The mailbox completed before its peer confirmed delivery.");
      });
      exchange.receive(second.id, first.id, first.id, await Promise.race([intro, early]));
      const notice = await sent;
      expect(notice).toContain("could not complete the task");
      expect(notice).not.toContain("private folder");
      expect(mailbox.hasReplyFrom("a", request.messageId)).toBe(false);
      exchange.receive(second.id, first.id, first.id, notice);
      expect(await reply).toBe("b");
      expect(mailbox.hasReplyFrom("a", request.messageId)).toBe(true);
      expect(
        await runCauseEffect(
          mailbox.answerFailedRequest(
            delivery.id,
            () => true,
            () => true,
            gate.confirmFailure,
          ),
        ),
      ).toBeNull();
    } finally {
      database.close();
      await rm(path, { recursive: true, force: true });
    }
  });
});
