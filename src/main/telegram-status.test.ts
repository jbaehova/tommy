import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { TelegramStatus } from "./telegram-status";

const AGENT = "agent-1";
const THREAD = "thread-1";

/** A status with a clock and timers that the test moves, and a chat that records what it gets. */
function setup(options: { chat?: number | null; failSend?: boolean; holdSend?: boolean } = {}) {
  let now = 0;
  let nextId = 100;
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  const chat = new Map<number, string>();
  const calls: string[] = [];
  const notes = new Map<string, string>();
  const held: (() => void)[] = [];
  const status = new TelegramStatus({
    chat: () => (options.chat === undefined ? 7 : options.chat),
    send: (_chat, text) =>
      Effect.promise(
        () =>
          new Promise<number>((resolve, reject) => {
            const answer = () => {
              if (options.failSend) return reject(new Error("refused"));
              nextId += 1;
              chat.set(nextId, text);
              calls.push(`send ${nextId}`);
              resolve(nextId);
            };
            if (options.holdSend) held.push(answer);
            else answer();
          }),
      ),
    edit: (_chat, messageId, text) =>
      Effect.sync(() => {
        chat.set(messageId, text);
        calls.push(`edit ${messageId}`);
      }),
    remove: (_chat, messageId) =>
      Effect.sync(() => {
        chat.delete(messageId);
        calls.push(`delete ${messageId}`);
      }),
    note: (_agentId, _threadId, turnId) => notes.get(turnId) ?? null,
    language: () => "en",
    now: () => now,
    delay: (run, ms) => {
      const timer = { at: now + ms, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  /** Moves the clock, runs each timer that is due, and lets the answers of Telegram arrive. */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((timer) => !timer.cancelled && timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.cancelled = true;
      now = due.at;
      due.run();
      await settle();
    }
    now = end;
  };
  const event = (type: "turn-started" | "turn-completed", turnId: string, origin?: "routine") => {
    const turn = { agentId: AGENT, threadId: THREAD, turnId, ...(origin ? { origin } : {}) };
    status.observe(type === "turn-started" ? { type, ...turn } : { type, ...turn, status: "completed" });
  };
  const progress = (turnId: string, detail: string) =>
    status.observe({ type: "turn-progress", agentId: AGENT, threadId: THREAD, turnId, detail });
  return { status, chat, calls, notes, held, advance, event, progress };
}

/** Lets the promises of a send, an edit or a delete finish. */
const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

describe("TelegramStatus", () => {
  it("sends nothing for a turn that ends before the first status", async () => {
    const { calls, advance, event } = setup();
    event("turn-started", "t1");
    await advance(29_000);
    event("turn-completed", "t1");
    await advance(120_000);
    expect(calls).toEqual([]);
  });

  it("shows one message for a long turn, edits it in place, and deletes it at the end", async () => {
    const { chat, calls, notes, advance, event, progress } = setup();
    event("turn-started", "t1");
    notes.set("t1", "**Reading the report**\n\nI look at the three tables first.");
    progress("t1", "Reading files");
    await advance(30_000);
    expect([...chat.values()]).toEqual(["⏳ Working…\nI look at the three tables first.\nReading files"]);

    // Nothing new: no edit before the minute changes.
    await advance(20_000);
    expect(calls).toEqual(["send 101"]);

    notes.set("t1", "I look at the three tables first.\n\nNow I compare them with last month.");
    await advance(20_000);
    expect([...chat.values()]).toEqual(["⏳ Working… 1 min\nNow I compare them with last month.\nReading files"]);
    expect(calls).toEqual(["send 101", "edit 101"]);

    event("turn-completed", "t1");
    await settle();
    expect(chat.size).toBe(0);
    expect(calls).toEqual(["send 101", "edit 101", "delete 101"]);
    await advance(600_000);
    expect(calls.length).toBe(3);
  });

  it("removes secrets and email addresses from the note", async () => {
    const { chat, notes, advance, event } = setup();
    event("turn-started", "t1");
    notes.set("t1", "I sign in as owner@example.com with the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789.");
    await advance(30_000);
    const text = [...chat.values()][0] ?? "";
    expect(text).not.toContain("owner@example.com");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("shows nothing for a routine turn, or while no chat shows the turn", async () => {
    const routine = setup();
    routine.event("turn-started", "t1", "routine");
    await routine.advance(300_000);
    expect(routine.calls).toEqual([]);

    const offline = setup({ chat: null });
    offline.event("turn-started", "t1");
    await offline.advance(300_000);
    expect(offline.calls).toEqual([]);
  });

  it("deletes a message that Telegram accepted after the turn ended", async () => {
    const { chat, calls, held, advance, event } = setup({ holdSend: true });
    event("turn-started", "t1");
    await advance(30_000);
    event("turn-completed", "t1");
    expect(calls).toEqual([]);
    held[0]?.();
    await settle();
    expect(calls).toEqual(["send 101", "delete 101"]);
    expect(chat.size).toBe(0);
  });

  it("tries again after a send that Telegram refused, and deletes every message on close", async () => {
    const failing = setup({ failSend: true });
    failing.event("turn-started", "t1");
    await failing.advance(90_000);
    expect(failing.calls).toEqual([]);

    const { status, chat, advance, event } = setup();
    event("turn-started", "t1");
    event("turn-started", "t2");
    await advance(30_000);
    expect(chat.size).toBe(2);
    status.close();
    await settle();
    expect(chat.size).toBe(0);
  });
});
