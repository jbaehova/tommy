import { createHash, randomUUID } from "node:crypto";
import { type AgentEvent, MCP_SIGN_IN_TIMEOUT_MS, type McpServerConfig, mcpSignInEvent } from "@tommy/contracts/ipc";
import { sourceTranslateFor } from "@tommy/i18n/source";
import { createTommyLogger } from "@tommy/logging";
import { Deferred, Effect, Option } from "effect";
import type { AgentService } from "../backend/agent-service";
import { mcpOAuthAccountKey, TELEGRAM_MCP_CALLBACK_PATH } from "../backend/mcp-oauth-provider";
import type { TelegramReplyMarkup } from "./telegram-api";

const logger = createTommyLogger("telegram-mcp");
type Route = { id: number; generation: string };
type Result = "connected" | "denied" | "expired" | "failed";
/** Shorter than the 30-second proxy timeout of the Mini App routes in scripts/hosting/nginx-tommy.conf. */
const START_WAIT_MS = 20_000;

interface Options {
  service: Pick<AgentService, "listMcpServers" | "signInMcpServer" | "listAgents">;
  publicOrigin: string;
  route(agentId: string, turnId: string): Route | null;
  receive(state: string, code: string | null): boolean;
  language(): "en" | "ko";
  send(
    chat: number,
    text: string,
    button: TelegramReplyMarkup | undefined,
    generation: string,
  ): Effect.Effect<void, Error>;
}

interface Card {
  id: string;
  route: Route;
  agentId: string;
  threadId: string;
  turnId: string;
  serverId: string;
  messageId: string;
  name: string;
  origin: string;
  configHash: string;
  account: string;
  timer: NodeJS.Timeout;
  deadline: number;
  done: boolean;
  attempt?: {
    controller: AbortController;
    ready: Deferred.Deferred<string | null>;
    state: string | null;
    returned: boolean;
  };
}

function fingerprint(config: McpServerConfig) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

/** A process owns the PKCE exchange. Only the original owner's chat can start or finish its card. */
export class TelegramMcpSignIn {
  readonly #cards = new Map<string, Card>();
  readonly #seen = new Map<string, number>();
  readonly #started = Date.now();

  constructor(private readonly options: Options) {}

