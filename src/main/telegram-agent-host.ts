import { CHAT_VISUAL_ITEM_TYPE_PREFIX, chatVisualReply } from "@tommy/contracts/chat-visual";
import { INPUT_LIMITS } from "@tommy/contracts/input-limits";
import {
  type AgentEvent,
  type AgentTurnCompletedEvent,
  type AttachmentDataInput,
  latestTurnAnswer,
} from "@tommy/contracts/ipc";
import { sourceText } from "@tommy/i18n/source";
import { createTommyLogger, redactText } from "@tommy/logging";
import { Effect } from "effect";
import type { AgentLifecycleFailed, AgentService } from "../backend/agent-service";
import type { MailboxStore } from "../backend/mailbox-store";
import type { SidebarLayoutStore } from "../backend/sidebar-layout-store";
import type { TommyDatabase } from "../backend/tommy-database";
import { RemoteWorkflowError } from "./remote-service-effects";
import { readTelegramFile, readTelegramImage, type TelegramFile } from "./telegram-agent-media";
import { maskEmails } from "./telegram-format";

const logger = createTommyLogger("telegram-agent-host");

export interface TelegramReplyRef {
  telegramId: number;
  ownerId: number;
  agentId: string;
  threadId: string;
  turnId: string;
  status: "completed" | "failed" | "cancelled";
}

export interface TelegramAgentReply extends TelegramReplyRef {
  text: string;
  /** The generated image and the files the agent attached, in order. */
  files: TelegramFile[];
}

/** How many requests between agents a turn is traced back through to the owner's message. */
const TRACE_DEPTH_LIMIT = 8;

const telegramSender = /^telegram:([1-9]\d{0,15}):([1-9]\d{0,15}):([\da-f-]{36})$/u;

function senderId(telegramId: number, ownerId: number, generation: string): string {
  return `telegram:${telegramId}:${ownerId}:${generation}`;
}

/** Connects a verified Telegram identity to a local agent and its completed public answer. */
export class TelegramAgentHost {
  constructor(
    private readonly service: Pick<
      AgentService,
      | "listAgents"
      | "saveProfile"
      | "updateAgent"
      | "deleteAgent"
      | "sendMessage"
      | "prepareImportedAttachments"
      | "discardDraftAttachment"
      | "on"
      | "off"
    >,
    private readonly sidebar: Pick<SidebarLayoutStore, "getSnapshot" | "withProfileAssignment">,
    private readonly mailbox: Pick<
      MailboxStore,
      "telegramOriginsForTurn" | "deliveryForMessage" | "resolveAttachment" | "generatedAttachmentDigest"
    >,
    private readonly database: Pick<TommyDatabase, "readTurnAssistantMessages">,
    private readonly generationFor: (chat: number, agentId: string) => string | null,
  ) {}

  isAvailable(agentId: string): boolean {
    return this.service.listAgents().some((agent) => agent.id === agentId && agent.hiddenAt === undefined);
  }

  /** Visible agents the owner can choose to answer in the manager chat. */
  choices(): { id: string; name: string }[] {
    return this.service
      .listAgents()
      .filter((agent) => agent.hiddenAt === undefined)
      .map((agent) => ({ id: agent.id, name: agent.name }));
  }

  /** The caller persists this UUID before first use. saveProfile replays its SQLite receipt after a restart. */
  readonly ensureAgent = Effect.fn("TelegramAgentHost.ensureAgent")(function* (
    this: TelegramAgentHost,
    operationId: string,
    name: string,
    initialMessage: string,
    description?: string,
  ) {
    const displayName = name.trim().slice(0, INPUT_LIMITS.agentName);
    const { agent } = yield* this.service.saveProfile(
      {
        operationId,
        draft: {
          name: displayName,
          title: "",
          description:
            Array.from(description?.trim() ?? "")
              .slice(0, INPUT_LIMITS.agentDescription)
              .join("") || displayName,
          avatarSeed: operationId,
          avatarHue: null,
          sectionId: null,
        },
        initialMessage,
      },
      this.sidebar,
    );
    return agent.id;
  }).bind(this);

  /** Replaces only the description of an agent. Its avatar, other profile fields and section stay. */
  readonly describe = Effect.fn("TelegramAgentHost.describe")(function* (
    this: TelegramAgentHost,
    agentId: string,
    description: string,
  ) {
    if (!this.isAvailable(agentId))
      return yield* new RemoteWorkflowError({ cause: new Error(sourceText("error.agent.gone")) });
    yield* this.service.updateAgent({
      agentId,
      description: Array.from(description.trim()).slice(0, INPUT_LIMITS.agentDescription).join(""),
    });
  }).bind(this);

  /** Deletes an agent with its conversations and workspace. */
  remove(agentId: string) {
    return this.service.deleteAgent(agentId);
  }

