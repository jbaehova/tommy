import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type {
  AgentTaskReadState,
  ConversationFileSearchPage,
  ConversationSearchPage,
  ConversationSnapshot,
} from "@tommy/contracts/ipc";
import type { MessageDeletionEvent } from "@tommy/contracts/ipc-message-deletion";
import type { MobileChannelStore } from "@/features/channels/model/channel-store";
import type { MobileConversationStore } from "./conversation-store";
import { type QueryScope, queryKeys } from "./query-keys";

export type MobileMessageDeletion = MessageDeletionEvent;

/** Events hold exact IDs. Preserve later messages, drafts and outbox items. */
export function applyMobileMessageDeletion(
  input: {
    queryClient: QueryClient;
    queryScope: QueryScope;
    serverId: string;
    conversations: MobileConversationStore;
    channels: MobileChannelStore;
  },
  event: MobileMessageDeletion,
): void {
  const { queryClient, queryScope, serverId, conversations, channels } = input;
  const ids = new Set(event.messageIds);
  if (event.type === "channel-messages-deleted") {
    channels.deleteMessages(serverId, event.channelId, ids);
    return;
  }
  conversations.deleteMessages(event.agentId, event.threadId, ids);
  const reads = queryKeys.agentThreadReads(queryScope, serverId, event.agentId);
  void queryClient.cancelQueries({ queryKey: reads, exact: true });
  queryClient.setQueryData<AgentTaskReadState[]>(reads, (stored) =>
    stored?.map((read) => ({
      ...read,
      firstUnreadMessageId:
        read.firstUnreadMessageId && ids.has(read.firstUnreadMessageId) ? null : read.firstUnreadMessageId,
      throughMessageId: read.throughMessageId && ids.has(read.throughMessageId) ? null : read.throughMessageId,
    })),
  );
  void queryClient.invalidateQueries({ queryKey: reads, exact: true });
  const tasks = queryKeys.agentTaskConversations(queryScope, serverId);
  void queryClient.cancelQueries({ queryKey: tasks });
  queryClient.setQueriesData<ConversationSnapshot>({ queryKey: tasks }, (stored) =>
    !stored || stored.threadId !== event.threadId
      ? stored
      : {
          ...stored,
          messages: stored.messages.filter((message) => !ids.has(message.id)),
        },
  );
  const messages = queryKeys.messageSearch(queryScope, serverId);
  const files = queryKeys.fileSearch(queryScope, serverId);
  void queryClient.cancelQueries({ queryKey: messages });
  void queryClient.cancelQueries({ queryKey: files });
  queryClient.setQueriesData<InfiniteData<ConversationSearchPage>>(
    { queryKey: messages },
    (stored) =>
      stored && {
        ...stored,
        pages: stored.pages.map((page) => {
          const results = page.results.filter((entry) => entry.agentId !== event.agentId || !ids.has(entry.message.id));
          return { ...page, results, total: Math.max(0, page.total - (page.results.length - results.length)) };
        }),
      },
  );
  queryClient.setQueriesData<InfiniteData<ConversationFileSearchPage>>(
    { queryKey: files },
    (stored) =>
      stored && {
        ...stored,
        pages: stored.pages.map((page) => ({
          ...page,
          results: page.results.filter((entry) => entry.agentId !== event.agentId || !ids.has(entry.messageId)),
        })),
      },
  );
  void queryClient.invalidateQueries({ queryKey: tasks });
  void queryClient.invalidateQueries({ queryKey: messages });
  void queryClient.invalidateQueries({ queryKey: files });
}
