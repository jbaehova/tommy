import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { AgentEvent } from "@tommy/contracts/ipc";
import { sourceTranslateFor } from "@tommy/i18n/source";
import { createTommyLogger, redactText } from "@tommy/logging";
import { classifyUserError } from "@tommy/user-errors";
import { Effect } from "effect";
import type { AgentService } from "../backend/agent-service";
import type { BrowserHost } from "../backend/browser-host";
import type { AgentMessageNotice, MailboxStore } from "../backend/mailbox-store";
import type { McpOAuth } from "../backend/mcp-oauth-provider";
import type { SidebarLayoutStore } from "../backend/sidebar-layout-store";
import type { TommyDatabase } from "../backend/tommy-database";
import { TelegramAgentHost } from "./telegram-agent-host";
import { TelegramApi, TelegramApiFailure } from "./telegram-api";
import { TelegramAttention } from "./telegram-attention";
import { telegramBrowserReport } from "./telegram-browser-report";
import { TelegramCommands } from "./telegram-commands";
import { TelegramDelivery } from "./telegram-delivery";
import { chatReady, type TelegramConnection, TelegramDirectory } from "./telegram-directory";
import { escapeTelegramHtml, maskEmails, telegramHtml } from "./telegram-format";
import { TelegramMcpSignIn } from "./telegram-mcp-sign-in";
import { TelegramMiniApp } from "./telegram-mini-app";
import { TelegramProfile } from "./telegram-profile";
import type { TelegramSettings } from "./telegram-settings";
import { TelegramStatus } from "./telegram-status";
import { TelegramVps } from "./telegram-vps";

const logger = createTommyLogger("telegram-vps");

interface RuntimeOptions {
  settings: TelegramSettings;
  dataRoot: string;
  service: AgentService;
  sidebar: SidebarLayoutStore;
  mailbox: MailboxStore;
  database: TommyDatabase;
  mcpOAuth: Pick<McpOAuth, "receiveTelegramAuthorization">;
  browser: BrowserHost;
  ready: () => boolean;
}

