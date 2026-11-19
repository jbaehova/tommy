import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sourceText, sourceTranslateFor } from "@tommy/i18n/source";
import { Effect, Result, Schedule, Semaphore } from "effect";
import { readBodyWithin } from "./http-body";
import type { TelegramAgentHost } from "./telegram-agent-host";
import {
  decodeTelegramUpdate,
  type TelegramApi,
  TelegramApiFailure,
  type TelegramReplyMarkup,
  type TelegramUpdate,
} from "./telegram-api";
import { TELEGRAM_COMMAND_MENU, type TelegramCommands } from "./telegram-commands";
import { chatReady, type TelegramConnection, type TelegramDirectory } from "./telegram-directory";
import { TelegramDisconnect } from "./telegram-disconnect";
import type { TelegramProfile } from "./telegram-profile";
import type { TelegramSettings } from "./telegram-settings";
import { equalWebhookSecret } from "./workflow-connector-security";

interface Options {
  settings: TelegramSettings;
  directory: TelegramDirectory;
  api: TelegramApi;
  agents: Pick<TelegramAgentHost, "ensureAgent" | "describe" | "remove" | "submit" | "isAvailable" | "choices">;
  ready: () => boolean;
  profile?: Pick<TelegramProfile, "handle">;
  retryChat?: (id: number) => Effect.Effect<void, Error>;
  /** Stops the agent's running turn. False when nothing runs. */
  stop?: (agentId: string) => Effect.Effect<boolean, Error>;
  /** Agent settings and information commands, for the agent that answers in a chat. */
  commands?: Pick<TelegramCommands, "handle">;
  /** The owner's time zone for times in chat. */
  timeZone?: () => string;
  /** The agent's profile, so each bot shows who answers in it. */
  agentProfile?: (agentId: string) => { name: string; title: string; description: string } | null;
}

type Message = NonNullable<TelegramUpdate["message"]>;
type Translate = typeof sourceText;
const updatePath = "/tommy/telegram/update/";
const bodyLimit = 128 * 1024;

/** Puts two keyboard buttons on each row, so that a long agent list stays short. */
const pairs = <T>(buttons: ReadonlyArray<T>): T[][] => {
  const rows: T[][] = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  return rows;
};

/** Delivers private owner messages and receipts from known Telegram peers. Group updates are never owner authority. */
export class TelegramVps {
  readonly #options: Options;
  readonly #updates = Semaphore.makeUnsafe(1);
  readonly #disconnect: TelegramDisconnect;
  #language: "en" | "ko" = "en";
  #manager = "";
  #managerCaughtUp = false;
  /** The role that the owner gave with /new, for the next new agent. */
  #roleForNext: string | null = null;
  /** A new agent without a role. The owner's next plain message in the manager chat becomes its role. */
  #askingRole: { agentId: string; botId: number; username: string; name: string } | null = null;
  /** An agent delete that waits for the owner to send its code. */
  #deleting: { agentId: string; name: string; code: string; expires: number } | null = null;
  #closed = false;
  #attention: ((chat: number, text: string, messageId: number) => boolean) | null = null;

  constructor(options: Options) {
    this.#options = options;
    this.#disconnect = new TelegramDisconnect(options.directory);
  }

  /** A waiting agent question or approval takes the owner's next plain message in that chat. */
  setAttention(take: ((chat: number, text: string, messageId: number) => boolean) | null): void {
    this.#attention = take;
  }

  get language(): "en" | "ko" {
    return this.#language;
  }

  close(): void {
    this.#closed = true;
    this.#attention = null;
    this.#manager = "";
  }