  readonly submit = Effect.fn("TelegramAgentHost.submit")(function* (
    this: TelegramAgentHost,
    agentId: string,
    telegramId: number,
    ownerId: number,
    updateId: number,
    text: string,
    files: readonly AttachmentDataInput[] = [],
    expectedGeneration?: string,
  ) {
    const generation = expectedGeneration ?? this.generationFor(telegramId, agentId);
    // sendMessage can create some missing built-in agents. A revoked Telegram binding must never do so.
    if (!generation || generation !== this.generationFor(telegramId, agentId) || !this.isAvailable(agentId))
      return yield* new RemoteWorkflowError({ cause: new Error(sourceText("error.agent.gone")) });
    yield* Effect.acquireUseRelease(
      files.length ? this.service.prepareImportedAttachments([], [...files], "telegram") : Effect.succeed([]),
      (drafts) => {
        if (generation !== this.generationFor(telegramId, agentId)) return Effect.void;
        return this.service
          .sendMessage(
            {
              agentId,
              text: redactText(text),
              clientMessageId: `telegram:${telegramId}:${updateId}`,
              ...(drafts.length ? { attachmentDraftIds: drafts.map((draft) => draft.id) } : {}),
            },
            { id: senderId(telegramId, ownerId, generation), name: "Telegram" },
          )
          .pipe(Effect.asVoid);
      },
      // A duplicate update or a revoked connection can leave freshly downloaded drafts unclaimed.
      (drafts) =>
        Effect.forEach(
          drafts,
          (draft) =>
            this.service
              .discardDraftAttachment(draft.id)
              .pipe(
                Effect.catch(() => Effect.sync(() => logger.warn("Could not remove a Telegram attachment draft."))),
              ),
          { discard: true },
        ),
    );
  }).bind(this);

