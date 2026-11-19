// @vitest-environment node
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { Script } from "node:vm";
import type { BrowserTab, BrowserTakeoverRequest, LocalBrowserSecretResponse } from "@tommy/contracts/ipc";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { TELEGRAM_MINI_APP_PATH, TelegramMiniApp } from "./telegram-mini-app";
import { telegramMiniAppOwner } from "./telegram-mini-app-auth";
import { telegramMiniAppPage } from "./telegram-mini-app-page";

const token = "example-token-only";
const owner = 321;
const origin = "https://example.com";

function launch(id: number, timestamp: number, signer = token) {
  const time = String(timestamp);
  const user = JSON.stringify({ id });
  const fields = new URLSearchParams({ user, auth_date: time });
  const key = createHmac("sha256", "WebAppData").update(signer).digest();
  fields.set("hash", createHmac("sha256", key).update(`auth_date=${time}\nuser=${user}`).digest("hex"));
  return `tma ${fields.toString()}`;
}

const stateFromJson = Schema.decodeUnknownSync(
  Schema.Struct({
    agents: Schema.Array(Schema.Struct({ name: Schema.String })),
    previews: Schema.Array(Schema.Struct({ handle: Schema.String, origin: Schema.String })),
    requests: Schema.Array(Schema.Struct({ origin: Schema.String, handle: Schema.String })),
  }),
);

const pending: BrowserTakeoverRequest = {
  requestId: "request-test",
  turnId: "turn-test",
  threadId: "thread-test",
  tabId: "tab-test",
  agentId: "agent-test",
  secret: { origin: "https://example.org", method: "password", digits: 6 },
};

