import { useQueryClient } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { showFailureAlert } from "@/features/analytics/failure-reports";
import { useQueryScope } from "@/features/auth/context/mobile-session-context";
import { useAgentCanManage } from "@/features/servers/model/use-server-roles";
import {
  useMobileWorkspaceReader,
  useMobileWorkspaceSelector,
} from "@/features/workspace/context/mobile-workspace-context";
import { applyMobileMessageDeletion } from "@/features/workspace/model/message-deletion-cache";
import { haptics } from "@/shared/lib/haptics";
import { useText } from "@/shared/lib/text";
import { useAppForeground } from "@/shared/lib/use-app-foreground";
import type { ChatBubbleMessage } from "../model/chat-messages";

interface ChatDeletionInput {
  serverId: string;
  agentId?: string;
  channelId?: string;
  taskId?: string;
  threadId?: string | null;
  activeTurnId?: string | null;
}

/** Confirmation belongs to the user action. Access is checked again by the host. */
export function useChatDeletion(input: ChatDeletionInput) {
  const { t } = useText();
  const workspace = useMobileWorkspaceReader();
  const queryClient = useQueryClient();
  const queryScope = useQueryScope();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const host = useMobileWorkspaceSelector((current) => current.servers.find((server) => server.id === input.serverId));
  const manager = useAgentCanManage(input.serverId, input.agentId ?? null);
  const online = useMobileWorkspaceSelector((current) =>
    current.servers.some((server) => server.id === input.serverId && server.state === "online"),
  );
  const supported = useMobileWorkspaceSelector((current) => current.canDeleteMessages(input.serverId));
  const historySupported = useMobileWorkspaceSelector((current) => current.canDeleteChatHistory(input.serverId));
  const [pending, setPending] = useState(false);
  const locked = useRef(false);
  // Keep a failed request's identity. A retry cannot remove messages that arrived after its commit.
  const operations = useRef(new Map<string, { requestId: string; messageIds: string[] }>());
  const scope = JSON.stringify([
    ...queryScope,
    input.serverId,
    input.agentId,
    input.channelId,
    input.taskId,
    input.threadId,
    host?.publicKey,
    host?.membershipId,
    host?.role,
    manager,
    supported,
    historySupported,
  ]);
  const active = online && focused && foreground;
  const latest = useRef({ scope, active, epoch: 0 });
  if (latest.current.scope !== scope || latest.current.active !== active)
    latest.current = { scope, active, epoch: latest.current.epoch + 1 };
  const epoch = latest.current.epoch;
  const mounted = useRef(true);
  const confirming = useRef<{ scope: string } | null>(null);
  const previousScope = useRef(scope);
  if (previousScope.current !== scope) {
    previousScope.current = scope;
    operations.current.clear();
    confirming.current = null;
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const currentScope = () =>
    mounted.current && latest.current.epoch === epoch && latest.current.scope === scope && latest.current.active;
  const canDelete = useCallback(
    (message: ChatBubbleMessage) =>
      active &&
      supported &&
      !pending &&
      Boolean(message.createdAt) &&
      !message.streaming &&
      (!input.activeTurnId || message.turnId !== input.activeTurnId) &&
      (manager || message.ownedByReader === true),
    [active, supported, pending, input.activeTurnId, manager],
  );
  const canDeleteHistory = active && historySupported && manager && !input.taskId && !input.activeTurnId;

  async function execute(key: string, message?: { id: string }) {
    if (locked.current || !currentScope() || (!input.agentId && !input.channelId)) return;
    locked.current = true;
    setPending(true);
    const current = workspace();
    const main = input.agentId ? current.conversationStore.get(input.agentId) : undefined;
    const page = input.channelId ? current.channelStore.get(input.serverId).pages.get(input.channelId) : undefined;
    const operation = operations.current.get(key) ?? {
      requestId: Crypto.randomUUID(),
      messageIds: message
        ? [message.id]
        : input.channelId
          ? (page?.messages.map((entry) => entry.id) ?? [])
          : [...(main?.messages.map((entry) => entry.id) ?? []), ...Object.keys(main?.references ?? {})],
    };
    operations.current.set(key, operation);
    const { requestId, messageIds: before } = operation;
    try {
      if (message) {
        if (input.channelId)
          await current.deleteChannelMessage(
            { channelId: input.channelId, messageId: message.id, requestId },
            input.serverId,
          );
        else if (input.agentId && input.taskId)
          await current.deleteTaskMessage(
            { agentId: input.agentId, taskId: input.taskId, messageId: message.id, requestId },
            input.serverId,
          );
        else if (input.agentId)
          await current.deleteAgentMessage(
            { agentId: input.agentId, messageId: message.id, requestId },
            input.serverId,
          );
      } else if (input.channelId)
        await current.deleteChannelHistory({ channelId: input.channelId, requestId }, input.serverId);
      else if (input.agentId) await current.deleteAgentHistory({ agentId: input.agentId, requestId }, input.serverId);
      if (!currentScope()) return;
      const context = {
        queryClient,
        queryScope,
        serverId: input.serverId,
        conversations: current.conversationStore,
        channels: current.channelStore,
      };
      if (input.channelId)
        applyMobileMessageDeletion(context, {
          type: "channel-messages-deleted",
          channelId: input.channelId,
          messageIds: before,
        });
      else if (input.agentId) {
        const threadId = input.threadId ?? main?.threadId;
        if (threadId)
          applyMobileMessageDeletion(context, {
            type: "conversation-messages-deleted",
            agentId: input.agentId,
            threadId,
            messageIds: before,
          });
        if (!input.taskId) await current.loadConversation(input.agentId, input.serverId);
      }
      operations.current.delete(key);
      if (currentScope()) void haptics.notification("success");
    } catch (cause) {
      if (!currentScope()) return;
      void haptics.notification("error");
      showFailureAlert(cause, t("mobile.chat.delete.failed"), t("mobile.chat.delete.retry"));
    } finally {
      locked.current = false;
      if (mounted.current) setPending(false);
    }
  }

  function confirm(message?: { id: string }) {
    if (locked.current || confirming.current || !currentScope()) return;
    const confirmation = { scope };
    confirming.current = confirmation;
    const close = () => {
      if (confirming.current === confirmation) confirming.current = null;
    };
    Alert.alert(
      t(message ? "mobile.chat.delete.messageTitle" : "mobile.chat.delete.historyTitle"),
      t(message ? "mobile.chat.delete.messageBody" : "mobile.chat.delete.historyBody"),
      [
        {
          text: t("common.cancel"),
          style: "cancel",
          onPress: close,
        },
        {
          text: t("mobile.chat.delete.action"),
          style: "destructive",
          onPress: () => {
            if (!currentScope() || confirming.current !== confirmation) return;
            close();
            void execute(`${scope}:${message?.id ?? "history"}`, message);
          },
        },
      ],
      {
        cancelable: true,
        onDismiss: close,
      },
    );
  }
  return {
    pending,
    canDelete,
    canDeleteHistory,
    deleteMessage: (message: ChatBubbleMessage, hostId = message.id) => {
      if (canDelete(message)) confirm({ id: hostId });
    },
    deleteHistory: () => {
      if (canDeleteHistory) confirm();
    },
  };
}
