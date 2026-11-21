import { Effect, Schema } from "effect";
import type { AgentStore } from "../agent-store";
import { type ConversationMarkerExclusions, ConversationReadStore } from "../conversation-read-store";
import { mergeConversationSnapshots } from "../conversation-snapshots";
import { causeHelpers } from "../effect-boundary";
import type { ConversationRuntime } from "./conversation-runtime";
import type { MailboxSync } from "./mailbox-sync";

export interface ConversationReaderOptions {
  store: AgentStore;
  conversation: ConversationRuntime;
  mailboxSync: MailboxSync;
}

/** Loads a durable conversation and advances task read cursors. */
export class ConversationReader {
  readonly #store: AgentStore;
  readonly #conversation: ConversationRuntime;
  readonly #mailboxSync: MailboxSync;
  readonly #reads: ConversationReadStore;

  constructor(options: ConversationReaderOptions) {
    this.#store = options.store;
    this.#conversation = options.conversation;
    this.#mailboxSync = options.mailboxSync;
    this.#reads = new ConversationReadStore(options.store.database);
  }

  readonly read = Effect.fn("ConversationReader.read")(function* (this: ConversationReader, agentId: string) {
    const agent = yield* this.#store.existing(agentId).pipe(toConversationReadFailed);
    return yield* readerStep(() => {
      // The legacy read endpoint still returns the complete durable conversation. `setSnapshot`
      // keeps only a bounded recent view after this transient response is built, so this read does
      // not turn a large chat into a long-lived process cache.
      const persisted = this.#store.database.readConversation(agentId, agent.threadId);
      const live = this.#conversation.snapshot(agentId);
      const snapshot = live?.activeTurnId ? mergeConversationSnapshots(persisted, live) : persisted;
      this.#mailboxSync.syncMailboxMessages(snapshot);
      this.#conversation.setSnapshot(agentId, snapshot);
      return structuredClone(snapshot);
    });
  }, Effect.uninterruptible);

  /** Moves the member's read mark of a side thread. The mark never moves back. */
  markThreadRead(
    memberId: string,
    threadId: string,
    throughMessageId: string,
    options: ConversationMarkerExclusions = {},
  ) {
    return this.#reads.markReadForThread(memberId, threadId, throughMessageId, options);
  }
}

class ConversationReadFailed extends Schema.TaggedError<ConversationReadFailed>()("ConversationReadFailed", {
  cause: Schema.Defect(),
}) {}

const { sync: readerStep, rewrap: toConversationReadFailed } = causeHelpers(ConversationReadFailed);
