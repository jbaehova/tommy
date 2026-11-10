import type { AgentEvent, ConversationSnapshot } from "@tommy/contracts/ipc";
import type {
  ChannelHistoryDeleteInput,
  ChannelMessageDeleteInput,
  HistoryDeleteInput,
  HistoryDeleteResult,
  MessageDeleteInput,
  MessageDeleteResult,
  TaskMessageDeleteInput,
} from "@tommy/contracts/ipc-message-deletion";
import { MESSAGE_DELETION_EVENT_MAX_IDS } from "@tommy/contracts/ipc-message-deletion";
import { Effect, Schema } from "effect";
import type { AgentStore } from "../agent-store";
import type { AgentTasks } from "../agent-tasks/agent-tasks";
import type { ChannelService } from "../channel-service";
import { causeHelpers } from "../effect-boundary";
import { channelLane, type MailboxStore } from "../mailbox-store";
import { type MessageDeleteAccess, MessageDeleteRefused } from "../message-deletion";
import type { ContextCompaction } from "./context-compaction";
import type { ConversationRuntime } from "./conversation-runtime";
import type { DrainScheduler } from "./drain-scheduler";
import type { MemoryReview } from "./memory-review";
import type { ThreadFileHistory } from "./thread-file-history";
import type { ThreadLifecycle } from "./thread-lifecycle";
import type { AgentBrowserHost } from "./turn-lifecycle";

export class ConversationRemovalFailed extends Schema.TaggedError<ConversationRemovalFailed>()(
  "ConversationRemovalFailed",
  {
    cause: Schema.Defect(),
  },
) {}
const { sync: removalStep, rewrap: toRemovalFailed } = causeHelpers(ConversationRemovalFailed);
const OWNER_ACCESS: MessageDeleteAccess = { memberId: null, deleteAny: true };

export interface ConversationRemovalOptions {
  store: AgentStore;
  mailbox: MailboxStore;
  conversation: ConversationRuntime;
  tasks: AgentTasks;
  channels: ChannelService;
  drain: DrainScheduler;
  threads: ThreadLifecycle;
  compaction: ContextCompaction;
  memoryReview: MemoryReview;
  fileHistory: Pick<ThreadFileHistory, "forgetThread">;
  browser: AgentBrowserHost;
  stopVoice(agentId: string): Effect.Effect<void>;
  isDeleting(agentId: string): boolean;
  emit(event: AgentEvent): void;
}

/** Owns user-requested transcript removal, its mailbox cleanup and affected provider sessions. */
export class ConversationRemoval {
  readonly #options: ConversationRemovalOptions;
  constructor(options: ConversationRemovalOptions) {
    this.#options = options;
  }

