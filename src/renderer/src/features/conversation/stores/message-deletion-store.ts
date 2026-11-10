import type { AgentMessage } from "@tommy/ui/data";
import { currentText } from "@tommy/ui/text";
import { createEffect, createMemo, createStore } from "solid-js";
import { serverRoleCanAdminister, serverSupportsCapability } from "../../servers/server-capabilities";
import { conversationRuntime } from "../conversation-runtime";
import type { ConversationProps } from "../conversation-types";
import { PENDING_SEND_ID_PREFIX } from "./pending-send-store";

interface DeleteRequest {
  kind: "message" | "history";
  serverId: string;
  agentId: string | null;
  channelId: string | null;
  taskId?: string;
  messageId?: string;
  requestId: string;
}

/** The request ID survives a failed confirmation, so Retry cannot repeat a deletion. */
export function createMessageDeletionStore(props: ConversationProps) {
  const [state, setState] = createStore<{ request: DeleteRequest | null; pending: boolean; error: string | null }>({
    request: null,
    pending: false,
    error: null,
  });
  const calls = () => conversationRuntime(props).agent;
  const available = () =>
    serverSupportsCapability(props.server, "message-delete-v1") &&
    (props.server?.kind === "local" || props.server?.state === "online") &&
    (props.channel
      ? !!calls().deleteChannelMessage && !!calls().deleteChannelHistory
      : !!calls().deleteMessage && !!calls().deleteTaskMessage && !!calls().deleteAgentHistory);
  const canDeleteMessage = (message: AgentMessage) =>
    available() &&
    (serverRoleCanAdminister(props.server) ||
      (message.author === "you" && message.senderMember !== undefined && props.isOwnSender(message.senderMember.id)));
  const busy = () =>
    !!props.activeTurnId || (props.threads?.running ?? 0) > 0 || (props.channel?.workers().length ?? 0) > 0;
  const deletionScope = createMemo(() =>
    JSON.stringify([props.server?.id, props.agent?.id, props.channel?.id, props.server?.role, available()]),
  );
  createEffect(deletionScope, () =>
    setState((draft) => {
      draft.request = null;
      draft.pending = false;
      draft.error = null;
    }),
  );
  function request(kind: DeleteRequest["kind"], message?: AgentMessage, taskId?: string): void {
    if (
      !available() ||
      busy() ||
      state.pending ||
      message?.streaming ||
      (message && (!canDeleteMessage(message) || message.id.startsWith(PENDING_SEND_ID_PREFIX)))
    )
      return;
    setState((draft) => {
      draft.request = {
        kind,
        serverId: props.server?.id ?? "local",
        agentId: props.agent?.id ?? null,
        channelId: props.channel?.id ?? null,
        requestId: crypto.randomUUID(),
        ...(message ? { messageId: message.id } : {}),
        ...(taskId ? { taskId } : {}),
      };
      draft.error = null;
    });
  }
  async function confirm(): Promise<void> {
    const request = state.request;
    if (!request || state.pending) return;
    const api = calls();
    const text = currentText();
    if (busy()) {
      setState((draft) => {
        draft.error = text.t("chat.delete.busy");
      });
      return;
    }
    setState((draft) => {
      draft.pending = true;
      draft.error = null;
    });
    try {
      const { serverId, requestId } = request;
      if (request.channelId) {
        const channelId = request.channelId;
        if (request.kind === "history" && api.deleteChannelHistory)
          await api.deleteChannelHistory({ channelId, requestId }, serverId);
        else if (request.messageId && api.deleteChannelMessage)
          await api.deleteChannelMessage({ channelId, messageId: request.messageId, requestId }, serverId);
        else throw new Error(text.t("chat.delete.failed"));
      } else if (request.agentId) {
        const agentId = request.agentId;
        if (request.kind === "history" && api.deleteAgentHistory)
          await api.deleteAgentHistory({ agentId, requestId }, serverId);
        else if (request.messageId && request.taskId && api.deleteTaskMessage)
          await api.deleteTaskMessage(
            { agentId, taskId: request.taskId, messageId: request.messageId, requestId },
            serverId,
          );
        else if (request.messageId && api.deleteMessage)
          await api.deleteMessage({ agentId, messageId: request.messageId, requestId }, serverId);
        else throw new Error(text.t("chat.delete.failed"));
      }
      if (state.request?.requestId !== request.requestId) return;
      if (request.kind === "history") await props.onLoadLatest?.();
      if (state.request?.requestId === request.requestId)
        setState((draft) => {
          draft.request = null;
        });
    } catch (error) {
      if (state.request?.requestId === request.requestId)
        setState((draft) => {
          draft.error = text.errorMessage(error, text.t("chat.delete.failed"));
        });
    } finally {
      if (state.request?.requestId === request.requestId || state.request === null)
        setState((draft) => {
          draft.pending = false;
        });
    }
  }
  return {
    state,
    available,
    canDeleteMessage,
    historyAvailable: () => available() && serverRoleCanAdminister(props.server),
    busy,
    requestMessage: (message: AgentMessage, taskId?: string) => request("message", message, taskId),
    requestHistory: () => request("history"),
    confirm,
    cancel: () => {
      if (!state.pending)
        setState((draft) => {
          draft.request = null;
          draft.error = null;
        });
    },
  };
}