  #secret(id: number) {
    const { settings, directory } = this.#options;
    const generation = id === settings.managerId ? "manager" : directory.get(id)?.operationId;
    if (!generation) return null;
    return createHmac("sha256", settings.token)
      .update(`tommy-hook:${settings.ownerId}:${id}:${generation}`)
      .digest("hex");
  }

  readonly #webhook = Effect.fn("TelegramVps.webhook")(function* (this: TelegramVps, id: number, token: string) {
    const secret = this.#secret(id);
    if (secret)
      yield* this.#options.api.setWebhook(token, this.#options.settings.publicOrigin + updatePath + id, secret);
    yield* this.#commands(id, token).pipe(Effect.ignore);
    yield* this.#profile(id, token).pipe(Effect.ignore);
  }).bind(this);

  /** The agent's description and title as the bot's profile text. A bot without an agent keeps its own. */
  readonly #profile = Effect.fn("TelegramVps.profile")(function* (this: TelegramVps, id: number, token: string) {
    const { directory, settings, agentProfile } = this.#options;
    const agentId = id === settings.managerId ? directory.managerAgent()?.agentId : directory.get(id)?.agentId;
    const profile = agentId && agentProfile ? agentProfile(agentId) : null;
    if (!profile) return;
    const description = profile.description || profile.title || profile.name;
    const short = profile.title || profile.description.split("\n")[0] || profile.name;
    yield* this.#options.api.setMyDescriptions(token, description, short);
  }).bind(this);

  /** The "/" menu of the manager (the root agent's chat) and of each agent bot, in English and Korean. */
  readonly #commands = Effect.fn("TelegramVps.commands")(function* (this: TelegramVps, id: number, token: string) {
    const manager = id === this.#options.settings.managerId;
    const names = manager
      ? (["connect", "new", "agents", "stop", "browser", "root", "disconnect", "delete"] as const)
      : (["stop", "browser", "engine", "name"] as const);
    const shared = this.#options.commands
      ? TELEGRAM_COMMAND_MENU.filter(([command]) => !(manager && command === "delete"))
      : [];
    for (const language of ["", "ko"] as const) {
      const t = sourceTranslateFor(language === "ko" ? "ko" : "en");
      const descriptions = {
        connect: t("status.messaging.telegramCommandConnect"),
        new: t("status.messaging.telegramCommandNew"),
        agents: t("status.messaging.telegramCommandAgents"),
        stop: t("status.messaging.telegramCommandStop"),
        browser: t("status.messaging.telegramCommandBrowser"),
        root: t("status.messaging.telegramCommandRoot"),
        disconnect: t("status.messaging.telegramCommandDisconnect"),
        delete: t("status.messaging.telegramCommandDeleteAgent"),
        engine: t("status.messaging.telegramCommandEngine"),
        name: t("status.messaging.telegramCommandName"),
      };
      yield* this.#options.api.setMyCommands(
        token,
        [
          ...names.map((command) => ({ command, description: descriptions[command] })),
          ...shared.map(([command, key]) => ({ command, description: t(key) })),
        ],
        language,
      );
    }
  }).bind(this);

  readonly start = Effect.fn("TelegramVps.start")(function* (
    this: TelegramVps,
    afterLoad?: () => Effect.Effect<void, Error>,
  ) {
    const { api, directory, settings } = this.#options;
    yield* directory.load();
    const restoring = directory.list().length > 0;
    if (afterLoad) yield* afterLoad();
    const manager = yield* Effect.gen({ self: this }, function* () {
      const account = yield* api.getMe(settings.token);
      if (!account.can_manage_bots) return yield* Effect.fail(new Error("Enable Bot Management Mode for the manager."));
      yield* this.#webhook(settings.managerId, settings.token);
      return account;
    }).pipe(
      Effect.retry({
        while: (failure) =>
          failure instanceof TelegramApiFailure &&
          (failure.kind === "transport" || failure.status === 429 || failure.status >= 500),
        schedule: Schedule.spaced("30 seconds"),
      }),
    );
    for (const child of directory.list()) {
      // A deleted child can no longer return a token. Its sibling webhooks still need to be installed.
      if (!child.ownerConfirmed) continue;
      yield* Effect.result(this.#installChild(child.id));
    }
    this.#manager = manager.username;
    this.#managerCaughtUp = !restoring;
  }).bind(this);

  get listening(): boolean {
    return !this.#closed && this.#manager !== "";
  }

  get managerUsername(): string {
    return this.#manager;
  }

  get workReady(): boolean {
    return this.listening && this.#managerCaughtUp;
  }

  readonly checkManager = Effect.fn("TelegramVps.checkManager")(function* (this: TelegramVps) {
    if (!this.listening) return;
    const { api, settings, directory } = this.#options;
    const info = yield* api.webhookInfo(settings.token);
    if (
      info.url === settings.publicOrigin + updatePath + settings.managerId &&
      info.allowed_updates?.includes("managed_bot") &&
      info.pending_update_count === 0 &&
      (!info.last_error_date || info.last_error_date * 1000 < Date.now() - 300_000)
    ) {
      if (this.#closed) return;
      yield* directory.observeManager();
      this.#managerCaughtUp = true;
    }
  }).bind(this);

  readonly #installChild = Effect.fn("TelegramVps.installChild")(function* (this: TelegramVps, id: number) {
    const token = yield* this.#options.api.getManagedBotToken(this.#options.settings.token, id);
    yield* this.#webhook(id, token);
  }).bind(this);

  readonly sendFromAgent = Effect.fn("TelegramVps.sendFromAgent")(function* (
    this: TelegramVps,
    id: number,
    chat: string | number,
    text: string,
    markup?: TelegramReplyMarkup,
    html = false,
  ) {
    const { api, directory, settings } = this.#options;
    const generation = directory.get(id);
    if (!this.workReady || !generation?.ownerConfirmed)
      return yield* Effect.fail(new Error("Telegram connection is unavailable."));
    const token = yield* api.getManagedBotToken(settings.token, id);
    const current = directory.get(id);
    if (this.#closed || !current?.ownerConfirmed || current.operationId !== generation.operationId) {
      return yield* Effect.fail(new Error("Telegram connection has changed."));
    }
    yield* api.sendMessage(token, chat, text, markup, html);
  }).bind(this);

  readonly notifyOwner = Effect.fn("TelegramVps.notifyOwner")(function* (this: TelegramVps, id: number) {
    const t = sourceTranslateFor(this.#language);
    if (id === this.#options.settings.managerId) {
      if (this.workReady)
        yield* this.#tellOwner(
          t("status.messaging.telegramNeedsInput"),
          this.#appButton(t, this.#options.settings.managerId),
        );
      return;
    }
    if (!this.workReady || !chatReady(this.#options.directory.get(id))) return;
    // Owners have already started the manager. A delegated child may not yet have its own owner DM.
    // The card opens inside this bot's chat. The manager's view is the fallback before the owner starts it.
    const alert = t("status.messaging.telegramNeedsInput");
    yield* this.sendFromAgent(id, this.#options.settings.ownerId, alert, this.#appButton(t, id)).pipe(
      Effect.catch((error) =>
        error instanceof TelegramApiFailure && error.status === 403 && chatReady(this.#options.directory.get(id))
          ? this.#tellOwner(alert, this.#appButton(t, this.#options.settings.managerId))
          : Effect.fail(error),
      ),
    );
  }).bind(this);

  awaitPending() {
    return this.#updates.withPermit(Effect.void);
  }

  readonly #tellOwner = (text: string, markup?: TelegramReplyMarkup) =>
    this.#options.api.sendMessage(this.#options.settings.token, this.#options.settings.ownerId, text, markup);

  /** A Mini App button opens inside the chat of the bot that sent it. No bot needs a Main Mini App. */
  #appButton(t: Translate, bot: number): TelegramReplyMarkup {
    return {
      inline_keyboard: [
        [
          {
            text: t("status.messaging.telegramOpenApp"),
            web_app: { url: `${this.#options.settings.publicOrigin}/tommy/telegram/app?bot=${bot}` },
          },
        ],
      ],
    };
  }

  readonly #owner = Effect.fn("TelegramVps.owner")(function* (
    this: TelegramVps,
    recipient: number,
    updateId: number,
    received: Message,
  ) {
    const { settings, directory, agents, ready } = this.#options;
    this.#language = received.from.language_code?.toLowerCase().startsWith("ko") ? "ko" : "en";
    const t = sourceTranslateFor(this.#language);
    if (received.unsupported) {
      if (recipient === settings.managerId || directory.get(recipient)?.ownerConfirmed)
        yield* this.#say(recipient, t("status.messaging.telegramUnsupported"));
      return;
    }
    // An edit reaches the agent as a new message that says it replaces the earlier one.
    if (received.edited && received.text.trim().startsWith("/")) return;
    const message = received.edited
      ? { ...received, text: `${t("status.messaging.telegramEditedPrefix")}\n${received.text}` }
      : received;
    const words = message.text.trim().split(/\s+/);
    const command = words[0]?.toLowerCase();
    const child = directory.get(recipient);
    if (recipient === settings.managerId) {
      const rootAgentId = directory.managerAgent()?.agentId;
      // In this chat /delete deletes an agent without a chat, never the root agent.
      const rootReply =
        message.text.trim().startsWith("/") && command !== "/delete" && rootAgentId && this.#options.commands
          ? yield* this.#options.commands.handle(rootAgentId, message.text, t, {
              timeZone: this.#options.timeZone?.() ?? "UTC",
              language: this.#language,
              isRoot: true,
            })
          : null;
      if (rootReply) {
        yield* this.#options.api.sendMessage(settings.token, settings.ownerId, rootReply.html, rootReply.markup, true);
      } else if (!message.text.trim().startsWith("/")) {
        if (this.#attention?.(settings.managerId, message.text, message.message_id)) return;
        if (this.#askingRole) yield* this.#saveRole(updateId, message.text, t);
        else yield* this.#toRoot(updateId, message, t);
      } else if (command === "/root") {
        yield* this.#chooseRoot(words.slice(1).join(" "), t);
      } else if (command === "/delete") {
        yield* this.#deleteAgent(message.text.trim().slice(command.length).trim(), t);
      } else if (command === "/connect") {
        yield* this.#connect(t);
      } else if (command === "/disconnect") {
        const answer = yield* this.#disconnect.handle(message.text, updateId, t);
        if (answer !== null) yield* this.#tellOwner(answer);
      } else if (command === "/new") {
        this.#roleForNext = message.text.trim().slice(command.length).trim() || null;
        yield* this.#tellOwner(t("status.messaging.telegramCreateHelp"), {
          inline_keyboard: [[{ text: t("status.messaging.telegramCreate"), url: this.#newBotLink() }]],
        });
      } else if (command === "/agents") {
        const names = directory
          .list()
          .map(
            (entry) =>
              `@${entry.username}  ${entry.name}  ${chatReady(entry) && this.workReady ? t("status.messaging.telegramActive") : t("status.messaging.telegramPending")}`,
          );
        yield* this.#tellOwner(
          names.join("\n").slice(0, 4000) || t("status.messaging.telegramNoAgents"),
          this.#appButton(t, settings.managerId),
        );
      } else if (command === "/stop") {
        yield* this.#stop(settings.managerId, directory.managerAgent()?.agentId ?? null, t);
      } else if (command === "/browser") {
        yield* this.#tellOwner(t("status.messaging.telegramBrowserHelp"), this.#appButton(t, settings.managerId));
      } else {
        if (command === "/start" && this.#options.retryChat) yield* this.#options.retryChat(settings.managerId);
        yield* this.#tellOwner(t("status.messaging.telegramManagerHelp"), this.#appButton(t, settings.managerId));
      }
      return;
    }
    if (!child) return;
    if (!child.ownerConfirmed) return;
    if (!chatReady(child)) {
      yield* this.sendFromAgent(child.id, settings.ownerId, t("status.messaging.telegramUnavailable"));
      return;
    }
    if (!command?.startsWith("/") && this.#attention?.(child.id, message.text, message.message_id)) return;
    if (command === "/start" || command === "/app") {
      if (command === "/start" && this.#options.retryChat) yield* this.#options.retryChat(child.id);
      yield* this.sendFromAgent(
        child.id,
        settings.ownerId,
        t("status.messaging.telegramChatHelp"),
        this.#appButton(t, child.id),
      );
      return;
    }
    if (command === "/stop") {
      yield* this.#stop(child.id, child.agentId, t);
      return;
    }
    if (command === "/browser") {
      yield* this.sendFromAgent(
        child.id,
        settings.ownerId,
        t("status.messaging.telegramBrowserHelp"),
        this.#appButton(t, child.id),
      );
      return;
    }
    if (!ready()) return yield* Effect.fail(new Error("Tommy is starting."));
    if (!agents.isAvailable(child.agentId)) {
      yield* this.sendFromAgent(child.id, settings.ownerId, t("status.messaging.telegramUnavailable"));
      return;
    }
    const profileReply = this.#options.profile ? yield* this.#options.profile.handle(child, message.text, t) : null;
    if (profileReply !== null) {
      yield* this.sendFromAgent(child.id, settings.ownerId, profileReply);
      return;
    }
    const commandReply = this.#options.commands
      ? yield* this.#options.commands.handle(child.agentId, message.text, t, {
          timeZone: this.#options.timeZone?.() ?? "UTC",
          language: this.#language,
          isRoot: false,
        })
      : null;
    if (commandReply) {
      yield* this.sendFromAgent(child.id, settings.ownerId, commandReply.html, commandReply.markup, true);
      return;
    }
    const files = yield* this.#download(child.id, message, t);
    if (files === null) return;
    yield* agents.submit(child.agentId, child.id, settings.ownerId, updateId, message.text, files);
  }).bind(this);

  /**
   * Deletes an agent that has no chat, after the owner sends the code. An agent with a chat is deleted
   * from its own chat, and the root agent never.
   */
  readonly #deleteAgent = Effect.fn("TelegramVps.deleteAgent")(function* (
    this: TelegramVps,
    input: string,
    t: Translate,
  ) {
    const { agents, directory, ready } = this.#options;
    if (!ready()) return yield* Effect.fail(new Error("Tommy is starting."));
    const pending = this.#deleting;
    if (
      pending &&
      pending.expires > Date.now() &&
      input.toLowerCase() === `${pending.name} ${pending.code}`.toLowerCase()
    ) {
      this.#deleting = null;
      if (agents.isAvailable(pending.agentId) && this.#unbound().some((agent) => agent.id === pending.agentId)) {
        yield* agents.remove(pending.agentId);
        yield* this.#tellOwner(t("status.messaging.telegramDeleted", { name: pending.name }));
      } else {
        yield* this.#tellOwner(t("status.messaging.telegramDeleteUnknown"));
      }
      return;
    }
    const unbound = this.#unbound();
    if (!input) {
      yield* this.#tellOwner(
        unbound.length
          ? t("status.messaging.telegramDeleteUsage", { names: unbound.map((agent) => agent.name).join("\n") })
          : t("status.messaging.telegramDeleteNone"),
      );
      return;
    }
    const wanted = input.toLowerCase();
    const named = agents.choices().filter((agent) => agent.name.trim().toLowerCase() === wanted);
    const target = named.length === 1 ? named[0] : undefined;
    if (!target) {
      yield* this.#tellOwner(
        t(named.length ? "status.messaging.telegramDeleteAmbiguous" : "status.messaging.telegramDeleteUnknown"),
      );
      return;
    }
    if (target.id === directory.managerAgent()?.agentId) {
      yield* this.#tellOwner(t("status.messaging.telegramDeleteRoot"));
      return;
    }
    const bot = directory.list().find((entry) => entry.agentId === target.id);
    if (bot) {
      yield* this.#tellOwner(
        t("status.messaging.telegramDeleteHasChat", { name: target.name, username: bot.username }),
      );
      return;
    }
    const code = randomBytes(3).toString("hex");
    this.#deleting = { agentId: target.id, name: target.name, code, expires: Date.now() + 5 * 60_000 };
    yield* this.#tellOwner(t("status.messaging.telegramDeleteAsk", { name: target.name, code }));
  }).bind(this);

  /** Agents that have neither the manager chat nor their own bot. */
  #unbound() {
    const { agents, directory } = this.#options;
    const bound = new Set(directory.list().flatMap((entry) => (entry.agentId ? [entry.agentId] : [])));
    const root = directory.managerAgent()?.agentId;
    return agents.choices().filter((agent) => agent.id !== root && !bound.has(agent.id));
  }

  /** The root agent answers in the manager chat. The owner chooses it once, like the main agent of the app. */
  readonly #chooseRoot = Effect.fn("TelegramVps.chooseRoot")(function* (this: TelegramVps, name: string, t: Translate) {
    const { agents, directory, ready } = this.#options;
    if (!ready()) return yield* Effect.fail(new Error("Tommy is starting."));
    const choices = this.#unbound();
    const wanted = name.trim().toLowerCase();
    const choice = wanted ? choices.find((agent) => agent.name.trim().toLowerCase() === wanted) : undefined;
    if (choice) {
      yield* directory.setManagerAgent(choice.id);
      yield* this.#tellOwner(t("status.messaging.telegramRootSelected", { name: choice.name }), {
        remove_keyboard: true,
      });
      return;
    }
    const current = agents.choices().find((agent) => agent.id === directory.managerAgent()?.agentId);
    if (!choices.length) {
      yield* this.#tellOwner(t("status.messaging.telegramUnavailable"));
      return;
    }
    yield* this.#tellOwner(
      current
        ? t("status.messaging.telegramRootCurrent", { name: current.name })
        : t("status.messaging.telegramChooseRoot"),
      {
        keyboard: pairs(choices.slice(0, 50).map((agent) => ({ text: `/root ${agent.name}`.slice(0, 120) }))),
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    );
  }).bind(this);

  /** Sends a short status line to the owner in this chat. */
  #say(chat: number, text: string) {
    return chat === this.#options.settings.managerId
      ? this.#tellOwner(text)
      : this.sendFromAgent(chat, this.#options.settings.ownerId, text);
  }

  readonly #stop = Effect.fn("TelegramVps.stop")(function* (
    this: TelegramVps,
    chat: number,
    agentId: string | null,
    t: Translate,
  ) {
    const stopped = agentId && this.#options.stop ? yield* this.#options.stop(agentId) : false;
    yield* this.#say(chat, t(stopped ? "status.messaging.telegramStopped" : "status.messaging.telegramNothingToStop"));
  }).bind(this);

  /** The files of an owner message, downloaded with the receiving bot's token. Null: nothing to send. */
  readonly #download = Effect.fn("TelegramVps.download")(function* (
    this: TelegramVps,
    chat: number,
    message: Message,
    t: Translate,
  ) {
    if (!message.files.length) return [];
    const { api, settings } = this.#options;
    const loaded = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        const token =
          chat === settings.managerId ? settings.token : yield* api.getManagedBotToken(settings.token, chat);
        return yield* Effect.forEach(message.files, (file) =>
          Effect.map(api.downloadFile(token, file.fileId), (bytes) => ({
            name: file.name,
            mimeType: file.mimeType,
            bytes,
          })),
        );
      }),
    );
    if (Result.isSuccess(loaded)) return loaded.success;
    yield* this.#say(chat, t("status.messaging.telegramFileFailed"));
    return message.text ? [] : null;
  }).bind(this);

  readonly #toRoot = Effect.fn("TelegramVps.toRoot")(function* (
    this: TelegramVps,
    updateId: number,
    message: Message,
    t: Translate,
  ) {
    const { agents, directory, settings, ready } = this.#options;
    if (!ready() || !this.workReady) return yield* Effect.fail(new Error("Tommy is starting."));
    const agentId = directory.managerAgent()?.agentId;
    if (!agentId || !agents.isAvailable(agentId)) {
      yield* this.#chooseRoot("", t);
      return;
    }
    const files = yield* this.#download(settings.managerId, message, t);
    if (files === null) return;
    yield* agents.submit(agentId, settings.managerId, settings.ownerId, updateId, message.text, files);
  }).bind(this);

  /**
   * A Telegram link that asks the owner to create a bot that this manager controls. A link can sit on a
   * button in the message, so the chat keeps its normal keyboard. The created bot arrives as managed_bot.
   */
  #newBotLink(name?: string) {
    const link = `https://t.me/newbot/${encodeURIComponent(this.#manager)}`;
    if (!name) return link;
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const username = `${base}_tommy_bot`;
    // encodeURIComponent writes a space as %20.
    const query = `?name=${encodeURIComponent(name.slice(0, 64))}`;
    return /^[a-z][a-z0-9_]{4,31}$/.test(username) ? `${link}/${username}${query}` : `${link}${query}`;
  }

  /** One create link for each agent without a bot. The new bot's name selects the agent. */
  readonly #connect = Effect.fn("TelegramVps.connect")(function* (this: TelegramVps, t: Translate) {
    if (!this.#options.ready()) return yield* Effect.fail(new Error("Tommy is starting."));
    const choices = this.#unbound().slice(0, 50);
    if (!choices.length) {
      yield* this.#tellOwner(t("status.messaging.telegramAllConnected"));
      return;
    }
    yield* this.#tellOwner(t("status.messaging.telegramConnectHelp"), {
      inline_keyboard: pairs(
        choices.map((agent) => ({ text: agent.name.slice(0, 120), url: this.#newBotLink(agent.name) })),
      ),
    });
  }).bind(this);

  /**
   * A new bot named like an agent without a bot gets that agent. Any other bot gets a new agent, with the
   * role from /new when the owner gave one. `role` is false when the new agent still needs a role.
   */
  readonly #bindCreated = Effect.fn("TelegramVps.bindCreated")(function* (
    this: TelegramVps,
    entry: TelegramConnection,
  ) {
    const { agents, directory, ready } = this.#options;
    if (entry.agentId) return { agentId: entry.agentId, role: true };
    if (!ready()) return yield* Effect.fail(new Error("Tommy is starting."));
    const name = entry.name.trim().toLowerCase();
    const existing = this.#unbound().find((agent) => agent.name.trim().toLowerCase() === name);
    if (existing) {
      yield* directory.bindAgent(entry.id, existing.id, entry.operationId);
      return { agentId: existing.id, role: true };
    }
    const role = this.#roleForNext;
    this.#roleForNext = null;
    const agentId = yield* agents.ensureAgent(
      entry.operationId,
      entry.name,
      role
        ? sourceText("status.messaging.telegramInitialRole", { description: role })
        : sourceText("status.messaging.telegramInitialMessage"),
      role ?? undefined,
    );
    yield* directory.bindAgent(entry.id, agentId, entry.operationId);
    return { agentId, role: role !== null };
  }).bind(this);

  /** Saves the owner's answer as the new agent's description and sends it to the agent in its own chat. */
  readonly #saveRole = Effect.fn("TelegramVps.saveRole")(function* (
    this: TelegramVps,
    updateId: number,
    text: string,
    t: Translate,
  ) {
    const asking = this.#askingRole;
    if (!asking) return;
    this.#askingRole = null;
    const { agents, settings } = this.#options;
    yield* agents.describe(randomUUID(), asking.agentId, text);
    yield* agents.submit(
      asking.agentId,
      asking.botId,
      settings.ownerId,
      updateId,
      t("status.messaging.telegramRoleMessage", { description: text.trim() }),
    );
    yield* this.#tellOwner(t("status.messaging.telegramRoleSaved", { name: asking.name, username: asking.username }));
  }).bind(this);

  readonly #update = Effect.fn("TelegramVps.update")(function* (this: TelegramVps, id: number, update: TelegramUpdate) {
    const { directory, settings } = this.#options;
    const managed = update.managed_bot;
    const message = update.message;
    if (managed && id !== settings.managerId) return;
    if (message && (message.chat.type !== "private" || message.chat.id !== message.from.id)) return;
    // Only the owner's private messages count. Other people and bots never reach an agent.
    if (message && (message.from.is_bot || message.from.id !== settings.ownerId)) return;
    if (directory.seen(id, update.update_id)) return;
    if (managed) {
      if (managed.bot.id === settings.managerId || managed.bot.id === settings.ownerId) return;
      if (managed.user.id !== settings.ownerId) {
        yield* directory.revoke(managed.bot.id, update.update_id);
        return;
      } else {
        const entry = yield* directory.ensureManaged(managed.bot, update.update_id);
        if (entry?.ownerConfirmed) {
          const { agentId, role } = yield* this.#bindCreated(entry);
          yield* this.#installChild(entry.id);
          const t = sourceTranslateFor(managed.user.language_code?.startsWith("ko") ? "ko" : "en");
          const name = this.#options.agents.choices().find((agent) => agent.id === agentId)?.name ?? entry.name;
          yield* this.#tellOwner(t("status.messaging.telegramChatReady", { username: entry.username, name }), {
            inline_keyboard: [
              [{ text: t("status.messaging.telegramOpenChat"), url: `https://t.me/${entry.username}?start=tommy` }],
            ],
          });
          if (!role) {
            this.#askingRole = { agentId, botId: entry.id, username: entry.username, name };
            yield* this.#tellOwner(t("status.messaging.telegramAskRole", { name }));
          }
        }
      }
    } else if (message) {
      yield* this.#owner(id, update.update_id, message);
    }
    yield* directory.markSeen(id, update.update_id);
  }).bind(this);

  readonly handle = Effect.fn("TelegramVps.http")(function* (
    this: TelegramVps,
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const path = request.url ?? "";
    if (!path.startsWith(updatePath)) return false;
    const idText = path.slice(updatePath.length);
    const id = Number(idText);
    const expected = /^[1-9]\d{0,15}$/.test(idText) ? this.#secret(id) : null;
    const headers = request.headersDistinct["x-telegram-bot-api-secret-token"];
    let status: number;
    if (request.method !== "POST" || !expected || this.#closed) status = 404;
    else if (headers?.length !== 1 || !equalWebhookSecret(expected, headers[0] ?? "")) status = 403;
    else if (!this.listening || (!this.workReady && id !== this.#options.settings.managerId)) status = 503;
    else {
      const result = yield* Effect.result(Effect.tryPromise(() => readBodyWithin(request, bodyLimit)));
      if (Result.isFailure(result)) status = 400;
      else if (!result.success) status = 413;
      else {
        const body = result.success;
        const parsed = yield* Effect.result(Effect.try(() => decodeTelegramUpdate(JSON.parse(body.toString("utf8")))));
        if (Result.isFailure(parsed)) status = 400;
        else if (!parsed.success) status = 200;
        else {
          const update = parsed.success;
          // Repeat the generation check after a slow body read or a queued owner transfer.
          const updated = yield* Effect.exit(
            this.#updates.withPermit(
              Effect.suspend(() =>
                !this.#closed && this.#secret(id) === expected ? this.#update(id, update) : Effect.void,
              ),
            ),
          );
          status = updated._tag === "Success" ? 200 : 503;
        }
      }
    }
    response.writeHead(status, { "cache-control": "no-store" }).end();
    return true;
  }).bind(this);
}
