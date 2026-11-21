import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type AgentPromptQuestion,
  type BrowserTakeoverRequest,
  isBrowserSecretRequest,
  type LocalBrowserSecretResponse,
} from "@tommy/contracts/ipc";
import { resolveLocale, translateFor } from "@tommy/i18n";
import { Effect, Option, Schema } from "effect";
import type { AgentService } from "../backend/agent-service";
import type { BrowserHost } from "../backend/browser-host";
import { TELEGRAM_MCP_CALLBACK_PATH } from "../backend/mcp-oauth-provider";
import { readBodyWithin } from "./http-body";
import type { TelegramMcpSignIn } from "./telegram-mcp-sign-in";
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
  mcp?: Pick<TelegramMcpSignIn, "list" | "start" | "callback">;
  managerToken: string;
  ownerId: number;
  /** The manager opens the owner's whole view. Each agent bot opens only its own chat's view. */
  managerId?: number;
  connectionGeneration: (id: number) => string | null;
  /** The credential of a connected agent bot, or null. The Mini App checks its launch data with it. */
  botToken?: (bot: number) => Effect.Effect<string | null>;
  /** The agent that answers in this bot's chat, whose browser tabs this view shows. */
  botAgent?: (bot: number) => string | null;
  ownsTurn: (agentId: string, turnId: string, bot: number) => boolean;
  listAgents: (bot: number) => readonly TelegramMiniAppAgent[];
  browser?: Pick<BrowserHost, "captureOwnerTab" | "listTabs">;
  agents: Pick<AgentService, "respondToBrowserSecret"> & {
    pendingBrowserTakeovers(): BrowserTakeoverRequest[];
    /** Prompts that need private input. The chat never asks them; this view does. */
    privatePrompts?(): readonly TelegramPrivatePrompt[];
    respondToPrompt?(input: {
      requestId: string | number;
      answers: Record<string, string[]>;
    }): Effect.Effect<void, unknown>;
    listAgents?(): readonly { id: string; name: string }[];
  };
}

export interface TelegramPrivatePrompt {
  requestId: string | number;
  agentId: string;
  threadId: string;
  turnId: string;
  questions: readonly AgentPromptQuestion[];
  form: "vault" | "api-key" | null;
}

