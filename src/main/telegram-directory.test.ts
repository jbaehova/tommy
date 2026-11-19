import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramDirectory } from "./telegram-directory";

const manager = 1001;
const owner = 1002;
const account = { id: 1003, username: "ExampleAgent", first_name: "Example" };
const run = Effect.runPromise;

describe("Telegram directory ownership", () => {
  let folder: string;
  let path: string;
  let directory: TelegramDirectory;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "tommy-directory-"));
    path = join(folder, "connections.json");
    directory = new TelegramDirectory(path, manager, owner);
    await run(directory.load());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(folder, { recursive: true, force: true });
  });

  it("refuses the stored grants under either a different owner or a different manager", async () => {
    await run(directory.ensureManaged(account, 1));
    for (const [id, human] of [
      [manager, owner + 10],
      [manager + 10, owner],
    ] as const) {
      const other = new TelegramDirectory(path, id, human);
      await expect(run(other.load())).rejects.toMatchObject({ code: "identity" });
      expect(other.list()).toEqual([]);
      await expect(run(other.ensureManaged(account, 2))).rejects.toMatchObject({ code: "unavailable" });
    }
    expect(directory.list()).toHaveLength(1);
  });

  it("removes transferred grants across restarts and rejects callbacks from their old operation", async () => {
    const previous = await run(directory.ensureManaged(account, 10));
    if (!previous) throw new Error("Missing initial grant.");
    await run(directory.bindAgent(account.id, "agent-first", previous.operationId));
    await run(directory.setVerified(account.id, true, previous.operationId));
    await run(directory.revoke(account.id, 12));

    const restored = new TelegramDirectory(path, manager, owner);
    await run(restored.load());
    expect(await run(restored.ensureManaged(account, 11))).toBeNull();
    expect(restored.get(account.id)).toBeUndefined();

    const current = await run(restored.ensureManaged(account, 13));
    expect(current).toMatchObject({ agentId: null, verified: false });
    expect(current?.operationId).not.toBe(previous.operationId);
    await expect(run(restored.bindAgent(account.id, "agent-first", previous.operationId))).rejects.toMatchObject({
      code: "stale",
    });
    await expect(run(restored.setVerified(account.id, true, previous.operationId))).rejects.toMatchObject({
      code: "stale",
    });
  });

  it("expires the ordering window and stored reply marker without saving the marker text", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const previous = await run(directory.ensureManaged(account, 900));
    if (!previous) throw new Error("Missing initial grant.");
    await run(directory.setVerified(account.id, true, previous.operationId));
    await run(directory.markSeen(account.id, "example-private-reply-marker"));
    expect(await readFile(path, "utf8")).not.toContain("example-private-reply-marker");

    const restored = new TelegramDirectory(path, manager, owner);
    await run(restored.load());
    expect(restored.seen(account.id, "example-private-reply-marker")).toBe(true);
    expect(await run(restored.ensureManaged(account, 900))).toMatchObject({ verified: true });
    clock.mockReturnValue(now + 8 * 24 * 60 * 60 * 1000);
    expect(restored.seen(account.id, "example-private-reply-marker")).toBe(false);
    expect(await run(restored.ensureManaged(account, 3))).toMatchObject({
      verified: false,
      operationId: previous.operationId,
    });
  });

  it("freezes grants after the manager can have lost a transfer and requires fresh ownership evidence", async () => {
    const now = Date.now();
    const hour = 60 * 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await run(directory.observeManager());
    const previous = await run(directory.ensureManaged(account, 40));
    if (!previous) throw new Error("Missing grant.");
    await run(directory.bindAgent(account.id, "agent-original", previous.operationId));
    await run(directory.setVerified(account.id, true, previous.operationId));

    clock.mockReturnValue(now + 23 * hour);
    await run(directory.observeManager());
    const healthy = new TelegramDirectory(path, manager, owner);
    await run(healthy.load());
    clock.mockReturnValue(now + 46 * hour);
    expect(healthy.get(account.id)).toMatchObject({ agentId: "agent-original", verified: true, ownerConfirmed: true });

    clock.mockReturnValue(now + 47 * hour);
    expect(healthy.list()[0]).toMatchObject({ verified: false, ownerConfirmed: false });
    await expect(run(healthy.bindAgent(account.id, "agent-original", previous.operationId))).rejects.toMatchObject({
      code: "stale",
    });
    await expect(run(healthy.setVerified(account.id, true, previous.operationId))).rejects.toMatchObject({
      code: "stale",
    });
    // A healthy network today cannot prove who owned this child while the host was offline.
    await run(healthy.observeManager());
    const restored = new TelegramDirectory(path, manager, owner);
    await run(restored.load());
    expect(restored.get(account.id)).toMatchObject({ verified: false, ownerConfirmed: false });
    expect(await run(restored.ensureManaged(account, 40))).toBeNull();
    const renewed = await run(restored.ensureManaged(account, 41));
    expect(renewed).toMatchObject({
      agentId: "agent-original",
      operationId: previous.operationId,
      verified: false,
      ownerConfirmed: true,
    });
    await expect(run(restored.revoke(account.id, 42, "different-generation"))).rejects.toMatchObject({ code: "stale" });
    await run(restored.setVerified(account.id, true, previous.operationId));
    expect(restored.get(account.id)?.verified).toBe(true);
  });

  it("retains a recent grant from a legacy file and expires an older one separately", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const legacy = {
      id: account.id,
      name: account.first_name,
      username: account.username,
      agentId: "agent-legacy",
      operationId: "83006cf1-8f5a-4091-9fb2-95d8791fbbf3",
      verified: true,
    };
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        managerId: manager,
        ownerId: owner,
        entries: [
          { connection: legacy, change: { updateId: 20, time: now } },
          {
            connection: {
              ...legacy,
              id: 1004,
              agentId: "agent-older",
              operationId: "1b8b3f71-d100-4d70-a1b5-4216bca9c08e",
            },
            change: { updateId: 10, time: now - 25 * 60 * 60_000 },
          },
        ],
        revoked: [],
        receipts: [],
        foreignChange: null,
      }),
    );
    await run(directory.load());
    expect(directory.get(account.id)).toMatchObject({ verified: true, ownerConfirmed: true });
    expect(directory.get(1004)).toMatchObject({ verified: false, ownerConfirmed: false });
    await run(directory.observeManager());
    clock.mockReturnValue(now + 30 * 60_000);
    const stored = await readFile(path, "utf8");
    await run(directory.observeManager());
    expect(await readFile(path, "utf8")).toBe(stored);
    expect(directory.get(1004)).toMatchObject({ verified: false, ownerConfirmed: false, agentId: "agent-older" });
  });

  it("fails closed on malformed stored state and preserves the bytes", async () => {
    await run(directory.ensureManaged(account, 1));
    const invalid = '{"version":1,"unexpected":"private-data"}';
    await writeFile(path, invalid);
    await expect(run(directory.load())).rejects.toMatchObject({ code: "invalid" });
    expect(directory.get(account.id)).toBeUndefined();
    await expect(run(directory.markSeen(manager, 3))).rejects.toMatchObject({ code: "unavailable" });
    expect(await readFile(path, "utf8")).toBe(invalid);
  });
});