  /**
   * Sends a question from another computer and waits for the turn that answers it. With a chat, the
   * question enters it as the owner's message, so the answer also appears in that chat. `afterSend`
   * runs once Tommy has queued the question. Null: the time ran out first, and the agent still answers
   * in Tommy. An interrupted wait stops listening at once.
   */
  readonly ask = Effect.fn("TelegramAgentHost.ask")(function* (
    this: TelegramAgentHost,
    agentId: string,
    chat: { telegramId: number; ownerId: number; generation: string } | null,
    text: string,
    timeoutMs: number,
    afterSend: Effect.Effect<void> = Effect.void,
  ): Effect.fn.Return<
    { status: "completed" | "failed" | "cancelled"; text: string } | null,
    AgentLifecycleFailed | RemoteWorkflowError
  > {
    if (!this.isAvailable(agentId))
      return yield* new RemoteWorkflowError({ cause: new Error(sourceText("error.agent.gone")) });
    if (chat && chat.generation !== this.generationFor(chat.telegramId, agentId))
      return yield* new RemoteWorkflowError({ cause: new Error(sourceText("error.agent.gone")) });
    // Listen before the send, so that a fast answer is not missed.
    const completed: AgentTurnCompletedEvent[] = [];
    let wake: (() => void) | null = null;
    const observe = (event: AgentEvent) => {
      if (event.type !== "turn-completed" || event.agentId !== agentId) return;
      completed.push(event);
      wake?.();
    };
    this.service.on("event", observe);
    return yield* Effect.gen({ self: this }, function* () {
      const receipt = yield* this.service.sendMessage(
        { agentId, text: redactText(text) },
        chat ? { id: senderId(chat.telegramId, chat.ownerId, chat.generation), name: "Telegram" } : undefined,
      );
      yield* afterSend;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        for (let event = completed.shift(); event; event = completed.shift()) {
          // The delivery of the question names the turn that runs it, and each turn that continues its
          // open plan steps. Another message that runs in the same thread is not the answer.
          const context = this.mailbox.deliveryForMessage(receipt.messageId, agentId);
          const ours =
            context !== null &&
            (context.delivery.turnId === event.turnId || context.planContinuation?.turnIds.includes(event.turnId));
          if (!ours || event.continues) continue;
          if (event.status !== "completed")
            return { status: event.status === "failed" ? "failed" : "cancelled", text: "" } as const;
          const answer = latestTurnAnswer(
            this.database.readTurnAssistantMessages(agentId, event.threadId, event.turnId),
            event.turnId,
          );
          return {
            status: "completed",
            text: answer?.status === "completed" ? redactText(answer.text.trim()) : "",
          } as const;
        }
        const left = deadline - Date.now();
        if (left <= 0) return null;
        yield* Effect.callback<void>((resume) => {
          const timer = setTimeout(() => resume(Effect.void), left);
          wake = () => {
            clearTimeout(timer);
            resume(Effect.void);
          };
          return Effect.sync(() => clearTimeout(timer));
        });
        wake = null;
      }
    }).pipe(Effect.ensuring(Effect.sync(() => this.service.off("event", observe))));
  }).bind(this);

  /** The Telegram chat of each agent, for the results of its routines. Null: the agent has none. */
  #routineChat: (agentId: string) => { telegramId: number; ownerId: number } | null = () => null;

  setRoutineChat(chat: (agentId: string) => { telegramId: number; ownerId: number } | null): void {
    this.#routineChat = chat;
  }

  /** A turn that only a scheduled routine of this agent started. */
  routineTurn(agentId: string, turnId: string): boolean {
    if (!this.isAvailable(agentId)) return false;
    const origins = this.mailbox.telegramOriginsForTurn(agentId, turnId);
    return origins.length > 0 && origins.every((origin) => origin.routineRunId !== undefined);
  }

  ownsTurn(agentId: string, turnId: string, telegramId: number, ownerId: number, queuedGeneration?: string): boolean {
    const current = this.generationFor(telegramId, agentId);
    if (!current || (queuedGeneration && queuedGeneration !== current)) return false;
    const sender = this.#turnSender(agentId, turnId);
    if (sender === senderId(telegramId, ownerId, current)) return true;
    // Existing pending deliveries already contain the generation that authorized their original enqueue.
    if (queuedGeneration && sender === `telegram:${telegramId}:${ownerId}`) return true;
    const chat = this.routineTurn(agentId, turnId) ? this.#routineChat(agentId) : null;
    return chat !== null && chat.telegramId === telegramId && chat.ownerId === ownerId;
  }

  /** Authorizes an owner's pending interaction in the chat of the bot whose agent runs the turn. */
  canInspectTurn(
    agentId: string,
    turnId: string,
    telegramId: number,
    ownerId: number,
    rootAgentForBot: (rootTelegramId: number) => string | null,
  ): boolean {
    if (rootAgentForBot(telegramId) !== agentId || !this.isAvailable(agentId)) return false;
    const generation = this.generationFor(telegramId, agentId);
    return Boolean(generation && this.#turnSender(agentId, turnId) === senderId(telegramId, ownerId, generation));
  }

  /** A turn that only reads teammates' answers inside Tommy belongs to the turn that asked them. */
  #turnSender(agentId: string, turnId: string, depth = 0): string | undefined {
    if (!this.isAvailable(agentId)) return;
    const origins = this.mailbox.telegramOriginsForTurn(agentId, turnId);
    const senders = origins.map((origin) => {
      if (origin.answerToTurnId)
        return depth < TRACE_DEPTH_LIMIT ? this.#turnSender(agentId, origin.answerToTurnId, depth + 1) : undefined;
      return origin.senderId;
    });
    const first = senders[0];
    return first && senders.every((id) => id === first) ? first : undefined;
  }

  /**
   * The Telegram chat whose owner message started this work, following requests between agents
   * inside Tommy. Only browser requests use it: a reply still goes only to the agent's own chat.
   */
  tracedChat(
    agentId: string,
    turnId: string,
    ownerId: number,
    rootAgentForBot: (id: number) => string | null,
    depth = 0,
  ): number | null {
    if (!this.isAvailable(agentId)) return null;
    const origins = this.mailbox.telegramOriginsForTurn(agentId, turnId);
    const chats = origins.map((origin) => {
      if (origin.requestFrom)
        return depth < TRACE_DEPTH_LIMIT
          ? this.tracedChat(origin.requestFrom.agentId, origin.requestFrom.turnId, ownerId, rootAgentForBot, depth + 1)
          : null;
      const sender = this.#turnSender(agentId, turnId)?.match(telegramSender);
      return sender &&
        Number(sender[2]) === ownerId &&
        rootAgentForBot(Number(sender[1])) === agentId &&
        this.generationFor(Number(sender[1]), agentId) === sender[3]
        ? Number(sender[1])
        : null;
    });
    const first = chats[0] ?? null;
    return first !== null && chats.every((chat) => chat === first) ? first : null;
  }

  /** Listen to completed replies until the owning runtime stops. */
  replies(receive: (reply: TelegramAgentReply) => void) {
    let active = true;
    const observe = (event: AgentEvent) => {
      if (event.type !== "turn-completed" || event.quiet || event.continues) return;
      void Effect.runPromise(this.#reply(event))
        .then((reply) => {
          if (active && reply && this.ownsTurn(event.agentId, event.turnId, reply.telegramId, reply.ownerId))
            receive(reply);
        })
        .catch(() => logger.warn("Could not deliver a Telegram agent reply."));
    };
    return {
      observe,
      stop: () => {
        active = false;
      },
    };
  }

  readonly #reply = Effect.fn("TelegramAgentHost.reply")(function* (
    this: TelegramAgentHost,
    event: AgentTurnCompletedEvent,
  ) {
    const { agentId, threadId, turnId } = event;
    const identity = this.#turnSender(agentId, turnId)?.match(telegramSender);
    // A routine result goes to the agent's own chat, as it went to its chat in the app.
    const routine = identity ? null : this.routineTurn(agentId, turnId) ? this.#routineChat(agentId) : null;
    if (!identity && !routine) return null;
    const telegramId = identity ? Number(identity[1]) : (routine?.telegramId ?? 0);
    const ownerId = identity ? Number(identity[2]) : (routine?.ownerId ?? 0);
    if (!Number.isSafeInteger(telegramId) || !Number.isSafeInteger(ownerId) || !telegramId || !ownerId) return null;
    const status = event.status === "completed" || event.status === "failed" ? event.status : "cancelled";
    return yield* this.readReply({ agentId, threadId, turnId, telegramId, ownerId, status });
  });

  /**
   * The newest note of a turn that runs: what the agent wrote between its steps, or the summary of
   * its reasoning. Null when the turn has none. The caller shows it only in the chat of the turn.
   */
  turnNote(agentId: string, threadId: string, turnId: string): string | null {
    const note = this.database
      .readTurnAssistantMessages(agentId, threadId, turnId)
      .findLast((row) => row.itemType === "commentary" && row.text.trim() !== "");
    return note?.text ?? null;
  }

  /** A pending delivery stores only these ids. Recheck its source before reading any answer or file. */
  readonly readReply = Effect.fn("TelegramAgentHost.readReply")(function* (
    this: TelegramAgentHost,
    address: TelegramReplyRef,
    queuedGeneration?: string,
  ): Effect.fn.Return<TelegramAgentReply | null> {
    const { agentId, threadId, turnId } = address;
    if (!this.ownsTurn(agentId, turnId, address.telegramId, address.ownerId, queuedGeneration)) return null;
    if (address.status !== "completed")
      return {
        ...address,
        text: sourceText(
          address.status === "failed"
            ? "status.messaging.telegramTaskFailed"
            : "status.messaging.telegramTaskCancelled",
        ),
        files: [],
      };
    const rows = this.database.readTurnAssistantMessages(agentId, threadId, turnId);
    const answer = latestTurnAnswer(
      rows.filter(
        (row) => !row.itemType?.startsWith(CHAT_VISUAL_ITEM_TYPE_PREFIX) && row.itemType !== "agent_attachment",
      ),
      turnId,
    );
    const text = answer?.status === "completed" ? redactText(maskEmails(answer.text.trim())) : "";
    const generated = rows.findLast(
      (row) =>
        row.itemType === "image_generation" &&
        row.status === "completed" &&
        row.imageGeneration &&
        !row.imageGeneration.error,
    );
    const attachment = generated?.attachments?.find(
      (candidate) => candidate.kind === "image" && candidate.mimeType === "image/png",
    );
    const image = attachment
      ? yield* readTelegramImage(this.mailbox, agentId, threadId, attachment).pipe(Effect.orElseSucceed(() => null))
      : null;
    const files: TelegramFile[] =
      image && attachment
        ? [{ attachmentId: attachment.id, name: "image.png", mimeType: "image/png", bytes: image }]
        : [];
    // Files that attach_files_to_response staged in this turn.
    const attached = rows
      .filter((row) => row.itemType === "agent_attachment" && row.status === "completed")
      .flatMap((row) => row.attachments ?? [])
      .slice(0, 10);
    for (const item of attached) {
      const file = yield* readTelegramFile(this.mailbox, item).pipe(Effect.orElseSucceed(() => null));
      if (file) files.push(file);
    }
    for (const row of rows) {
      const visual = row.status === "completed" ? chatVisualReply(row) : null;
      if (!visual) continue;
      const preview = visual.preview
        ? yield* readTelegramImage(this.mailbox, agentId, threadId, visual.preview).pipe(
            Effect.orElseSucceed(() => null),
          )
        : null;
      if (preview && visual.preview)
        files.push({
          attachmentId: visual.preview.id,
          name: visual.preview.name,
          mimeType: "image/png",
          bytes: preview,
        });
      if (!preview || visual.includeSource) {
        const source = visual.attachment;
        const digest = this.mailbox.generatedAttachmentDigest(source.id, agentId, threadId, "text/html");
        if (!digest) continue;
        const file = yield* readTelegramFile(this.mailbox, source, digest).pipe(Effect.orElseSucceed(() => null));
        if (file) files.push(file);
      }
    }
    return text || files.length ? { ...address, text, files } : null;
  }).bind(this);
}
