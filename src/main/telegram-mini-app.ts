import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type BrowserTakeoverRequest,
  isBrowserSecretRequest,
  type LocalBrowserSecretResponse,
} from "@tommy/contracts/ipc";
import { Effect, Option, Schema } from "effect";
import type { AgentService } from "../backend/agent-service";
import type { BrowserHost } from "../backend/browser-host";
import { readBodyWithin } from "./http-body";
import { telegramMiniAppOwner } from "./telegram-mini-app-auth";
import { telegramMiniAppPage } from "./telegram-mini-app-page";

export const TELEGRAM_MINI_APP_PATH = "/tommy/telegram/app";

export interface TelegramMiniAppAgent {
  agentId: string | null;
  name: string;
  username: string;
  active: boolean;
}

interface MiniAppOptions {
  publicOrigin: string;
  managerToken: string;
  ownerId: number;
  /** The manager opens the owner's whole view. Each agent bot opens only its own chat's view. */
  managerId?: number;
  /** The credential of a connected agent bot, or null. The Mini App checks its launch data with it. */
  botToken?: (bot: number) => Effect.Effect<string | null>;
  /** The agent that answers in this bot's chat, whose browser tabs this view shows. */
  botAgent?: (bot: number) => string | null;
  ownsTurn: (agentId: string, turnId: string, bot: number) => boolean;
  listAgents: (bot: number) => readonly TelegramMiniAppAgent[];
  browser?: Pick<BrowserHost, "capturePreview" | "listTabs">;
  agents: Pick<AgentService, "respondToBrowserSecret"> & {
    getRuntimeSnapshot(): { pendingBrowserTakeovers: BrowserTakeoverRequest[] };
  };
}

const decodeAnswer = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ handle: Schema.String, decision: Schema.Literal("cancel") }),
      Schema.Struct({
        handle: Schema.String,
        decision: Schema.Literal("submit"),
        secret: Schema.String,
        username: Schema.optional(Schema.String),
      }),
    ]),
  ),
);

const decodePreview = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ handle: Schema.String.check(Schema.isBetweenLength(1, 128)) })),
);

function siteOrigin(value: string): string | null {
  const url = URL.parse(value);
  if (url?.protocol !== "https:" || url.username || url.password) return null;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return /(?:^|\.)(?:telegram\.org|telegram\.me|telegram\.dog|t\.me)$/.test(hostname) ? null : url.origin;
}

function allowedRequest(request: BrowserTakeoverRequest) {
  return isBrowserSecretRequest(request.secret) && siteOrigin(request.secret.origin) !== null;
}

const readAnswer = Effect.fn("TelegramMiniApp.readAnswer")(function* (request: IncomingMessage) {
  return yield* Effect.tryPromise({
    try: async () => {
      const timer = setTimeout(() => request.destroy(), 10_000);
      timer.unref();
      try {
        return await readBodyWithin(request, 32_768);
      } finally {
        clearTimeout(timer);
      }
    },
    catch: () => "unreadable" as const,
  });
});

function botFromUrl(url: string | undefined): number | null {
  const value = new URLSearchParams(url?.split("?", 2)[1] ?? "").get("bot");
  if (value === null) return null;
  return /^[1-9]\d{0,15}$/.test(value) && Number(value) < 2 ** 52 ? Number(value) : Number.NaN;
}

export class TelegramMiniApp {
  readonly #options: MiniAppOptions;
  readonly #requestKey = randomBytes(32);
  readonly #prepared = new Set<string>();

  constructor(options: MiniAppOptions) {
    this.#options = options;
  }

