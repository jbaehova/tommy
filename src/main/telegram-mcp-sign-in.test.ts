import { type AgentEvent, MCP_SIGN_IN_TIMEOUT_MS, type McpServerConfig } from "@tommy/contracts/ipc";
import { Deferred, Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { TELEGRAM_MCP_CALLBACK_PATH } from "../backend/mcp-oauth-provider";
import { TelegramMcpSignIn } from "./telegram-mcp-sign-in";

const origin = "https://tommy.example.com";
const settings: McpServerConfig = {
  id: "service",
  name: "Example",
  transport: "http",
  enabled: true,
  command: "",
  args: [],
  env: [],
  envPassthrough: [],
  workingDirectory: "",
  url: "https://mcp.example.com/resource#account-one",
  headers: [],
};

/** `opens` false holds the provider before it names its authorization page, until `release`. */
function fixture(opens = true) {
  const config = { ...settings };
  const gate = Deferred.makeUnsafe<void>();
  if (opens) Deferred.doneUnsafe(gate, Effect.void);
  let generation = "original";
  const code = Deferred.makeUnsafe<string | null>();
  const notified = Deferred.makeUnsafe<string>();
  let attempts = 0;
  let noticeCount = 0;
  const cards = new TelegramMcpSignIn({
    publicOrigin: origin,
    route: (agentId, turnId) => (agentId === "agent" && turnId === "turn" ? { id: 42, generation } : null),
    receive: (state, value) => state === "sample" && Deferred.doneUnsafe(code, Effect.succeed(value)),
    language: () => "en",
    service: {
      listMcpServers: () => [config],
      listAgents: () => [],
      signInMcpServer: (_config, open) =>
        Effect.gen(function* () {
          if (!open) throw new Error("Missing opener");
          attempts++;
          const page = new URL("https://issuer.example.com/authorize");
          page.search = new URLSearchParams({
            state: "sample",
            redirect_uri: origin + TELEGRAM_MCP_CALLBACK_PATH,
            code_challenge: "example",
            code_challenge_method: "S256",
          }).toString();
          yield* Deferred.await(gate);
          yield* Effect.promise(() => open(page.href));
          const value = yield* Deferred.await(code);
          return { toolCount: value ? 3 : 0, error: value ? null : "refused" };
        }),
    },
    send: (chat, text, button, targetGeneration) =>
      Effect.sync(() => {
        expect(chat).toBe(42);
        expect(targetGeneration).toBe(generation);
        if (button) noticeCount++;
        else Deferred.doneUnsafe(notified, Effect.succeed(text));
      }),
  });
  const message = {
    id: "stored-row",
    turnId: "turn",
    source: "system",
    author: "system",
    status: "completed",
    itemType: "mcp-sign-in:service",
    text: "MCP",
    createdAt: new Date().toISOString(),
  } as const;
  const event: AgentEvent = {
    type: "conversation",
    snapshot: { agentId: "agent", threadId: "thread", activeTurnId: "turn", revision: 2, messages: [message] },
  };
  cards.observe(event);
  const [item] = cards.list(42);
  if (!item) throw new Error("Missing card");
  return {
    cards,
    item,
    config,
    event,
    notified,
    attempts: () => attempts,
    noticeCount: () => noticeCount,
    rebind: () => {
      generation = "new";
    },
    release: () => Deferred.doneUnsafe(gate, Effect.void),
  };
}

describe("Telegram MCP sign-in boundary", () => {
  it("takes only a persisted system card, opens once in its own chat and consumes the grant once", async () => {
    const { cards, item, event, attempts, noticeCount, notified } = fixture();
    try {
      cards.observe(event);
      expect(noticeCount()).toBe(1);
      expect(cards.list(8)).toEqual([]);
      expect(await Effect.runPromise(cards.start(8, item.handle))).toBe(null);
      expect(await Effect.runPromise(cards.start(42, "unknown"))).toBe(null);
      const [first, second] = await Promise.all([
        Effect.runPromise(cards.start(42, item.handle)),
        Effect.runPromise(cards.start(42, item.handle)),
      ]);
      expect(first?.url).toContain("https://issuer.example.com/");
      expect(second).toEqual(first);
      expect(attempts()).toBe(1);
      expect(cards.callback(new URLSearchParams("state=sample&state=sample&code=fixture"))).toBe("invalid");
      expect(cards.callback(new URLSearchParams("state=sample&error=denied&code=fixture"))).toBe("invalid");
      expect(cards.callback(new URLSearchParams("state=sample&code=fixture"))).toBe("accepted");
      expect(cards.callback(new URLSearchParams("state=sample&code=fixture"))).toBe("invalid");
      expect(await Effect.runPromise(Deferred.await(notified))).toBe("Example is connected.");
    } finally {
      cards.stop();
    }
  });
  it("refuses replaced resources, deleted messages, expired grants and rebound chats", async () => {
    for (const change of ["resource", "message", "generation", "deadline"]) {
      const { cards, item, config, rebind } = fixture();
      try {
        await Effect.runPromise(cards.start(42, item.handle));
        if (change === "resource") config.url += "-two";
        if (change === "generation") rebind();
        if (change === "message")
          cards.observe({
            type: "conversation-messages-deleted",
            agentId: "agent",
            threadId: "thread",
            messageIds: ["stored-row"],
          });
        if (change === "deadline") vi.spyOn(Date, "now").mockReturnValue(Date.now() + MCP_SIGN_IN_TIMEOUT_MS + 1);
        expect(cards.list(42)).toEqual([]);
        expect(cards.callback(new URLSearchParams("state=sample&code=fixture"))).toBe("invalid");
      } finally {
        cards.stop();
        vi.restoreAllMocks();
      }
    }
  });
  it("ends an unopened card at its deadline and reports expiry once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { cards, event, notified, noticeCount } = fixture();
    try {
      vi.advanceTimersByTime(MCP_SIGN_IN_TIMEOUT_MS);
      expect(await Effect.runPromise(Deferred.await(notified))).toBe("The sign-in request for Example expired.");
      cards.observe(event);
      expect(noticeCount()).toBe(1);
      expect(cards.list(42)).toEqual([]);
    } finally {
      cards.stop();
      vi.useRealTimers();
    }
  });

  it("answers a slow start before the proxy timeout and lets a retry wait for the same attempt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { cards, item, attempts, release } = fixture(false);
    try {
      const first = Effect.runPromise(cards.start(42, item.handle));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await first).toBe(null);
      expect(cards.list(42)).toHaveLength(1);
      const second = Effect.runPromise(cards.start(42, item.handle));
      release();
      expect((await second)?.url).toContain("https://issuer.example.com/");
      expect(attempts()).toBe(1);
    } finally {
      cards.stop();
      vi.useRealTimers();
    }
  });

  it("reports provider refusal in the original chat", async () => {
    const { cards, item, notified } = fixture();
    try {
      await Effect.runPromise(cards.start(42, item.handle));
      expect(cards.callback(new URLSearchParams("state=sample&error=access_denied"))).toBe("denied");
      expect(await Effect.runPromise(Deferred.await(notified))).toBe("Sign-in to Example was declined.");
      expect(cards.list(42)).toEqual([]);
    } finally {
      cards.stop();
    }
  });
});
