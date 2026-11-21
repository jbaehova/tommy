// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramAgentReply } from "./telegram-agent-host";
import { TelegramApiFailure } from "./telegram-api";
import { TelegramDelivery } from "./telegram-delivery";
import type { TelegramConnection } from "./telegram-directory";

const folders: string[] = [];
const senders: TelegramDelivery[] = [];
afterEach(async () => {
  for (const sender of senders.splice(0)) await Effect.runPromise(sender.stop());
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function signal() {
  let notify = () => {};
  const promise = new Promise<void>((resolve) => {
    notify = resolve;
  });
  return { promise, notify };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "telegram-delivery-"));
  folders.push(dir);
  const path = join(dir, "queue.json");
  const managerId = 53;
  const ownerId = 73;
  const telegramId = 83;
  const managerToken = "unused-manager-credential";
  const reply: TelegramAgentReply = {
    agentId: "agent-one",
    threadId: "thread-one",
    turnId: "turn-one",
    telegramId,
    ownerId,
    status: "completed",
    text: "private output",
    files: [{ name: "report.pdf", mimeType: "application/pdf", bytes: Buffer.from("private image") }],
  };
  const binding: TelegramConnection = {
    id: telegramId,
    name: "Example",
    username: "example_bot",
    agentId: reply.agentId,
    operationId: randomUUID(),
    verified: true,
    ownerConfirmed: true,
  };
  const sent: string[] = [];
  const first = signal();
  const photo = signal();
  let ready = true;
  let owned = true;
  const config = {
    path,
    ownerId,
    managerId,
    managerToken,
    directory: { get: () => binding },
    agents: {
      ownsTurn: (agent: string, turn: string, bot: number, owner: number) =>
        owned && agent === reply.agentId && turn === reply.turnId && bot === telegramId && owner === ownerId,
      readReply: () => Effect.succeed(reply),
    },
    ready: () => ready,
    api: {
      getManagedBotToken: () => Effect.succeed("unused-agent-credential"),
      sendMessage: (_token: string, chat: string | number, text: string) =>
        Effect.sync(() => {
          expect(chat).toBe(ownerId);
          sent.push(text);
          first.notify();
        }),
      sendFile: (_token: string, chat: number, file: { bytes: Uint8Array }) =>
        Effect.sync(() => {
          expect(chat).toBe(ownerId);
          expect(file).toEqual(reply.files[0]);
          photo.notify();
        }),
    },
  };
  const create = (override: Partial<ConstructorParameters<typeof TelegramDelivery>[0]> = {}) => {
    const service = new TelegramDelivery({ ...config, ...override });
    senders.push(service);
    return service;
  };
  return {
    config,
    create,
    reply,
    binding,
    path,
    sent,
    first,
    photo,
    ready: (value: boolean) => {
      ready = value;
    },
    owned: (value: boolean) => {
      owned = value;
    },
  };
}