const answerValue = Schema.String.check(Schema.isBetweenLength(1, 4096));
const decodePromptAnswer = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      handle: Schema.String.check(Schema.isBetweenLength(1, 128)),
      decision: Schema.Literals(["submit", "skip"]),
      answers: Schema.optional(Schema.Record(Schema.String, Schema.Array(answerValue))),
    }),
  ),
);

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

  constructor(options: MiniAppOptions) {
    this.#options = options;
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
    const generation = this.#options.connectionGeneration(bot);
    if (!generation) return null;
    const token =
      bot === this.#managerId
        ? this.#options.managerToken
        : this.#options.botToken
          ? yield* this.#options.botToken(bot)
          : null;
    if (
      !token ||
      this.#options.connectionGeneration(bot) !== generation ||
      request.headers.origin !== this.#options.publicOrigin ||
      !telegramMiniAppOwner(request.headers.authorization, token, this.#options.ownerId, Math.floor(Date.now() / 1000))
    )
      return null;
    return { bot, generation };
  }).bind(this);

  /** Private prompts in this bot's scope, with a handle that names the bot, so another view cannot answer them. */
  #promptsFor(bot: number) {
    const prompts = this.#options.agents.privatePrompts?.() ?? [];
    return prompts
      .filter((prompt) => this.#options.ownsTurn(prompt.agentId, prompt.turnId, bot))
      .map((prompt) => ({
        prompt,
        handle: createHmac("sha256", this.#requestKey)
          .update(
            JSON.stringify([
              this.#options.ownerId,
              bot,
              this.#options.connectionGeneration(bot),
              prompt.agentId,
              prompt.threadId,
              prompt.turnId,
              prompt.requestId,
              "prompt",
            ]),
          )
          .digest("base64url"),
      }));
  }

  /** The answers the prompt's questions allow, or null. Only the ids it asks; one value unless it takes several. */
  #validAnswers(questions: readonly AgentPromptQuestion[], answers: Readonly<Record<string, readonly string[]>>) {
    const result: Record<string, string[]> = {};
    for (const [id, values] of Object.entries(answers)) {
      const question = questions.find((candidate) => candidate.id === id);
      if (!question) return null;
      const limit = question.multiSelect ? Math.max(1, question.options?.length ?? 1) : 1;
      if (values.length > limit) return null;
      if (values.length) result[id] = [...values];
    }
    return result;
  }

  /** Bind a still to one document and chat. A navigation requires a new handle. */
  #tabHandle(bot: number, agentId: string, tabId: string, page: string) {
    return createHmac("sha256", this.#requestKey)
      .update(
        JSON.stringify([
          this.#options.ownerId,
          bot,
          this.#options.connectionGeneration(bot),
          agentId,
          tabId,
          page,
          "tab",
        ]),
      )
      .digest("base64url");
  }

  /** A request expires when it leaves the registry, changes destination, or the service restarts. */
  #handleFor(bot: number, request: BrowserTakeoverRequest) {
    return createHmac("sha256", this.#requestKey)
      .update(
        JSON.stringify([
          this.#options.ownerId,
          bot,
          this.#options.connectionGeneration(bot),
          request.agentId,
          request.threadId,
          request.turnId,
          request.requestId,
          request.tabId,
          request.secret?.origin,
          request.secret?.method,
        ]),
      )
      .digest("base64url");
  }

  #previews(bot: number, agents: readonly TelegramMiniAppAgent[], requests: readonly BrowserTakeoverRequest[]) {
    const browser = this.#options.browser;
    if (!browser) return [];
    const tabs = browser.listTabs();
    const agentId = this.#options.botAgent?.(bot) ?? null;
    if (!agentId || !agents.some((agent) => agent.active && agent.agentId === agentId)) return [];
    return tabs.flatMap((tab) => {
      const origin = siteOrigin(tab.url);
      if (
        tab.ownerAgentId !== agentId ||
        tab.userControl ||
        requests.some((item) => item.tabId === tab.id && item.secret) ||
        !origin
      )
        return [];
      return [{ handle: this.#tabHandle(bot, agentId, tab.id, tab.url), origin, agentId, tabId: tab.id }];
    });
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
      path !== `${TELEGRAM_MINI_APP_PATH}/preview` &&
      path !== `${TELEGRAM_MINI_APP_PATH}/mcp` &&
      path !== TELEGRAM_MCP_CALLBACK_PATH &&
      path !== `${TELEGRAM_MINI_APP_PATH}/answer`
    )
      return false;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (path === TELEGRAM_MCP_CALLBACK_PATH) {
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return true;
      }
      const query = new URLSearchParams(request.url?.slice(path.length + 1));
      const outcome = this.#options.mcp?.callback(query) ?? "invalid";
      const t = translateFor(resolveLocale("system", request.headers["accept-language"]?.split(",")[0] ?? "en"));
      const message =
        outcome === "accepted"
          ? t("browser.telegram.mcpReturn")
          : outcome === "denied"
            ? t("error.mcp.redirectRefused")
            : t("error.mcp.redirectNoSignIn");
      response
        .writeHead(outcome === "accepted" ? 200 : 400, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        })
        .end(message);
      return true;
    }
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
    if (this.#options.connectionGeneration(bot) !== access.generation) {
      response.writeHead(409).end();
      return true;
    }
    if (path === `${TELEGRAM_MINI_APP_PATH}/mcp`) {
      const parsed = decodePreview(body.success.toString("utf8"));
      if (Option.isNone(parsed)) {
        response.writeHead(400).end();
        return true;
      }
      const result = this.#options.mcp ? yield* this.#options.mcp.start(bot, parsed.value.handle) : null;
      const authorized = yield* this.#authorize(request);
      if (
        !result ||
        authorized?.generation !== access.generation ||
        (result.url && !this.#options.mcp?.list(bot).some((card) => card.handle === parsed.value.handle))
      ) {
        response.writeHead(409).end();
        return true;
      }
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(result));
      return true;
    }
    const agents = this.#options.listAgents(bot);
    const takeovers = this.#options.agents.pendingBrowserTakeovers();
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
      const capture = yield* Effect.result(browser.captureOwnerTab(item.tabId, item.agentId));
      const authorized = yield* this.#authorize(request);
      const current = this.#previews(
        bot,
        this.#options.listAgents(bot),
        this.#options.agents.pendingBrowserTakeovers(),
      );
      if (
        authorized?.generation !== access.generation ||
        capture._tag !== "Success" ||
        !capture.success ||
        !current.some((preview) => preview.handle === handle) ||
        !capture.success.current()
      ) {
        response.writeHead(409).end();
        return true;
      }
      response.writeHead(200, { "Content-Type": "image/jpeg" }).end(capture.success.bytes);
      return true;
    }
    if (path === `${TELEGRAM_MINI_APP_PATH}/answer`) {
      const parsed = decodePromptAnswer(body.success.toString("utf8"));
      const respond = this.#options.agents.respondToPrompt;
      if (Option.isNone(parsed) || !respond) {
        response.writeHead(400).end();
        return true;
      }
      // Read the prompts again after the body: the turn can have ended or moved to another chat.
      const current = this.#promptsFor(bot).find((item) => item.handle === parsed.value.handle);
      if (!current) {
        response.writeHead(409).end();
        return true;
      }
      const answers =
        parsed.value.decision === "skip"
          ? {}
          : this.#validAnswers(current.prompt.questions, parsed.value.answers ?? {});
      if (!answers) {
        response.writeHead(400).end();
        return true;
      }
      const answered = yield* Effect.result(respond({ requestId: current.prompt.requestId, answers }));
      response.writeHead(answered._tag === "Success" ? 204 : 409).end();
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
                handle: this.#handleFor(bot, item),
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
          signIns: this.#options.mcp?.list(bot) ?? [],
          prompts: this.#promptsFor(bot).map(({ prompt, handle }) => ({
            handle,
            agentId: prompt.agentId,
            agentName: this.#options.agents.listAgents?.().find((agent) => agent.id === prompt.agentId)?.name ?? "",
            form: prompt.form,
            questions: prompt.questions.map(({ id, header, question, isSecret, options, multiSelect }) => ({
              id,
              header,
              question,
              isSecret,
              options: options?.map(({ label, description }) => ({ label, description })) ?? null,
              multiSelect: multiSelect === true,
            })),
          })),
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
    const pending = requests.find((item) => this.#handleFor(bot, item) === answer.handle);
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
