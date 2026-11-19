import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary, AttachmentSummary } from "@tommy/contracts/ipc";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runCauseEffect } from "../backend/effect-boundary";
import { MailboxStore } from "../backend/mailbox-store";
import { SidebarLayoutStore } from "../backend/sidebar-layout-store";
import { TommyDatabase } from "../backend/tommy-database";
import { TelegramAgentHost } from "./telegram-agent-host";
import { readTelegramImage } from "./telegram-agent-media";

function agent(id: string): AgentSummary {
  return {
    id,
    name: id,
    title: "",
    description: "",
    notifications: true,
    provider: "codex",
    model: "example-model",
    reasoningEffort: "medium",
    threadId: null,
    workspacePath: "/example",
    preview: "",
    updatedAt: null,
    avatarSeed: id,
    avatarHue: null,
    avatarUrl: null,
  };
}

describe("Telegram agent reply authorization", () => {
  it("identifies only the original agent's requested reply across restart and preserves mixed turn provenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tommy-telegram-owner-"));
    const database = new TommyDatabase(directory);
    let mailbox = new MailboxStore(directory, join(directory, "shared"), database);
    async function deliver(input: Parameters<MailboxStore["enqueue"]>[0], turnId: string, complete = true) {
      const receipt = await runCauseEffect(mailbox.enqueue(input));
      for (const { id } of receipt.deliveries) {
        await runCauseEffect(mailbox.markStarting(id));
        await runCauseEffect(mailbox.markRunning(id, turnId));
        if (complete) await runCauseEffect(mailbox.markTerminal(id, "completed"));
      }
      return receipt.messageId;
    }
    try {
      await runCauseEffect(mailbox.initialize());
      const senderMember = { id: "telegram:10:20", name: "Telegram" };
      const human = { sender: { kind: "user" as const }, senderMember, text: "Ask for help", recipientAgentIds: ["a"] };
      const rootMessageId = await deliver(human, "user-turn");
      const unrelated = await deliver(human, "other-turn");
      const telegramExchange = { ownerId: 20, rootTelegramId: 10, rootMessageId, depth: 1 };
      const request = {
        sender: { kind: "agent" as const, agentId: "a" },
        recipientAgentIds: ["b"],
        text: "Help",
        telegramExchange,
      };
      const requestId = await deliver(request, "peer-turn");
      await deliver({ ...request, expectsReply: false }, "pending-task", false);
      const local = { ...human, senderMember: { id: "local", name: "Local" } };
      const localMessageId = await deliver(local, "local-root");
      const wrongRecipient = await deliver({ ...human, recipientAgentIds: ["c"] }, "wrong-recipient");
      const mixedRoot = await deliver(human, "mixed-root");
      await deliver(local, "mixed-root");
      for (const [id, turnId] of [
        [localMessageId, "forged-owner"],
        [wrongRecipient, "forged-recipient"],
        [mixedRoot, "foreign-root-input"],
      ] as const) {
        await deliver({ ...request, telegramExchange: { ...telegramExchange, rootMessageId: id } }, turnId);
      }
      await deliver({ ...request, sender: { kind: "agent", agentId: "c" } }, "forged-delegator");
      await deliver({ ...request, replyToMessageId: unrelated }, "unrelated-request");
      await deliver(request, "mixed-private");
      await deliver({ ...local, recipientAgentIds: ["b"] }, "mixed-private");
      await deliver(request, "mixed-roots");
      await deliver({ ...request, telegramExchange: { ...telegramExchange, rootMessageId: unrelated } }, "mixed-roots");
      const answer = {
        sender: { kind: "agent" as const, agentId: "b" },
        recipientAgentIds: ["a"],
        text: "Done",
        replyToMessageId: requestId,
        expectsReply: false,
        telegramExchange: { ...telegramExchange, depth: 2 },
      };
      await deliver(answer, "synthesis");
      await deliver({ ...answer, telegramExchange: { ...answer.telegramExchange, rootMessageId: unrelated } }, "stale");
      await deliver({ ...answer, sender: { kind: "agent", agentId: "c" } }, "foreign");
      await deliver({ ...answer, recipientAgentIds: ["a", "c"] }, "broadcast");
      await deliver({ ...answer, replyToMessageId: null }, "unsolicited");
      await deliver(answer, "mixed");
      await deliver({ ...human, senderMember: { id: "local", name: "Local" } }, "mixed");
      database.close();
      mailbox = new MailboxStore(directory, join(directory, "shared"), database);
      await runCauseEffect(mailbox.initialize());
      const agents = [agent("a"), agent("b"), agent("c")];
      const unused = (): never => {
        throw new Error("Unexpected service call");
      };
      const host = new TelegramAgentHost(
        {
          listAgents: () => agents,
          saveProfile: unused,
          sendMessage: unused,
          prepareImportedAttachments: unused,
          on: unused,
          off: unused,
        },
        new SidebarLayoutStore(join(directory, "layout.json")),
        mailbox,
        database,
      );
      const active = new Map([
        [10, "a"],
        [11, "b"],
      ]);
      const binding = (id: number) => active.get(id) ?? null;
      const inspect = (agentId: string, turnId: string, telegramId: number, ownerId = 20) =>
        host.canInspectTurn(agentId, turnId, telegramId, ownerId, binding);
      expect(inspect("a", "user-turn", 10)).toBe(true);
      expect(inspect("a", "synthesis", 10)).toBe(true);
      expect(inspect("b", "peer-turn", 11)).toBe(true);
      expect(inspect("b", "pending-task", 11)).toBe(true);
      expect(host.ownsTurn("a", "synthesis", 10, 20)).toBe(true);
      expect(host.ownsTurn("b", "peer-turn", 11, 20)).toBe(false);
      const privateResult = await runCauseEffect(
        host.readReply({
          agentId: "b",
          turnId: "peer-turn",
          threadId: "private",
          telegramId: 11,
          ownerId: 20,
          status: "failed",
        }),
      );
      expect(privateResult).toBeNull();
      for (const turnId of [
        "forged-owner",
        "forged-recipient",
        "foreign-root-input",
        "forged-delegator",
        "unrelated-request",
        "mixed-private",
        "mixed-roots",
        "unknown",
      ]) {
        expect(inspect("b", turnId, 11), turnId).toBe(false);
      }
      expect(inspect("b", "peer-turn", 11, 21)).toBe(false);
      expect(inspect("b", "peer-turn", 10)).toBe(false);
      for (const turnId of ["stale", "foreign", "broadcast", "unsolicited", "mixed", "mixed-root"])
        expect(inspect("a", turnId, 10), turnId).toBe(false);
      active.delete(10);
      expect(inspect("a", "user-turn", 10)).toBe(false);
      expect(inspect("b", "peer-turn", 11)).toBe(false);
      active.set(10, "c");
      expect(inspect("b", "peer-turn", 11)).toBe(false);
      active.set(10, "a");
      active.delete(11);
      expect(inspect("b", "peer-turn", 11)).toBe(false);
      active.set(11, "b");
      agents.splice(0, 1);
      expect(inspect("b", "peer-turn", 11)).toBe(false);
      expect(mailbox.telegramExchangeOriginsForTurn("a", "user-turn")).toEqual([
        { senderId: senderMember.id, messageId: rootMessageId },
      ]);
      expect(mailbox.telegramExchangeOriginsForTurn("a", "synthesis")).toEqual([
        { exchange: answer.telegramExchange, replyToOwnRequest: true },
      ]);
      for (const turnId of ["stale", "foreign", "broadcast", "unsolicited"]) {
        expect(mailbox.telegramExchangeOriginsForTurn("a", turnId)).not.toContainEqual(
          expect.objectContaining({ replyToOwnRequest: true }),
        );
      }
      expect(mailbox.telegramExchangeOriginsForTurn("b", "peer-turn")).toEqual([
        { exchange: telegramExchange, delegatedByRootAgentId: "a" },
      ]);
      expect(mailbox.telegramExchangeOriginsForTurn("a", "mixed")).toHaveLength(2);
      expect(mailbox.telegramExchangeOriginsForTurn("a", "mixed")).toContainEqual(
        expect.objectContaining({ senderId: "local" }),
      );
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("sends only bytes pinned to the generated PNG in the selected thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tommy-telegram-image-"));
    const path = join(directory, "image.png");
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kx6kAAAAASUVORK5CYII=",
      "base64",
    );
    const digest = createHash("sha256").update(bytes).digest("hex");
    const mailbox = {
      generatedImageDigest: (id: string, agentId: string, threadId: string) =>
        id === "picture" && agentId === "a" && threadId === "t" ? digest : null,
      resolveAttachment: () => Effect.succeed({ path, mimeType: "image/png", name: "image.png" }),
    };
    const attachment: AttachmentSummary = {
      id: "picture",
      name: "image.png",
      kind: "image",
      mimeType: "image/png",
      size: bytes.length,
      previewKind: "image",
      previewUrl: "",
    };
    try {
      await writeFile(path, bytes);
      expect(await runCauseEffect(readTelegramImage(mailbox, "a", "t", attachment))).toEqual(bytes);
      expect(await runCauseEffect(readTelegramImage(mailbox, "other", "t", attachment))).toBeNull();
      expect(await runCauseEffect(readTelegramImage(mailbox, "a", "other", attachment))).toBeNull();
      const changed = Buffer.from(bytes);
      changed[changed.length - 1] = 0;
      await writeFile(path, changed);
      expect(await runCauseEffect(readTelegramImage(mailbox, "a", "t", attachment))).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