  observe(event: AgentEvent): void {
    if (event.type === "conversation-messages-deleted") {
      for (const id of event.messageIds) {
        const card = this.#cards.get(id);
        if (card?.agentId === event.agentId && card.threadId === event.threadId) this.#end(card);
      }
      return;
    }
    if (event.type !== "conversation" || !event.snapshot.threadId) return;
    const { agentId, threadId, messages } = event.snapshot;
    const now = Date.now();
    for (const [id, until] of this.#seen) if (until <= now) this.#seen.delete(id);
    for (const message of messages) {
      if (!message.turnId || this.#seen.has(message.id)) continue;
      const signIn = mcpSignInEvent(message);
      if (!signIn) continue;
      const created = Date.parse(message.createdAt);
      const deadline = created + MCP_SIGN_IN_TIMEOUT_MS;
      if (!Number.isFinite(created) || created < this.#started || created > now || deadline <= now) continue;
      const route = this.options.route(agentId, message.turnId);
      const config = this.#config(signIn.mcpServerId);
      const url = config && URL.parse(config.url);
      const account = config && mcpOAuthAccountKey(config.url);
      if (this.#seen.size >= 512) continue;
      // A later binding must never acquire a card that was first observed without its owner.
      this.#seen.set(message.id, deadline);
      if (!route || !config || !account || !url) continue;
      const card: Card = {
        id: randomUUID(),
        route,
        agentId,
        threadId,
        turnId: message.turnId,
        serverId: config.id,
        messageId: message.id,
        configHash: fingerprint(config),
        account,
        name: config.name,
        origin: url.origin,
        deadline,
        done: false,
        timer: setTimeout(() => this.#finish(card, "expired"), deadline - now),
      };
      card.timer.unref();
      this.#cards.set(message.id, card);
      const t = sourceTranslateFor(this.options.language());
      this.#send(card, t("status.messaging.telegramMcpRequested", { name: card.name }), {
        inline_keyboard: [
          [
            {
              text: t("status.messaging.telegramMcpConnect"),
              web_app: { url: `${this.options.publicOrigin}/tommy/telegram/app?bot=${route.id}` },
            },
          ],
        ],
      });
    }
  }

  #config(id: string) {
    return this.options.service
      .listMcpServers()
      .find((row) => row.enabled && row.transport === "http" && row.id === id);
  }

  #bound(card: Card) {
    const route = this.options.route(card.agentId, card.turnId);
    const config = this.#config(card.serverId);
    return (
      route?.id === card.route.id &&
      route.generation === card.route.generation &&
      config !== undefined &&
      fingerprint(config) === card.configHash
    );
  }

  #valid(card: Card) {
    return !card.done && Date.now() < card.deadline && Boolean(this.#bound(card));
  }

  list(chat: number) {
    return [...this.#cards.values()]
      .filter((card) => card.route.id === chat && this.#valid(card))
      .map((card) => ({
        handle: card.id,
        agentId: card.agentId,
        agentName: this.options.service.listAgents().find((entry) => entry.id === card.agentId)?.name ?? "",
        name: card.name,
        origin: card.origin,
      }));
  }

  /** The returned URL is shown only to the private WebView after its launch data was checked. */
  start(chat: number, handle: string): Effect.Effect<{ url: string | null } | null> {
    return Effect.gen({ self: this }, function* () {
      const card = [...this.#cards.values()].find((entry) => entry.id === handle && entry.route.id === chat);
      if (!card || !this.#valid(card)) return null;
      const config = this.#config(card.serverId);
      if (!config) return null;
      if (card.attempt?.returned) return { url: null };
      if (!card.attempt) {
        if (
          [...this.#cards.values()].some(
            (other) => other !== card && !other.done && other.attempt && other.account === card.account,
          )
        )
          return null;
        const ready = Deferred.makeUnsafe<string | null>();
        const controller = new AbortController();
        const attempt: NonNullable<Card["attempt"]> = { ready, controller, state: null, returned: false };
        card.attempt = attempt;
        const open = Object.assign(
          async (raw: string) => {
            const url = URL.parse(raw);
            const state = url?.searchParams.get("state");
            if (
              !this.#valid(card) ||
              !url ||
              url.protocol !== "https:" ||
              url.username ||
              url.password ||
              !state ||
              url.searchParams.getAll("state").length !== 1 ||
              url.searchParams.getAll("redirect_uri").length !== 1 ||
              url.searchParams.get("redirect_uri") !== this.options.publicOrigin + TELEGRAM_MCP_CALLBACK_PATH ||
              url.searchParams.get("code_challenge_method") !== "S256" ||
              !url.searchParams.get("code_challenge")
            ) {
              throw new Error("The authorization request is no longer available.");
            }
            attempt.state = state;
            Deferred.doneUnsafe(ready, Effect.succeed(url.href));
          },
          { telegramAuthorized: () => this.#valid(card) },
        );
        void Effect.runPromise(this.options.service.signInMcpServer({ config }, open), { signal: controller.signal })
          .then((result) => this.#finish(card, result.error === null ? "connected" : "failed"))
          .catch(() => this.#finish(card, "failed"));
      }
      // The proxy ends a Mini App request after 30 seconds. A slow provider leaves the attempt
      // running, and the owner can press the button again to wait for the same URL.
      const ready = yield* Deferred.await(card.attempt.ready).pipe(Effect.timeoutOption(START_WAIT_MS));
      if (Option.isNone(ready)) return null;
      const url = ready.value;
      return this.#bound(card) && (!url || this.#valid(card)) ? { url } : null;
    });
  }

  callback(query: URLSearchParams): "accepted" | "denied" | "invalid" {
    const state = query.get("state");
    const denied = query.has("error");
    const code = query.get("code");
    if (
      !state ||
      query.getAll("state").length !== 1 ||
      query.getAll("error").length > 1 ||
      (denied ? query.has("code") : !code || code.length > 8192 || query.getAll("code").length !== 1)
    )
      return "invalid";
    const card = [...this.#cards.values()].find((entry) => entry.attempt?.state === state);
    if (!card || !this.#valid(card) || !this.options.receive(state, denied ? null : code)) return "invalid";
    if (card.attempt) {
      card.attempt.state = null;
      card.attempt.returned = true;
    }
    if (denied) this.#finish(card, "denied");
    return denied ? "denied" : "accepted";
  }

  #send(card: Card, text: string, markup?: TelegramReplyMarkup) {
    if (!this.#bound(card)) return;
    void Effect.runPromise(this.options.send(card.route.id, text, markup, card.route.generation)).catch(() =>
      logger.warn("Could not send the MCP sign-in notice."),
    );
  }

  #finish(card: Card, outcome: Result) {
    if (card.done) return;
    const t = sourceTranslateFor(this.options.language());
    const keys = {
      connected: "status.messaging.telegramMcpConnected",
      denied: "status.messaging.telegramMcpDenied",
      expired: "status.messaging.telegramMcpExpired",
      failed: "status.messaging.telegramMcpFailed",
    } as const;
    this.#send(card, t(keys[outcome], { name: card.name }));
    this.#end(card);
  }

  #end(card: Card) {
    card.done = true;
    clearTimeout(card.timer);
    if (card.attempt) {
      if (card.attempt.state) this.options.receive(card.attempt.state, null);
      Deferred.doneUnsafe(card.attempt.ready, Effect.succeed(null));
      card.attempt.controller.abort();
    }
    this.#cards.delete(card.messageId);
  }

  stop(): void {
    for (const card of this.#cards.values()) this.#end(card);
    this.#seen.clear();
  }
}