/** The only composition boundary between Telegram and the personal VPS. */
export function createTelegramRuntime({
  settings,
  dataRoot,
  service,
  sidebar,
  mailbox,
  database,
  mcpOAuth,
  browser,
  ready,
}: RuntimeOptions) {
  const directory = new TelegramDirectory(
    join(dataRoot, "telegram-connections-v1.json"),
    settings.managerId,
    settings.ownerId,
  );
  /** The root agent's chat is the manager's own chat. The manager always belongs to the owner. */
  const rootConnection = (): TelegramConnection | undefined => {
    const binding = directory.managerAgent();
    if (!binding) return undefined;
    const name = service.listAgents().find((agent) => agent.id === binding.agentId)?.name ?? "";
    return {
      id: settings.managerId,
      username: vps.managerUsername,
      name,
      agentId: binding.agentId,
      operationId: binding.operationId,
      verified: true,
      ownerConfirmed: true,
    };
  };
  const connection = (id: number) => (id === settings.managerId ? rootConnection() : directory.get(id));
  const agents = new TelegramAgentHost(service, sidebar, mailbox, database, (id, agentId) => {
    const entry = connection(id);
    return chatReady(entry) && entry.agentId === agentId ? entry.operationId : null;
  });
  const connections = () => {
    const root = rootConnection();
    return root ? [root, ...directory.list()] : directory.list();
  };
  const api = new TelegramApi();
  const profile = new TelegramProfile(service, directory, api, settings);
  const delivery = new TelegramDelivery({
    path: join(dataRoot, "telegram-delivery-v1.json"),
    managerId: settings.managerId,
    ownerId: settings.ownerId,
    managerToken: settings.token,
    directory: { get: connection },
    agents,
    api,
    ready: () => ready() && vps.workReady,
  });
  const vps = new TelegramVps({
    settings,
    directory,
    agents,
    api,
    ready,
    profile,
    retryChat: (id) => delivery.retryChat(id),
    commands: new TelegramCommands({ service, dataRoot }),
    timeZone: () => ownerTimeZone(),
    agentProfile: (agentId) => {
      const agent = service.listAgents().find((entry) => entry.id === agentId);
      return agent ? { name: agent.name, title: agent.title, description: agent.description } : null;
    },
    stop: (agentId) =>
      Effect.gen(function* () {
        const turnId = service.activeTurnId(agentId);
        if (turnId) yield* service.interrupt(agentId, turnId);
        return turnId !== null;
      }),
  });
  const available = (id: string | null) => Boolean(id && vps.workReady && ready() && agents.isAvailable(id));
  const activeAgentForBot = (telegramId: number) => {
    const entry = connection(telegramId);
    return chatReady(entry) && available(entry.agentId) ? entry.agentId : null;
  };
  const turnOwner = (id: string, turnId: string) =>
    connections().find(
      (entry) =>
        entry.agentId === id &&
        chatReady(entry) &&
        available(id) &&
        agents.canInspectTurn(id, turnId, entry.id, settings.ownerId, activeAgentForBot),
    );
  /** A browser request from work that the owner started in Telegram, even after a delegation inside Tommy. */
  const requestChat = (id: string, turnId: string) => {
    const owner = turnOwner(id, turnId);
    if (owner) return owner;
    // A routine's browser request goes to the agent's own chat.
    if (agents.routineTurn(id, turnId)) return chatFor(id);
    const traced = available(id) ? agents.tracedChat(id, turnId, settings.ownerId, activeAgentForBot) : null;
    const origin = traced === null ? undefined : connection(traced);
    if (!chatReady(origin) || !available(origin.agentId)) return undefined;
    return connections().find((entry) => entry.agentId === id && chatReady(entry)) ?? origin;
  };
  /** The manager opens the owner's whole view. An agent bot sees the requests sent to its own chat. */
  agents.setRoutineChat((agentId) => {
    const chat = chatFor(agentId);
    return chat && vps.workReady && ready() ? { telegramId: chat.id, ownerId: settings.ownerId } : null;
  });
  const ownsTurn = (id: string, turnId: string, bot: number) => {
    const chat = requestChat(id, turnId);
    return chat !== undefined && (bot === settings.managerId || chat.id === bot);
  };
  const botToken = (id: number) =>
    Effect.gen(function* () {
      const before = directory.get(id);
      if (!chatReady(before) || !vps.workReady) return null;
      const token = yield* api.getManagedBotToken(settings.token, id);
      const after = directory.get(id);
      return chatReady(after) && before.operationId === after.operationId && vps.workReady ? token : null;
    }).pipe(Effect.orElseSucceed(() => null));
  const tokenFor = (id: number) => (id === settings.managerId ? Effect.succeed(settings.token) : botToken(id));
  const mcp = new TelegramMcpSignIn({
    service,
    publicOrigin: settings.publicOrigin,
    route: (agentId, turnId) => {
      const entry = requestChat(agentId, turnId);
      return entry ? { id: entry.id, generation: entry.operationId } : null;
    },
    receive: (state, code) => mcpOAuth.receiveTelegramAuthorization(state, code),
    language: () => vps.language,
    send: (id, text, button, generation) =>
      Effect.gen(function* () {
        const token = yield* tokenFor(id);
        const current = connection(id);
        if (token && chatReady(current) && current.operationId === generation)
          yield* api.sendMessage(token, settings.ownerId, text, button);
      }),
  });
  browser.setManualStepReporter(
    telegramBrowserReport({
      browser,
      requestChat,
      tokenFor,
      ownerId: settings.ownerId,
      api,
      language: () => vps.language,
    }),
  );
  const app = new TelegramMiniApp({
    mcp,
    publicOrigin: settings.publicOrigin,
    ownerId: settings.ownerId,
    managerToken: settings.token,
    managerId: settings.managerId,
    botToken,
    connectionGeneration: (id: number) => {
      if (id === settings.managerId) return directory.managerAgent()?.operationId ?? "manager-unassigned";
      const entry = connection(id);
      return chatReady(entry) ? entry.operationId : null;
    },
    botAgent: (bot) => activeAgentForBot(bot),
    agents: service,
    listAgents: (bot) => {
      const all = connections().filter((entry) => bot === settings.managerId || entry.id === bot);
      const listed = all.map((entry) => ({
        agentId: entry.agentId,
        name: entry.name,
        username: entry.username,
        active: chatReady(entry) && available(entry.agentId),
      }));
      // An agent without its own bot can still ask for a password in work that the owner started.
      const names = new Map(service.listAgents().map((agent) => [agent.id, agent.name]));
      for (const request of service.pendingBrowserTakeovers()) {
        if (listed.some((entry) => entry.agentId === request.agentId)) continue;
        const chat = requestChat(request.agentId, request.turnId);
        if (chat && (bot === settings.managerId || chat.id === bot))
          listed.push({
            agentId: request.agentId,
            name: names.get(request.agentId) ?? chat.name,
            username: chat.username,
            active: true,
          });
      }
      return listed;
    },
    ownsTurn,
    browser,
  });
  const notification = (event: AgentEvent) => {
    if (event.type !== "browser-takeover-requested" || !event.request.secret) return;
    const { agentId, turnId } = event.request;
    const entry = requestChat(agentId, turnId);
    if (!entry) return;
    void Effect.runPromise(vps.notifyOwner(entry.id)).catch(() =>
      logger.warn("Telegram could not notify the owner of a browser request."),
    );
  };
  /** Agents talk inside Tommy. Each agent's own chat shows what it sent and what it received. */
  const chatFor = (agentId: string) => connections().find((entry) => entry.agentId === agentId && chatReady(entry));
  const sendTo = (id: number, text: string, html: boolean): Effect.Effect<void, Error> =>
    id === settings.managerId
      ? api.sendMessage(settings.token, settings.ownerId, text, undefined, html)
      : vps.sendFromAgent(id, settings.ownerId, text, undefined, html);
  /** Formatted, with the plain text as the fallback when Telegram cannot parse it. */
  const postToChat = (id: number, title: string, body: string) => {
    const plain = `${title}\n${body}`;
    const html = `<b>${escapeTelegramHtml(title)}</b>\n${telegramHtml(body)}`;
    if (html.length > 4096) return sendTo(id, plain, false);
    return sendTo(id, html, true).pipe(
      Effect.catch((error) =>
        error instanceof TelegramApiFailure && error.kind === "api" && error.status === 400
          ? sendTo(id, plain, false)
          : Effect.fail(error),
      ),
    );
  };
  const mirror = (notice: AgentMessageNotice) => {
    if (!vps.workReady || !ready()) return;
    const names = new Map(service.listAgents().map((agent) => [agent.id, agent.name]));
    const body = maskEmails(notice.text.trim());
    if (!body) return;
    const clip = (text: string) => (text.length > 3500 ? `${text.slice(0, 3499)}…` : text);
    const posts: { id: number; title: string }[] = [];
    const sender = chatFor(notice.senderAgentId);
    const recipients = notice.recipientAgentIds.map((id) => names.get(id) ?? id).join(", ");
    if (sender) posts.push({ id: sender.id, title: `→ ${recipients}` });
    for (const recipientId of notice.recipientAgentIds) {
      const chat = chatFor(recipientId);
      if (chat && chat.id !== sender?.id)
        posts.push({ id: chat.id, title: `← ${names.get(notice.senderAgentId) ?? notice.senderAgentId}` });
    }
    for (const post of posts)
      void Effect.runPromise(postToChat(post.id, post.title, clip(body))).catch(() =>
        logger.warn("Telegram could not show a message between agents."),
      );
  };
  const stopMirror = mailbox.onAgentMessage(mirror);
  /** "typing" in the agent's chat while its turn runs. Telegram clears it after five seconds. */
  const typing = new Map<string, { timer: NodeJS.Timeout; until: number }>();
  const stopTyping = (key: string) => {
    const entry = typing.get(key);
    if (entry) clearTimeout(entry.timer);
    typing.delete(key);
  };
  const showTyping = (agentId: string, turnId: string) => {
    const key = `${agentId}:${turnId}`;
    stopTyping(key);
    const until = Date.now() + 30 * 60_000;
    const tick = () => {
      const entry = typing.get(key);
      if (!entry || Date.now() > entry.until) return stopTyping(key);
      entry.timer = setTimeout(tick, 4_500);
      entry.timer.unref();
      if (!vps.workReady || !ready()) return;
      const chat = requestChat(agentId, turnId);
      if (!chat) return;
      const send = Effect.gen(function* () {
        const token = chat.id === settings.managerId ? settings.token : yield* botToken(chat.id);
        if (token) yield* api.sendTyping(token, settings.ownerId);
      });
      void Effect.runPromise(send).catch(() => {});
    };
    // The turn's deliveries are marked shortly after it starts, so the first check waits briefly.
    const timer = setTimeout(tick, 400);
    timer.unref();
    typing.set(key, { timer, until });
  };
  const typingEvents = (event: AgentEvent) => {
    if (event.type === "turn-started" && event.origin !== "routine") showTyping(event.agentId, event.turnId);
    else if (event.type === "turn-completed") stopTyping(`${event.agentId}:${event.turnId}`);
  };
  /** With the token of the chat's bot, or a failure when the bot is not connected now. */
  const withToken = <A>(chat: number, run: (token: string) => Effect.Effect<A, Error>) =>
    Effect.gen(function* () {
      const token = yield* tokenFor(chat);
      if (!token) return yield* Effect.fail(new Error("Telegram connection is unavailable."));
      return yield* run(token);
    });
  /** One message in the chat of a long turn that says what the agent does. See `TelegramStatus`. */
  const status = new TelegramStatus({
    chat: (agentId, turnId) => (vps.workReady && ready() ? (requestChat(agentId, turnId)?.id ?? null) : null),
    send: (chat, text) => withToken(chat, (token) => api.sendStatus(token, settings.ownerId, text)),
    edit: (chat, messageId, text) =>
      withToken(chat, (token) => api.editStatus(token, settings.ownerId, messageId, text)),
    remove: (chat, messageId) => withToken(chat, (token) => api.deleteMessage(token, settings.ownerId, messageId)),
    note: (agentId, threadId, turnId) => agents.turnNote(agentId, threadId, turnId),
    language: () => vps.language,
  });
  const attention = new TelegramAttention({
    appButton: (chat) => ({
      inline_keyboard: [
        [
          {
            text: sourceTranslateFor(vps.language)("status.messaging.telegramOpenApp"),
            web_app: { url: `${settings.publicOrigin}/tommy/telegram/app?bot=${chat}` },
          },
        ],
      ],
    }),
    isPrivate: (requestId) => service.privatePrompts().some((prompt) => prompt.requestId === requestId),
    chatFor: (agentId, turnId) => requestChat(agentId, turnId)?.id ?? null,
    agentName: (agentId) => service.listAgents().find((agent) => agent.id === agentId)?.name ?? agentId,
    send: (chat, html, markup) =>
      chat === settings.managerId
        ? api.sendMessage(settings.token, settings.ownerId, html, markup, true)
        : vps.sendFromAgent(chat, settings.ownerId, html, markup, true),
    deleteMessage: (chat, messageId) =>
      Effect.gen(function* () {
        const token = yield* tokenFor(chat);
        if (token) yield* api.deleteMessage(token, settings.ownerId, messageId);
      }),
    respondToPrompt: (requestId, answers) => service.respondToPrompt({ requestId, answers }),
    respondToApproval: (requestId, decision) => service.respondToApproval({ requestId, decision }),
    language: () => vps.language,
  });
  /**
   * The owner's time zone for times in chat. The server runs in UTC, so use TOMMY_TIMEZONE, then the
   * zone the owner gave the root agent's routines, then any routine, then the server's own.
   */
  const ownerTimeZone = () => {
    const valid = (zone: string | undefined): zone is string => {
      if (!zone) return false;
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    };
    const configured = process.env.TOMMY_TIMEZONE;
    if (valid(configured)) return configured;
    const root = directory.managerAgent()?.agentId;
    const agentIds = [...(root ? [root] : []), ...service.listAgents().map((agent) => agent.id)];
    for (const agentId of agentIds)
      for (const routine of service.listRoutines(agentId)) if (valid(routine.timezone)) return routine.timezone;
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  };
  /** Provider errors and plan limits in the agent's own chat, at most once in ten minutes each. */
  const reported = new Map<string, number>();
  const problems = (event: AgentEvent) => {
    let agentId: string;
    let text: string;
    if (event.type === "error" && event.code === "agent_error" && event.agentId) {
      agentId = event.agentId;
      text =
        classifyUserError(event.message) === "auth"
          ? sourceTranslateFor(vps.language)("status.messaging.telegramSignInExpired")
          : `⚠️ ${maskEmails(event.message)}`;
    } else if (event.type === "usage-limit-reached") {
      agentId = event.agentId;
      const t = sourceTranslateFor(vps.language);
      text =
        event.resetsAt === null
          ? t("status.messaging.telegramLimitLater")
          : t("status.messaging.telegramLimit", {
              time: new Date(event.resetsAt * 1000).toLocaleString(vps.language === "ko" ? "ko-KR" : "en-US", {
                timeZone: ownerTimeZone(),
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              }),
            });
    } else return;
    const chat = connections().find((entry) => entry.agentId === agentId && chatReady(entry));
    if (!chat || !vps.workReady) return;
    const key = `${agentId}:${text}`;
    if ((reported.get(key) ?? 0) > Date.now() - 10 * 60_000) return;
    reported.set(key, Date.now());
    if (reported.size > 200) reported.clear();
    void Effect.runPromise(sendTo(chat.id, redactText(text).slice(0, 4000), false)).catch(() =>
      logger.warn("Telegram could not report an agent problem."),
    );
  };
  let replyEvents: (event: AgentEvent) => void = () => {};
  // One listener for all Telegram views of agent events.
  const onEvent = (event: AgentEvent) => {
    mcp.observe(event);
    notification(event);
    typingEvents(event);
    status.observe(event);
    attention.observe(event);
    problems(event);
    replyEvents(event);
  };
  service.on("event", onEvent);
  vps.setAttention((chat, text, messageId) => attention.take(chat, text, messageId));
  let stopReplies = () => {};
  let heartbeat: NodeJS.Timeout | null = null;
  const handoffHeaders = {
    work: "[Context handoff] This summary comes from a session on another computer of the user. Treat it as the context of that session and continue from its next step. Paths in it are on that computer, and you cannot read that session.",
    record:
      "[Context handoff: record only] This summary comes from a session on another computer of the user. Keep it as a record. Do not start the work or change anything. Answer with one short confirmation, and use it when the user asks about it later.",
  } as const;
  const askHeader =
    "[Question from another session] A coding session on the user's computer asks you this. Answer it in your reply: the session reads your reply as text. Do only the work that the question needs.";
  const findAgent = (name: string) => {
    const wanted = name.toLowerCase();
    return service
      .listAgents()
      .find((entry) => entry.hiddenAt === undefined && (entry.id === name || entry.name.toLowerCase() === wanted));
  };
  return {
    /** A notice for the owner in the manager chat. False when Telegram cannot send it now. */
    tellOwner: vps.tellOwner,
    /** The visible agents, for a handoff from another computer. */
    agents() {
      return service
        .listAgents()
        .filter((agent) => agent.hiddenAt === undefined)
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          provider: agent.provider,
          chat: chatFor(agent.id) !== undefined,
        }));
    },
    /**
     * A session summary from another computer. It enters the agent's Telegram chat as the owner's
     * message, so the answer comes back to that chat. An agent without a chat gets it inside Tommy.
     */
    handoff: Effect.fn("TelegramRuntime.handoff")(function* (input: {
      agent: string;
      mode: "work" | "record";
      source: string;
      text: string;
    }) {
      const agent = findAgent(input.agent);
      if (!agent) return yield* Effect.fail(new Error(`No agent is called ${input.agent}.`));
      const redacted = redactText(input.text);
      const redactions =
        (redacted.match(/\[redacted/gu) ?? []).length - (input.text.match(/\[redacted/gu) ?? []).length;
      const source = input.source ? `\nSource: ${input.source}` : "";
      const message = `${handoffHeaders[input.mode]}${source}\n\n${redacted}`.slice(0, 100_000);
      const chat = vps.workReady && ready() ? chatFor(agent.id) : undefined;
      if (chat) {
        const t = sourceTranslateFor(vps.language);
        const notice = t(
          input.mode === "work" ? "status.messaging.telegramHandoffWork" : "status.messaging.telegramHandoffRecord",
          {
            source: input.source || "Mac",
          },
        );
        yield* sendTo(chat.id, notice, false).pipe(Effect.ignore);
        yield* agents.submit(agent.id, chat.id, settings.ownerId, Date.now(), message, [], chat.operationId);
      } else {
        yield* service.sendMessage({ agentId: agent.id, text: message });
      }
      return {
        agentId: agent.id,
        agentName: agent.name,
        chat: chat !== undefined,
        characters: message.length,
        redactions: Math.max(0, redactions),
      };
    }),
    /**
     * A question from a session on another computer. The agent answers it like an owner's message, in
     * its Telegram chat when it has one, and the answer text goes back to the caller.
     */
    ask: Effect.fn("TelegramRuntime.ask")(function* (input: {
      agent: string;
      source: string;
      text: string;
      timeoutSeconds: number;
    }) {
      const agent = findAgent(input.agent);
      if (!agent) return yield* Effect.fail(new Error(`No agent is called ${input.agent}.`));
      const source = input.source || "another session";
      const message = `${askHeader}\nSource: ${source}\n\n${redactText(input.text)}`.slice(0, 100_000);
      const chat = vps.workReady && ready() ? chatFor(agent.id) : undefined;
      // The notice follows the queued question, so a failed send leaves no notice in the chat.
      const notice = chat
        ? sendTo(
            chat.id,
            sourceTranslateFor(vps.language)("status.messaging.telegramAskNotice", { source }),
            false,
          ).pipe(Effect.ignore)
        : Effect.void;
      const timeout = Math.min(Math.max(Math.trunc(input.timeoutSeconds) || 600, 1), 1800) * 1000;
      const answer = yield* agents.ask(
        agent.id,
        chat ? { telegramId: chat.id, ownerId: settings.ownerId, generation: chat.operationId } : null,
        message,
        timeout,
        notice,
      );
      return {
        agentId: agent.id,
        agentName: agent.name,
        chat: chat !== undefined,
        status: answer ? answer.status : ("pending" as const),
        text: answer?.text ?? "",
      };
    }),
    handle(request: IncomingMessage, response: ServerResponse) {
      if (!vps.listening && request.url?.startsWith("/tommy/telegram/")) {
        response.writeHead(503, { "cache-control": "no-store" }).end();
        return Effect.succeed(true);
      }
      return app
        .handle(request, response)
        .pipe(Effect.flatMap((handled) => (handled ? Effect.succeed(true) : vps.handle(request, response))));
    },
    start: Effect.gen(function* () {
      yield* vps.start(() =>
        Effect.gen(function* () {
          yield* delivery.start();
          const replies = agents.replies((reply) => {
            const entry = connection(reply.telegramId);
            if (reply.ownerId !== settings.ownerId || !chatReady(entry) || entry.agentId !== reply.agentId) return;
            void Effect.runPromise(delivery.enqueue(reply)).catch(() =>
              logger.warn("Telegram could not deliver an agent reply."),
            );
          });
          replyEvents = replies.observe;
          stopReplies = replies.stop;
        }),
      );
      const observe = () => {
        void Effect.runPromise(vps.checkManager())
          .catch(() => logger.warn("Telegram webhook health could not be confirmed."))
          .finally(() => {
            if (!vps.listening) return;
            heartbeat = setTimeout(observe, vps.workReady ? 10 * 60_000 : 5_000);
            heartbeat.unref();
          });
      };
      observe();
    }),
    stop: Effect.gen(function* () {
      if (heartbeat) clearTimeout(heartbeat);
      browser.setManualStepReporter(null);
      mcp.stop();
      stopReplies();
      stopMirror();
      service.off("event", onEvent);
      vps.setAttention(null);
      attention.close();
      for (const key of [...typing.keys()]) stopTyping(key);
      status.close();
      vps.close();
      yield* delivery.stop();
      yield* vps.awaitPending();
    }),
  };
}