  /** Runtime snapshots can include a request still preparing its secret protection. Only the emitted
   * browser-takeover-requested event confirms an ordinary takeover actually completed preparation. */
  noteTakeover(request: BrowserTakeoverRequest): void {
    const pending = this.#options.agents.getRuntimeSnapshot().pendingBrowserTakeovers;
    const live = new Set(pending.map((item) => this.#handleFor(item)));
    for (const key of this.#prepared) if (!live.has(key)) this.#prepared.delete(key);
    if (!request.secret && this.#options.ownsTurn(request.agentId, request.turnId, this.#managerId)) {
      this.#prepared.add(this.#handleFor(request));
    }
  }

  get #managerId(): number {
    return this.#options.managerId ?? 0;
  }

  /** The bot whose launch data this request carries, checked with that bot's own credential. */
  readonly #authorize = Effect.fn("TelegramMiniApp.authorize")(function* (
    this: TelegramMiniApp,
    request: IncomingMessage,
  ) {
    const requested = botFromUrl(request.url);
    if (Number.isNaN(requested)) return null;
    const bot = requested ?? this.#managerId;
    const token =
      bot === this.#managerId
        ? this.#options.managerToken
        : this.#options.botToken
          ? yield* this.#options.botToken(bot)
          : null;
    if (
      !token ||
      request.headers.origin !== this.#options.publicOrigin ||
      !telegramMiniAppOwner(request.headers.authorization, token, this.#options.ownerId, Math.floor(Date.now() / 1000))
    )
      return null;
    return { bot, token };
  }).bind(this);

  /** The agent's own tabs, in the chat of its bot. The handle names no page, so it survives navigation. */
  #tabHandle(bot: number, agentId: string, tabId: string) {
    return createHmac("sha256", this.#requestKey)
      .update(JSON.stringify([this.#options.ownerId, bot, agentId, tabId, "tab"]))
      .digest("base64url");
  }

  /** A request expires when it leaves the registry, changes destination, or the service restarts. */
  #handleFor(request: BrowserTakeoverRequest, page?: string) {
    return createHmac("sha256", this.#requestKey)
      .update(
        JSON.stringify([
          this.#options.ownerId,
          request.agentId,
          request.threadId,
          request.turnId,
          request.requestId,
          request.tabId,
          request.secret?.origin,
          request.secret?.method,
          page,
        ]),
      )
      .digest("base64url");
  }

  #previews(bot: number, agents: readonly TelegramMiniAppAgent[], requests: readonly BrowserTakeoverRequest[]) {
    const browser = this.#options.browser;
    if (!browser) return [];
    const tabs = browser.listTabs();
    const shown = new Set<string>();
    const handoffs = requests.flatMap((item) => {
      if (
        item.secret ||
        !this.#prepared.has(this.#handleFor(item)) ||
        !agents.some((agent) => agent.active && agent.agentId === item.agentId) ||
        !this.#options.ownsTurn(item.agentId, item.turnId, bot)
      )
        return [];
      const tab = tabs.find((candidate) => candidate.id === item.tabId);
      if (!tab || tab.userControl || tab.ownerAgentId !== item.agentId || tab.ownerThreadId !== item.threadId)
        return [];
      const origin = siteOrigin(tab.url);
      if (!origin) return [];
      shown.add(tab.id);
      return [{ handle: this.#handleFor(item, tab.url), origin, agentId: item.agentId, tabId: item.tabId }];
    });
    const agentId = this.#options.botAgent?.(bot) ?? null;
    if (!agentId || !agents.some((agent) => agent.active && agent.agentId === agentId)) return handoffs;
    const own = tabs.flatMap((tab) => {
      const origin = siteOrigin(tab.url);
      if (tab.ownerAgentId !== agentId || tab.userControl || shown.has(tab.id) || !origin) return [];
      return [{ handle: this.#tabHandle(bot, agentId, tab.id), origin, agentId, tabId: tab.id }];
    });
    return [...handoffs, ...own];
  }

  readonly handle = Effect.fn("TelegramMiniApp.handle")(function* (
    this: TelegramMiniApp,
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const path = request.url?.split("?", 1)[0];
    if (
      path !== TELEGRAM_MINI_APP_PATH &&
      path !== `${TELEGRAM_MINI_APP_PATH}/state` &&
      path !== `${TELEGRAM_MINI_APP_PATH}/secret` &&
      path !== `${TELEGRAM_MINI_APP_PATH}/preview`
    )
      return false;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (path === TELEGRAM_MINI_APP_PATH && request.method === "GET") {
      const nonce = randomBytes(18).toString("base64");
      response.setHeader(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org`,
      );
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(telegramMiniAppPage(nonce, request.headers["accept-language"]?.split(",")[0] ?? "en"));
      return true;
    }
    if (request.method !== "POST" || path === TELEGRAM_MINI_APP_PATH) {
      response.writeHead(405).end();
      return true;
    }
    const access = yield* this.#authorize(request);
    if (!access) {
      response.writeHead(403).end();
      return true;
    }
    const { bot } = access;
    if (
      request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json" ||
      request.headers["content-encoding"]
    ) {
      response.writeHead(415).end();
      return true;
    }
    const body = yield* Effect.result(readAnswer(request));
    if (body._tag === "Failure" || !body.success) {
      if (!response.destroyed) response.writeHead(body._tag === "Failure" ? 400 : 413).end();
      return true;
    }
    const agents = this.#options.listAgents(bot);
    const takeovers = this.#options.agents.getRuntimeSnapshot().pendingBrowserTakeovers;
    if (path === `${TELEGRAM_MINI_APP_PATH}/preview`) {
      const parsed = decodePreview(body.success.toString("utf8"));
      if (Option.isNone(parsed)) {
        response.writeHead(400).end();
        return true;
      }
      const handle = parsed.value.handle;
      const item = this.#previews(bot, agents, takeovers).find((preview) => preview.handle === handle);
      const browser = this.#options.browser;
      if (!item || !browser) {
        response.writeHead(409).end();
        return true;
      }
      // capturePreview applies the host's card and secret protections and detects navigation.
      // Recheck the binding, pending request and document URL after this asynchronous capture.
      const capture = yield* Effect.result(browser.capturePreview(item.tabId));
      const current = this.#previews(
        bot,
        this.#options.listAgents(bot),
        this.#options.agents.getRuntimeSnapshot().pendingBrowserTakeovers,
      );
      if (
        capture._tag !== "Success" ||
        !current.some((preview) => preview.handle === handle) ||
        !telegramMiniAppOwner(
          request.headers.authorization,
          access.token,
          this.#options.ownerId,
          Math.floor(Date.now() / 1000),
        )
      ) {
        response.writeHead(409).end();
        return true;
      }
      const prefix = "data:image/jpeg;base64,";
      const data = capture.success.dataUrl;
      if (!data.startsWith(prefix) || data.length > 2 * 1024 * 1024) {
        response.writeHead(409).end();
        return true;
      }
      const jpeg = Buffer.from(data.slice(prefix.length), "base64");
      if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) {
        response.writeHead(409).end();
        return true;
      }
      response.writeHead(200, { "Content-Type": "image/jpeg" }).end(jpeg);
      return true;
    }
    const activeIds = new Set(agents.filter((agent) => agent.active && agent.agentId).map((agent) => agent.agentId));
    const requests = takeovers.filter(
      (item) =>
        activeIds.has(item.agentId) && this.#options.ownsTurn(item.agentId, item.turnId, bot) && allowedRequest(item),
    );
    if (path === `${TELEGRAM_MINI_APP_PATH}/state`) {
      const pending = requests.flatMap((item) =>
        item.secret
          ? [
              {
                handle: this.#handleFor(item),
                agentId: item.agentId,
                method: item.secret.method,
                origin: item.secret.origin,
                digits: item.secret.digits,
                askUsername: item.secret.askUsername === true,
                username: item.secret.username ?? "",
              },
            ]
          : [],
      );
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(
        JSON.stringify({
          agents: agents.map(({ agentId, name, username, active }) => ({ agentId, name, username, active })),
          requests: pending,
          previews: this.#previews(bot, agents, takeovers).map(({ handle, origin, agentId }) => ({
            handle,
            origin,
            agentId,
          })),
        }),
      );
      return true;
    }
    const parsed = decodeAnswer(body.success.toString("utf8"));
    if (Option.isNone(parsed)) {
      response.writeHead(400).end();
      return true;
    }
    const answer = parsed.value;
    const pending = requests.find((item) => this.#handleFor(item) === answer.handle);
    if (!pending?.secret) {
      response.writeHead(409).end();
      return true;
    }
    let input: LocalBrowserSecretResponse = {
      agentId: pending.agentId,
      requestId: pending.requestId,
      decision: "cancel",
    };
    if (answer.decision === "submit") {
      const field = pending.secret;
      const isCode = field.method !== "password";
      const asksUsername = field.method === "password" && field.askUsername;
      if (
        !answer.secret ||
        answer.secret.length > 4096 ||
        (isCode && (answer.secret.length !== field.digits || !/^\d+$/.test(answer.secret))) ||
        (asksUsername ? !answer.username?.trim() || answer.username.length > 512 : answer.username !== undefined)
      ) {
        response.writeHead(400).end();
        return true;
      }
      input = {
        ...input,
        decision: "submit",
        secret: answer.secret,
        ...(asksUsername ? { username: answer.username } : {}),
      };
    }
    const handled = yield* Effect.result(this.#options.agents.respondToBrowserSecret(input));
    response.writeHead(handled._tag === "Success" ? 204 : 409).end();
    return true;
  }).bind(this);
}
