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
import type { AgentService } from "../backend/agent-service";
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

function senderId(telegramId: number, ownerId: number): string {
  return `telegram:${telegramId}:${ownerId}`;
}

/** Connects a verified Telegram identity to a local agent and its completed public answer. */
export class TelegramAgentHost {
  constructor(
    private readonly service: Pick<
      AgentService,
      "listAgents" | "saveProfile" | "sendMessage" | "prepareImportedAttachments" | "on" | "off"
    >,
    private readonly sidebar: Pick<SidebarLayoutStore, "getSnapshot" | "withProfileAssignment">,
    private readonly mailbox: Pick<
      MailboxStore,
      "telegramOriginsForTurn" | "resolveAttachment" | "generatedImageDigest"
    >,
    private readonly database: Pick<TommyDatabase, "readTurnAssistantMessages">,
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
  ) {
    const displayName = name.trim().slice(0, INPUT_LIMITS.agentName);
    const { agent } = yield* this.service.saveProfile(
      {
        operationId,
        draft: {
          name: displayName,
          title: "",
          description: displayName,
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

  readonly submit = Effect.fn("TelegramAgentHost.submit")(function* (
    this: TelegramAgentHost,
    agentId: string,
    telegramId: number,
    ownerId: number,
    updateId: number,
    text: string,
    files: readonly AttachmentDataInput[] = [],
  ) {
    // sendMessage can create some missing built-in agents. A revoked Telegram binding must never do so.
    if (!this.isAvailable(agentId))
      return yield* new RemoteWorkflowError({ cause: new Error(sourceText("error.agent.gone")) });
    const drafts = files.length ? yield* this.service.prepareImportedAttachments([], [...files]) : [];
    yield* this.service.sendMessage(
      {
        agentId,
        text: redactText(text),
        clientMessageId: `telegram:${telegramId}:${updateId}`,
        ...(drafts.length ? { attachmentDraftIds: drafts.map((draft) => draft.id) } : {}),
      },
      {
        id: senderId(telegramId, ownerId),
        name: "Telegram",
      },
    );
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

  ownsTurn(agentId: string, turnId: string, telegramId: number, ownerId: number): boolean {
    if (this.#turnSender(agentId, turnId) === senderId(telegramId, ownerId)) return true;
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
    return this.#turnSender(agentId, turnId) === senderId(telegramId, ownerId);
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
  tracedChat(agentId: string, turnId: string, ownerId: number, depth = 0): number | null {
    if (!this.isAvailable(agentId)) return null;
    const origins = this.mailbox.telegramOriginsForTurn(agentId, turnId);
    const chats = origins.map((origin) => {
      if (origin.requestFrom)
        return depth < TRACE_DEPTH_LIMIT
          ? this.tracedChat(origin.requestFrom.agentId, origin.requestFrom.turnId, ownerId, depth + 1)
          : null;
      const sender = this.#turnSender(agentId, turnId)?.match(/^telegram:([1-9]\d{0,15}):([1-9]\d{0,15})$/u);
      return sender && Number(sender[2]) === ownerId ? Number(sender[1]) : null;
    });
    const first = chats[0] ?? null;
    return first !== null && chats.every((chat) => chat === first) ? first : null;
  }

  onReply(receive: (reply: TelegramAgentReply) => void): () => void {
    const replies = this.replies(receive);
    this.service.on("event", replies.observe);
    return () => {
      replies.stop();
      this.service.off("event", replies.observe);
    };
  }

  /** The same as onReply, for a caller that already listens to agent events. */
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
    const identity = this.#turnSender(agentId, turnId)?.match(/^telegram:([1-9]\d{0,15}):([1-9]\d{0,15})$/u);
    // A routine result goes to the agent's own chat, as it went to its chat in the app.
    const routine = identity ? null : this.routineTurn(agentId, turnId) ? this.#routineChat(agentId) : null;
    if (!identity && !routine) return null;
    const telegramId = identity ? Number(identity[1]) : (routine?.telegramId ?? 0);
    const ownerId = identity ? Number(identity[2]) : (routine?.ownerId ?? 0);
    if (!Number.isSafeInteger(telegramId) || !Number.isSafeInteger(ownerId) || !telegramId || !ownerId) return null;
    const status = event.status === "completed" || event.status === "failed" ? event.status : "cancelled";
    return yield* this.readReply({ agentId, threadId, turnId, telegramId, ownerId, status });
  });

  /** A pending delivery stores only these ids. Recheck its source before reading any answer or file. */
  readonly readReply = Effect.fn("TelegramAgentHost.readReply")(function* (
    this: TelegramAgentHost,
    address: TelegramReplyRef,
  ): Effect.fn.Return<TelegramAgentReply | null> {
    const { agentId, threadId, turnId } = address;
    if (!this.ownsTurn(agentId, turnId, address.telegramId, address.ownerId)) return null;
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
    const answer = latestTurnAnswer(rows, turnId);
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
    const files: TelegramFile[] = image ? [{ name: "image.png", mimeType: "image/png", bytes: image }] : [];
    // Files that attach_files_to_response staged in this turn.
    const attached = rows
      .filter((row) => row.itemType === "agent_attachment" && row.status === "completed")
      .flatMap((row) => row.attachments ?? [])
      .slice(0, 10);
    for (const item of attached) {
      const file = yield* readTelegramFile(this.mailbox, item).pipe(Effect.orElseSucceed(() => null));
      if (file) files.push(file);
    }
    return text || files.length ? { ...address, text, files } : null;
  }).bind(this);
}