  readonly deleteMessage = Effect.fn("ConversationRemoval.deleteMessage")(function* (
    this: ConversationRemoval,
    input: MessageDeleteInput,
    access: MessageDeleteAccess = OWNER_ACCESS,
  ) {
    const threadId = yield* removalStep(() => this.#options.conversation.requireKnownAgent(input.agentId).threadId);
    if (!threadId)
      return yield* new ConversationRemovalFailed({ cause: new MessageDeleteRefused({ reason: "not-found" }) });
    return yield* this.#deleteInThread(input, threadId, access);
  }, Effect.uninterruptible).bind(this);

  readonly deleteTaskMessage = Effect.fn("ConversationRemoval.deleteTaskMessage")(function* (
    this: ConversationRemoval,
    input: TaskMessageDeleteInput,
    access: MessageDeleteAccess = OWNER_ACCESS,
  ) {
    const threadId = yield* removalStep(() => {
      const task = this.#options.tasks.require(input.agentId, input.taskId);
      this.#options.conversation.registerTaskThread(input.agentId, task.threadId);
      return task.threadId;
    });
    return yield* this.#deleteInThread(input, threadId, access);
  }, Effect.uninterruptible).bind(this);

  readonly #deleteInThread = Effect.fn("ConversationRemoval.deleteInThread")(function* (
    this: ConversationRemoval,
    input: MessageDeleteInput,
    threadId: string,
    access: MessageDeleteAccess,
  ): Effect.fn.Return<MessageDeleteResult, ConversationRemovalFailed> {
    const options = this.#options;
    let firstCommit = false;
    const result = yield* removalStep(() => {
      if (options.isDeleting(input.agentId)) throw new MessageDeleteRefused({ reason: "busy" });
      const database = options.store.database;
      const receipt = database.commandResult(
        `conversation:message-delete:${threadId}:${input.messageId}:${input.requestId}`,
      );
      if (receipt === undefined) {
        const message = database.readConversationMessages(input.agentId, threadId, [input.messageId])[0];
        if (!message || message.author === "system") throw new MessageDeleteRefused({ reason: "not-found" });
        if (
          !access.deleteAny &&
          !(access.memberId !== null && message.author === "user" && message.senderMember?.id === access.memberId)
        )
          throw new MessageDeleteRefused({ reason: "forbidden" });
        const activeTurnId = options.conversation.ensureSnapshot(input.agentId, threadId).activeTurnId;
        const delivery = options.mailbox.getDelivery(input.messageId)?.delivery;
        if (
          message.status === "streaming" ||
          (message.turnId && message.turnId === activeTurnId) ||
          (delivery && ["queued", "starting", "running"].includes(delivery.status))
        )
          throw new MessageDeleteRefused({ reason: "busy" });
      }
      const result = database.deleteConversationMessage({ ...input, threadId, access });
      firstCommit = receipt === undefined && result.deleted;
      return result;
    });
    if (firstCommit) {
      const mainThreadId = options.conversation.requireKnownAgent(input.agentId).threadId;
      yield* options.memoryReview.forgetThread(
        input.agentId,
        threadId === mainThreadId ? null : threadId,
        result.removedMessageIds,
      );
    }
    // Publish after the durable commit, before filesystem work. A failed cleanup can be retried.
    this.#publishRemoved(input.agentId, threadId, result.removedMessageIds, result.revision);
    const cleaned = yield* options.mailbox
      .deleteShownMessages(input.agentId, result.removedMessageIds)
      .pipe(toRemovalFailed);
    if (cleaned === "busy")
      return yield* new ConversationRemovalFailed({ cause: new MessageDeleteRefused({ reason: "busy" }) });
    yield* options.mailbox.cleanupDeletedGeneratedAttachments([threadId]).pipe(toRemovalFailed);
    return { deleted: result.deleted };
  }).bind(this);

  readonly deleteAgentHistory = Effect.fn("ConversationRemoval.deleteAgentHistory")(function* (
    this: ConversationRemoval,
    input: HistoryDeleteInput,
  ): Effect.fn.Return<HistoryDeleteResult, ConversationRemovalFailed> {
    const options = this.#options;
    return yield* Effect.acquireUseRelease(
      removalStep(() => options.drain.holdSessionSettings(input.agentId)),
      () =>
        Effect.gen({ self: this }, function* () {
          const threadId = yield* removalStep(() => options.conversation.requireKnownAgent(input.agentId).threadId);
          if (!threadId) return { deleted: false };
          const previous = yield* removalStep(() =>
            options.store.database.threadHistoryDeletionReceipt(threadId, input.requestId),
          );
          if (!previous) {
            const guard = () => {
              const agent = options.conversation.requireKnownAgent(input.agentId);
              if (
                agent.threadId !== threadId ||
                options.isDeleting(agent.id) ||
                options.threads.mainContextBusy(agent) ||
                options.mailbox.hasUnfinishedDeliveryOutsideTasks(agent.id, options.tasks.oneTurnAtATime(agent.id))
              )
                throw new MessageDeleteRefused({ reason: "busy" });
            };
            yield* removalStep(guard);
            yield* options.stopVoice(input.agentId);
            yield* options.memoryReview.forgetThread(input.agentId, null);
            yield* removalStep(() => {
              guard();
              options.store.database.deleteThreadHistory({ ...input, threadId });
            });
          }
          const receipt = yield* removalStep(() =>
            options.store.database.threadHistoryDeletionReceipt(threadId, input.requestId),
          );
          if (!receipt)
            return yield* new ConversationRemovalFailed({ cause: new Error("Missing history deletion receipt.") });
          yield* options.threads.endDeletedHistorySessions(receipt.externalSessionIds).pipe(toRemovalFailed);
          this.#publishRemoved(input.agentId, threadId, receipt.messageIds, receipt.revision);
          if (!previous) {
            yield* removalStep(() => options.store.database.threadMessageIds(threadId).length === 0).pipe(
              Effect.andThen((empty) =>
                empty ? options.store.updatePreview(input.agentId, "").pipe(toRemovalFailed) : Effect.void,
              ),
            );
            options.browser.unshareThread(threadId);
            options.fileHistory.forgetThread(threadId);
          }
          // A retry uses only the IDs in the original receipt. Later deliveries stay intact.
          const cleaned = yield* options.mailbox
            .deleteShownMessages(input.agentId, receipt.messageIds)
            .pipe(toRemovalFailed);
          if (cleaned === "busy")
            return yield* new ConversationRemovalFailed({ cause: new MessageDeleteRefused({ reason: "busy" }) });
          yield* options.mailbox.cleanupDeletedGeneratedAttachments([threadId]).pipe(toRemovalFailed);
          return { deleted: receipt.messageIds.length > 0 };
        }),
      (release) => Effect.sync(release),
    );
  }, Effect.uninterruptible).bind(this);

  readonly deleteChannelMessage = Effect.fn("ConversationRemoval.deleteChannelMessage")(function* (
    this: ConversationRemoval,
    input: ChannelMessageDeleteInput,
    access: MessageDeleteAccess = OWNER_ACCESS,
  ) {
    return yield* this.#options.channels
      .deleteMessage(input, access)
      .pipe(
        Effect.mapError(
          (failure) =>
            new ConversationRemovalFailed({ cause: failure instanceof MessageDeleteRefused ? failure : failure.cause }),
        ),
      );
  }).bind(this);

  readonly deleteChannelHistory = Effect.fn("ConversationRemoval.deleteChannelHistory")(function* (
    this: ConversationRemoval,
    input: ChannelHistoryDeleteInput,
  ) {
    const options = this.#options;
    const contexts = yield* removalStep(() => options.channels.store.contexts(input.channelId));
    const result = yield* options.channels
      .deleteHistory(input, {
        busy: (members) =>
          members.some(
            ({ agentId, threadId }) =>
              options.isDeleting(agentId) ||
              Boolean(options.conversation.loadedExecutionSnapshot(threadId)?.activeTurnId) ||
              options.store.database.readActiveTurnId(agentId, threadId) !== null ||
              Boolean(
                options.store.database.connection
                  .prepare("SELECT 1 FROM projection_turns WHERE thread_id = ? AND status = 'running' LIMIT 1")
                  .get(threadId),
              ) ||
              options.mailbox.channelLanes(agentId).includes(channelLane(input.channelId)) ||
              options.compaction
                .heldThreads(agentId)
                .some((external) => options.conversation.publicThreadId(agentId, external) === threadId),
          ),
        end: (externalSessionIds) =>
          options.threads.endDeletedHistorySessions(externalSessionIds).pipe(toRemovalFailed),
      })
      .pipe(
        Effect.mapError(
          (failure) =>
            new ConversationRemovalFailed({ cause: failure instanceof MessageDeleteRefused ? failure : failure.cause }),
        ),
      );
    for (const { agentId, threadId } of contexts) {
      options.conversation.registerChannelThread(agentId, threadId, input.channelId);
      const receipt = yield* removalStep(() =>
        options.store.database.threadHistoryDeletionReceipt(threadId, `channel:${input.channelId}:${input.requestId}`),
      );
      if (receipt) {
        yield* options.threads.endDeletedHistorySessions(receipt.externalSessionIds).pipe(toRemovalFailed);
        this.#publishRemoved(agentId, threadId, receipt.messageIds, receipt.revision);
        const cleaned = yield* options.mailbox.deleteShownMessages(agentId, receipt.messageIds).pipe(toRemovalFailed);
        if (cleaned === "busy")
          return yield* new ConversationRemovalFailed({ cause: new MessageDeleteRefused({ reason: "busy" }) });
      }
      options.fileHistory.forgetThread(threadId);
      options.browser.unshareThread(threadId);
    }
    yield* options.mailbox
      .cleanupDeletedGeneratedAttachments(contexts.map(({ threadId }) => threadId))
      .pipe(toRemovalFailed);
    return result;
  }).bind(this);

  #publishRemoved(agentId: string, threadId: string, ids: readonly string[], revision: number): void {
    const options = this.#options;
    const removed = new Set(ids);
    const current = options.conversation.ensureSnapshot(agentId, threadId);
    const snapshot: ConversationSnapshot = {
      ...current,
      messages: current.messages.filter((message) => !removed.has(message.id)),
      revision: Math.max(current.revision ?? 0, revision),
    };
    options.conversation.setSnapshot(agentId, snapshot);
    options.conversation.publishConversation(snapshot);
    for (let offset = 0; offset < ids.length; offset += MESSAGE_DELETION_EVENT_MAX_IDS)
      options.emit({
        type: "conversation-messages-deleted",
        agentId,
        threadId,
        messageIds: ids.slice(offset, offset + MESSAGE_DELETION_EVENT_MAX_IDS),
      });
  }
}
