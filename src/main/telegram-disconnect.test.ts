import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceText } from "@tommy/i18n/source";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramDirectory } from "./telegram-directory";
import { TelegramDisconnect } from "./telegram-disconnect";

const manager = 1000;
const owner = 2000;
const child = { id: 3000, username: "example_agent", first_name: "Example Agent" };
const request = `/disconnect @${child.username}`;

describe("Telegram disconnect confirmation", () => {
  let directory: TelegramDirectory;
  let disconnect: TelegramDisconnect;
  let root: string;
  const clear = vi.fn();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tommy-disconnect-"));
    directory = new TelegramDirectory(join(root, "directory.json"), manager, owner);
    await Effect.runPromise(directory.load());
    await Effect.runPromise(directory.ensureManaged(child, 5));
    clear.mockReset();
    disconnect = new TelegramDisconnect(directory, clear);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  const dispatch = (text: string, id: number) => Effect.runPromise(disconnect.handle(text, id, sourceText));

  async function prompt(id: number) {
    const message = await dispatch(request, id);
    const command = message?.split("\n").at(-1);
    if (!command?.startsWith(`${request} `)) throw new Error("No confirmation command.");
    return command;
  }

  it("requires a separate fresh update for the exact binding, then rejects replay", async () => {
    const original = await prompt(10);
    expect(await prompt(10)).toBe(original);
    await dispatch(original, 9);
    expect(directory.get(child.id)).toBeDefined();

    await Effect.runPromise(directory.revoke(child.id, 11));
    await Effect.runPromise(directory.ensureManaged(child, 12));
    await dispatch(original, 13);
    expect(clear).not.toHaveBeenCalled();
    expect(directory.get(child.id)).toBeDefined();

    const command = await prompt(14);
    await dispatch(command, 15);
    expect(directory.get(child.id)).toBeUndefined();
    expect(clear).toHaveBeenCalledExactlyOnceWith(child.id);
    await dispatch(command, 15);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("rejects an expired code and a confirmation for another bot", async () => {
    const clock = vi.spyOn(Date, "now");
    const now = Date.now();
    clock.mockReturnValue(now);
    const command = await prompt(10);
    await Effect.runPromise(directory.ensureManaged({ ...child, id: 3001, username: "example_second" }, 11));
    await dispatch(command.replace("example_agent", "example_second"), 12);
    clock.mockReturnValue(now + 5 * 60_000);
    await dispatch(command, 13);
    expect(directory.list()).toHaveLength(2);
    expect(clear).not.toHaveBeenCalled();
  });
});