describe("Telegram Mini App owner and browser boundary", () => {
  it("rejects stale, future, tampered and ambiguous Telegram credentials", () => {
    const now = 1800000000;
    const valid = launch(owner, now);
    expect(telegramMiniAppOwner(valid, token, owner, now)).toBe(true);
    for (const credential of [
      launch(5, now),
      launch(owner, now - 301),
      launch(owner, now + 10),
      valid.replace("321", "322"),
      `${valid}&user=%7B%22id%22%3A321%7D`,
    ]) {
      expect(telegramMiniAppOwner(credential, token, owner, now)).toBe(false);
    }
    expect(telegramMiniAppOwner(valid, "another-manager", owner, now)).toBe(false);
  });

  it("loads self-contained scripts for both locales without loading scripts from other origins", () => {
    for (const locale of ["en", "ko"]) {
      const html = telegramMiniAppPage("sample", locale);
      const source = html.match(/<script nonce="sample">([\s\S]+)<\/script>/)?.[1];
      if (!source) throw new Error("Missing script");
      expect(() => new Script(source)).not.toThrow();
      expect(html).not.toMatch(/<script\s+src/i);
    }
  });

  it("only shows or answers active requests for the linked owner turn and actual destination", async () => {
    let ownedTurn = true;
    const calls: LocalBrowserSecretResponse[] = [];
    const requests = [
      pending,
      { ...pending, agentId: "other-agent" },
      { ...pending, turnId: "other-turn" },
      {
        ...pending,
        secret: { origin: "https://web.telegram.org", method: "password", digits: 6 },
      } satisfies BrowserTakeoverRequest,
    ];
    const app = new TelegramMiniApp({
      publicOrigin: origin,
      managerToken: token,
      ownerId: owner,
      listAgents: () => [{ agentId: pending.agentId, active: true, name: "Agent", username: "example_agent" }],
      ownsTurn: (agentId, turnId) => ownedTurn && agentId === pending.agentId && turnId === pending.turnId,
      agents: {
        getRuntimeSnapshot: () => ({ pendingBrowserTakeovers: requests }),
        respondToBrowserSecret: (answer) =>
          Effect.sync(() => {
            calls.push(answer);
            requests.length = 0;
          }),
      },
    });
    const server = createServer((req, res) => {
      void Effect.runPromise(app.handle(req, res));
    });
    server.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test port");
      const authorization = launch(owner, Math.floor(Date.now() / 1000));
      const post = (route: string, body: string, from = origin) =>
        fetch(`http://127.0.0.1:${address.port}${TELEGRAM_MINI_APP_PATH}/${route}`, {
          method: "POST",
          body,
          headers: { origin: from, authorization, "Content-Type": "application/json" },
        });
      expect((await post("state", "{}", "https://other.example.com")).status).toBe(403);
      const res = await post("state", "{}");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const state = stateFromJson(await res.json());
      expect(state.requests.map((item) => item.origin)).toEqual(["https://example.org"]);
      const answer = { handle: state.requests[0]?.handle, secret: "fake-value", decision: "submit", saveToVault: true };
      ownedTurn = false;
      expect((await post("secret", JSON.stringify(answer))).status).toBe(409);
      ownedTurn = true;
      expect((await post("secret", JSON.stringify({ ...answer, handle: "unknown" }))).status).toBe(409);
      expect((await post("secret", JSON.stringify(answer))).status).toBe(204);
      expect((await post("secret", JSON.stringify(answer))).status).toBe(409);
      expect(calls).toEqual([
        { requestId: pending.requestId, agentId: pending.agentId, decision: "submit", secret: "fake-value" },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("sends a no-store still only for a prepared, owned manual takeover, rechecking the grant after capture", async () => {
    const handoff: BrowserTakeoverRequest = {
      agentId: "a",
      threadId: "thread",
      turnId: "turn",
      tabId: "tab",
      requestId: 28,
    };
    const requests: BrowserTakeoverRequest[] = [handoff];
    const tab: BrowserTab = {
      id: handoff.tabId,
      title: "Secret title",
      url: "https://example.org/p?example=private",
      ownerAgentId: handoff.agentId,
      ownerThreadId: handoff.threadId,
      loading: false,
    };
    let permitted = true;
    let revokeDuringCapture = false;
    let captures = 0;
    const app = new TelegramMiniApp({
      publicOrigin: origin,
      managerToken: token,
      ownerId: owner,
      listAgents: () => [{ agentId: "a", name: "Agent", username: "example_agent", active: permitted }],
      ownsTurn: (a, turn) => a === "a" && turn === "turn",
      agents: {
        getRuntimeSnapshot: () => ({ pendingBrowserTakeovers: requests }),
        respondToBrowserSecret: () => Effect.void,
      },
      browser: {
        listTabs: () => [tab],
        capturePreview: (id) =>
          Effect.sync(() => {
            expect(id).toBe(handoff.tabId);
            captures++;
            if (revokeDuringCapture) permitted = false;
            return { dataUrl: "data:image/jpeg;base64,/9j/2Q==", width: 960, height: 600 };
          }),
      },
    });
    const server = createServer((req, res) => {
      void Effect.runPromise(app.handle(req, res));
    });
    server.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test port");
      const authorization = launch(owner, Math.floor(Date.now() / 1000));
      const post = (route: string, body: { handle?: string | undefined }, from = origin) =>
        fetch(`http://127.0.0.1:${address.port}${TELEGRAM_MINI_APP_PATH}/${route}`, {
          method: "POST",
          headers: { origin: from, authorization, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      const getState = async () => stateFromJson(await (await post("state", {})).json());
      expect((await getState()).previews).toEqual([]);
      app.noteTakeover(handoff);
      const stateResponse = await (await post("state", {})).text();
      expect(stateResponse).not.toContain("example=private");
      expect(stateResponse).not.toContain("Secret title");
      const state = stateFromJson(JSON.parse(stateResponse));
      expect(state.previews.map((preview) => preview.origin)).toEqual(["https://example.org"]);
      const handle = state.previews[0]?.handle;
      expect((await post("preview", { handle }, "https://wrong.example.org")).status).toBe(403);
      expect((await post("preview", { handle: handoff.tabId })).status).toBe(409);
      expect(captures).toBe(0);
      const image = await post("preview", { handle });
      expect(image.headers.get("content-type")).toBe("image/jpeg");
      expect(image.headers.get("cache-control")).toBe("no-store");
      expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([255, 216, 255, 217]);
      tab.ownerAgentId = "another";
      expect((await post("preview", { handle })).status).toBe(409);
      tab.ownerAgentId = "a";
      tab.url = "https://example.org/changed";
      expect((await post("preview", { handle })).status).toBe(409);
      tab.url = "https://example.org/p?example=private";
      requests[0] = { ...handoff, secret: { origin: "https://example.org", method: "password", digits: 6 } };
      expect((await post("preview", { handle })).status).toBe(409);
      requests[0] = handoff;
      expect(captures).toBe(1);
      revokeDuringCapture = true;
      const revoked = await post("preview", { handle });
      expect(revoked.status).toBe(409);
      expect(await revoked.text()).toBe("");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it("opens each agent bot's view with that bot's own credential and shows only its chat's requests and tabs", async () => {
    const managerId = 100;
    const childId = 200;
    const childToken = "example-child-token";
    const mine: BrowserTakeoverRequest = { ...pending, agentId: "agent-child", turnId: "turn-child" };
    const other: BrowserTakeoverRequest = { ...pending, agentId: "agent-root", turnId: "turn-root" };
    const tabs: BrowserTab[] = [
      {
        id: "tab-child",
        title: "Private",
        url: "https://example.net/a?x=1",
        ownerAgentId: "agent-child",
        ownerThreadId: "t",
        loading: false,
      },
      {
        id: "tab-root",
        title: "Root",
        url: "https://example.org/",
        ownerAgentId: "agent-root",
        ownerThreadId: "t",
        loading: false,
      },
    ];
    const chatOf = (agentId: string) => (agentId === "agent-child" ? childId : managerId);
    const app = new TelegramMiniApp({
      publicOrigin: origin,
      managerToken: token,
      ownerId: owner,
      managerId,
      botToken: (bot) => Effect.succeed(bot === childId ? childToken : null),
      botAgent: (bot) => (bot === childId ? "agent-child" : bot === managerId ? "agent-root" : null),
      listAgents: (bot) =>
        [
          { agentId: "agent-root", active: true, name: "Root", username: "example_root_bot" },
          { agentId: "agent-child", active: true, name: "Child", username: "example_child_bot" },
        ].filter((agent) => bot === managerId || chatOf(agent.agentId) === bot),
      ownsTurn: (agentId, _turn, bot) => bot === managerId || chatOf(agentId) === bot,
      agents: {
        getRuntimeSnapshot: () => ({ pendingBrowserTakeovers: [mine, other] }),
        respondToBrowserSecret: () => Effect.void,
      },
      browser: {
        listTabs: () => tabs,
        capturePreview: () => Effect.succeed({ dataUrl: "data:image/jpeg;base64,/9j/2Q==", width: 1, height: 1 }),
      },
    });
    const server = createServer((req, res) => {
      void Effect.runPromise(app.handle(req, res));
    });
    server.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address !== "object") throw new Error("Missing test port");
      const now = Math.floor(Date.now() / 1000);
      const post = (route: string, body: { handle?: string | undefined }, query: string, signer: string) =>
        fetch(`http://127.0.0.1:${address.port}${TELEGRAM_MINI_APP_PATH}/${route}${query}`, {
          method: "POST",
          headers: { origin, authorization: launch(owner, now, signer), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      expect((await post("state", {}, `?bot=${childId}`, token)).status).toBe(403);
      expect((await post("state", {}, "?bot=300", token)).status).toBe(403);
      expect((await post("state", {}, "?bot=0x1", childToken)).status).toBe(403);
      expect((await post("state", {}, "", childToken)).status).toBe(403);
      const childText = await (await post("state", {}, `?bot=${childId}`, childToken)).text();
      expect(childText).not.toContain("Private");
      expect(childText).not.toContain("x=1");
      const child = stateFromJson(JSON.parse(childText));
      expect(child.agents.map((agent) => agent.name)).toEqual(["Child"]);
      expect(child.requests).toHaveLength(1);
      expect(child.previews.map((preview) => preview.origin)).toEqual(["https://example.net"]);
      const handle = child.previews[0]?.handle;
      const image = await post("preview", { handle }, `?bot=${childId}`, childToken);
      expect(image.headers.get("content-type")).toBe("image/jpeg");
      expect((await post("preview", { handle }, "", token)).status).toBe(409);
      const whole = stateFromJson(await (await post("state", {}, "", token)).json());
      expect(whole.requests).toHaveLength(2);
      expect(whole.previews.map((preview) => preview.origin)).toEqual(["https://example.org"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });
});
