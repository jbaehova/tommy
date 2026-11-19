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
  it("gives a turn to the owner's chat only through the owner's message, its own requests, or a routine", async () => {
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
      const local = { ...human, senderMember: { id: "local", name: "Local" } };
      await deliver(local, "local-turn");
      // A request that agent a sent in its owner turn, as send_message keys it.
      const request = {
        sender: { kind: "agent" as const, agentId: "a" },
        recipientAgentIds: ["b"],
        text: "Help",
        idempotencyKey: "send_message:thread-a:user-turn:call-1",
      };
      const requestId = await deliver(request, "peer-turn");
      await deliver(
        { ...request, idempotencyKey: "send_message:thread-a:local-turn:call-2", text: "Private help" },
        "private-peer-turn",
      );
      const answer = {
        sender: { kind: "agent" as const, agentId: "b" },
        recipientAgentIds: ["a"],
        text: "Done",
        replyToMessageId: requestId,
        expectsReply: false,
      };
      await deliver(answer, "synthesis");
      await deliver({ ...answer, idempotencyKey: "relay:mixed" }, "mixed");
      await deliver({ ...local, text: "Also this" }, "mixed");
      await deliver({ ...answer, sender: { kind: "agent", agentId: "c" }, idempotencyKey: "relay:foreign" }, "foreign");
      await deliver(
        {
          sender: {
            kind: "routine",
            routineId: "routine-1",
            runId: "run-1",
            routineName: "Briefing",
            scheduledFor: "2026-11-19T10:00:00.000Z",
          },
          recipientAgentIds: ["a"],
          text: "Write the briefing",
        },
        "routine-turn",
      );
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
          deleteAgent: unused,
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

      expect(mailbox.telegramOriginsForTurn("a", "user-turn")).toEqual([
        { senderId: senderMember.id, messageId: rootMessageId },
      ]);
      expect(inspect("a", "user-turn", 10)).toBe(true);
      expect(inspect("a", "user-turn", 10, 21)).toBe(false);
      expect(inspect("a", "user-turn", 11)).toBe(false);
      expect(host.ownsTurn("a", "user-turn", 10, 20)).toBe(true);
      expect(host.ownsTurn("a", "local-turn", 10, 20)).toBe(false);

      // The answer to a's own request belongs to the turn that asked, so its result reaches the owner.
      expect(mailbox.telegramOriginsForTurn("a", "synthesis")).toEqual([{ answerToTurnId: "user-turn" }]);
      expect(host.ownsTurn("a", "synthesis", 10, 20)).toBe(true);
      expect(inspect("a", "synthesis", 10)).toBe(true);
      // Any teammate's answer to a's request counts; a turn that also reads a local message does not.
      expect(host.ownsTurn("a", "foreign", 10, 20)).toBe(true);
      for (const turnId of ["mixed", "unknown"]) {
        expect(host.ownsTurn("a", turnId, 10, 20), turnId).toBe(false);
        expect(inspect("a", turnId, 10), turnId).toBe(false);
      }

      // Work delegated inside Tommy is traced to the owner's chat for browser requests only. Its answer
      // goes back to agent a, never straight to Telegram.
      expect(mailbox.telegramOriginsForTurn("b", "peer-turn")).toEqual([
        { requestFrom: { agentId: "a", turnId: "user-turn" } },
      ]);
      expect(host.tracedChat("b", "peer-turn", 20)).toBe(10);
      expect(host.tracedChat("b", "peer-turn", 21)).toBeNull();
      expect(host.tracedChat("b", "private-peer-turn", 20)).toBeNull();
      expect(host.ownsTurn("b", "peer-turn", 10, 20)).toBe(false);
      expect(host.ownsTurn("b", "peer-turn", 11, 20)).toBe(false);
      expect(inspect("b", "peer-turn", 11)).toBe(false);
      const peerResult = await runCauseEffect(
        host.readReply({
          agentId: "b",
          turnId: "peer-turn",
          threadId: "private",
          telegramId: 11,
          ownerId: 20,
          status: "failed",
        }),
      );
      expect(peerResult).toBeNull();

      // A routine result goes to the agent's own chat, and only while the agent has one.
      expect(host.routineTurn("a", "routine-turn")).toBe(true);
      expect(host.routineTurn("a", "user-turn")).toBe(false);
      expect(host.ownsTurn("a", "routine-turn", 10, 20)).toBe(false);
      host.setRoutineChat((id) => (id === "a" ? { telegramId: 10, ownerId: 20 } : null));
      expect(host.ownsTurn("a", "routine-turn", 10, 20)).toBe(true);
      expect(host.ownsTurn("a", "routine-turn", 11, 20)).toBe(false);
      host.setRoutineChat(() => null);
      expect(host.ownsTurn("a", "routine-turn", 10, 20)).toBe(false);

      active.delete(10);
      expect(inspect("a", "user-turn", 10)).toBe(false);
      active.set(10, "a");
      agents.splice(0, 1);
      expect(inspect("a", "user-turn", 10)).toBe(false);
      expect(host.ownsTurn("a", "user-turn", 10, 20)).toBe(false);
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