describe("Telegram reply delivery boundary", () => {
  it("stores only reply identifiers, resumes at an intact Unicode boundary and drops a duplicate completion", async () => {
    const f = await fixture();
    f.reply.text = `${"A".repeat(3499)}😀private answer`;
    const sender = f.create({
      api: {
        ...f.config.api,
        sendMessage: (token, chat, body) => {
          f.ready(false);
          return f.config.api.sendMessage(token, chat, body);
        },
      },
    });
    await Effect.runPromise(sender.start());
    await Effect.runPromise(sender.enqueue(f.reply));
    await f.first.promise;
    await Effect.runPromise(sender.stop());
    const file = await readFile(f.path, "utf8");
    expect(file).not.toContain("private");
    expect(file).not.toContain("unused-");
    expect(file).not.toContain("AAAA");
    expect(file).toContain('"offset":3499');
    expect(f.sent).toEqual(["A".repeat(3499)]);

    f.ready(true);
    const resumed = f.create();
    await Effect.runPromise(resumed.start());
    await f.photo.promise;
    await Effect.runPromise(resumed.enqueue(f.reply));
    await Effect.runPromise(resumed.stop());
    expect(f.sent).toEqual(["A".repeat(3499), "😀private answer"]);
    expect(await readFile(f.path, "utf8")).toContain('"pending":[]');
  });

  it("drops a revoked turn after token lookup, and rejects another manager's queue", async () => {
    const f = await fixture();
    const fetched = signal();
    const release = signal();
    const sender = f.create({
      api: {
        ...f.config.api,
        getManagedBotToken: () =>
          Effect.promise(async () => {
            fetched.notify();
            await release.promise;
            return "unused-token";
          }),
      },
    });
    await Effect.runPromise(sender.start());
    await Effect.runPromise(sender.enqueue({ ...f.reply, ownerId: f.reply.ownerId + 1 }));
    await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    await Effect.runPromise(sender.enqueue(f.reply));
    await fetched.promise;
    f.owned(false);
    release.notify();
    await vi.waitFor(async () => expect(await readFile(f.path, "utf8")).toContain('"pending":[]'));
    expect(f.sent).toEqual([]);
    const foreign = f.create({ managerId: f.config.managerId + 1 });
    const result = await Effect.runPromise(Effect.result(foreign.start()));
    expect(Result.isFailure(result) && result.failure.kind).toBe("identity");
  });

  it("checks the turn again before retrying a rejected formatted message as plain text", async () => {
    const f = await fixture();
    const rejected = signal();
    const sender = f.create({
      api: {
        ...f.config.api,
        sendMessage: (token, chat, body, _options, html) => {
          if (!html) return f.config.api.sendMessage(token, chat, body);
          f.owned(false);
          rejected.notify();
          return Effect.fail(new TelegramApiFailure({ kind: "api", status: 400 }));
        },
      },
    });
    await Effect.runPromise(sender.start());
    await Effect.runPromise(sender.enqueue(f.reply));
    await rejected.promise;
    await vi.waitFor(async () => expect(await readFile(f.path, "utf8")).toContain('"pending":[]'));
    expect(f.sent).toEqual([]);
  });

  it("holds an undeliverable reply until the owner reopens the chat and never sends it after rebinding", async () => {
    const f = await fixture();
    const sender = f.create({
      api: { ...f.config.api, sendMessage: () => Effect.fail(new TelegramApiFailure({ kind: "api", status: 403 })) },
    });
    await Effect.runPromise(sender.start());
    await Effect.runPromise(sender.enqueue(f.reply));
    await vi.waitFor(async () => expect(await readFile(f.path, "utf8")).toContain('"next":null'));
    const previous = f.binding.operationId;
    const resumed = f.create({ directory: { get: () => ({ ...f.binding, operationId: randomUUID() }) } });
    await Effect.runPromise(sender.stop());
    await Effect.runPromise(resumed.start());
    await Effect.runPromise(resumed.retryChat(f.reply.telegramId));
    await vi.waitFor(async () => expect(await readFile(f.path, "utf8")).not.toContain(previous));
    expect(f.sent).toEqual([]);
  });

  it("does not deliver the remaining HTML to a replacement binding after the preview", async () => {
    const f = await fixture();
    f.reply.text = "";
    f.reply.files = [
      { attachmentId: "preview", name: "page.png", mimeType: "image/png", bytes: Buffer.from("preview") },
      { attachmentId: "source", name: "page.html", mimeType: "text/html", bytes: Buffer.from("<p>Owner only</p>") },
    ];
    const sent: string[] = [];
    const api = {
      ...f.config.api,
      sendFile: (_token: string, dest: number, file: { mimeType: string }) =>
        Effect.sync(() => {
          expect(dest).toBe(f.reply.ownerId);
          sent.push(file.mimeType);
          f.ready(false);
          f.photo.notify();
        }),
    };
    const sender = f.create({ api });
    await Effect.runPromise(sender.start());
    await Effect.runPromise(sender.enqueue(f.reply));
    await f.photo.promise;
    await Effect.runPromise(sender.stop());
    const state = JSON.parse(await readFile(f.path, "utf8"));
    expect(state.pending[0]).toMatchObject({ file: 1, fileIds: ["preview", "source"] });

    f.ready(true);
    const replacement = { ...f.binding, operationId: randomUUID() };
    const resumed = f.create({ api, directory: { get: () => replacement } });
    await Effect.runPromise(resumed.start());
    await vi.waitFor(async () => expect(JSON.parse(await readFile(f.path, "utf8")).pending).toEqual([]));
    expect(sent).toEqual(["image/png"]);
    expect(f.sent).toEqual([]);
  });

  it("answers in the root agent's manager chat with the manager credential only", async () => {
    const f = await fixture();
    const managerId = f.config.managerId;
    const reply = { ...f.reply, telegramId: managerId, files: [] };
    const tokens: string[] = [];
    const sender = f.create({
      directory: { get: (id) => (id === managerId ? { ...f.binding, id: managerId } : undefined) },
      agents: {
        ownsTurn: (agent, turn, bot, owner) =>
          agent === reply.agentId && turn === reply.turnId && bot === managerId && owner === reply.ownerId,
        readReply: () => Effect.succeed(reply),
      },
      api: {
        ...f.config.api,
        getManagedBotToken: () => Effect.die("The manager chat must not request an agent credential."),
        sendMessage: (token, chat, text) => {
          tokens.push(token);
          return f.config.api.sendMessage(token, chat, text);
        },
      },
    });
    await Effect.runPromise(sender.start());
    await Effect.runPromise(sender.enqueue(reply));
    await f.first.promise;
    expect(tokens).toEqual([f.config.managerToken]);
    expect(f.sent).toEqual(["private output"]);
  });
});
