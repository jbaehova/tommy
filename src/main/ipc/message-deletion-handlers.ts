import {
  type ChannelHistoryDeleteInput,
  type ChannelMessageDeleteInput,
  type HistoryDeleteInput,
  type HistoryDeleteResult,
  type MessageDeleteInput,
  type MessageDeleteResult,
  parseChannelHistoryDeleteInput,
  parseChannelMessageDeleteInput,
  parseHistoryDeleteInput,
  parseMessageDeleteInput,
  parseTaskMessageDeleteInput,
  type TaskMessageDeleteInput,
} from "@tommy/contracts/ipc-message-deletion";
import { CHAT_HISTORY_CAPABILITY, CHAT_HISTORY_ROUTES } from "@tommy/contracts/team-protocol/chat-history-v1";
import type { TeamCurrentCapability } from "@tommy/contracts/team-protocol/current";
import { MESSAGE_DELETE_CAPABILITY, MESSAGE_DELETE_ROUTES } from "@tommy/contracts/team-protocol/message-delete-v1";
import { sourceText } from "@tommy/i18n/source";
import type { Effect } from "effect";
import type { AgentLifecycleFailed } from "../../backend/agent-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import { decodeHistoryDeleteResultFromHost, decodeMessageDeleteResultFromHost } from "../remote-extension-decoding";
import type { ResponseDecoder } from "../remote-host-decoding";
import type { RemoteRequestInit } from "../remote-server-client";
import type { RemoteWorkflowError } from "../remote-service-effects";
import type { IpcGroupHandlers } from "./define-ipc-group";
import { scopedHandler } from "./scoped-handler";

export interface MessageDeletionIpcDependencies {
  deleteMessage(input: MessageDeleteInput): Effect.Effect<MessageDeleteResult, AgentLifecycleFailed>;
  deleteTaskMessage(input: TaskMessageDeleteInput): Effect.Effect<MessageDeleteResult, AgentLifecycleFailed>;
  deleteChannelMessage(input: ChannelMessageDeleteInput): Effect.Effect<MessageDeleteResult, AgentLifecycleFailed>;
  deleteAgentHistory(input: HistoryDeleteInput): Effect.Effect<HistoryDeleteResult, AgentLifecycleFailed>;
  deleteChannelHistory(input: ChannelHistoryDeleteInput): Effect.Effect<HistoryDeleteResult, AgentLifecycleFailed>;
  remoteServers: {
    supportsCapability(serverId: string, capability: TeamCurrentCapability): boolean;
    request<T>(
      serverId: string,
      path: string,
      decoder: ResponseDecoder<T>,
      init?: RemoteRequestInit,
    ): Effect.Effect<T, RemoteWorkflowError>;
  };
}

export function messageDeletionIpcHandlers(
  dependencies: MessageDeletionIpcDependencies,
): Pick<IpcGroupHandlers, "messageDeletion"> {
  const { remoteServers } = dependencies;
  function remote<T>(
    serverId: string,
    capability: typeof MESSAGE_DELETE_CAPABILITY | typeof CHAT_HISTORY_CAPABILITY,
    path: string,
    decoder: ResponseDecoder<T>,
    body:
      | MessageDeleteInput
      | TaskMessageDeleteInput
      | ChannelMessageDeleteInput
      | HistoryDeleteInput
      | ChannelHistoryDeleteInput,
  ): Promise<T> {
    if (!remoteServers.supportsCapability(serverId, capability))
      throw new Error(sourceText("error.team.agentSettingsUnsupported"));
    return runCauseEffect(remoteServers.request(serverId, path, decoder, { method: "POST", body }));
  }
  return {
    messageDeletion: {
      deleteMessage: scopedHandler(parseMessageDeleteInput, {
        local: (input) => runCauseEffect(dependencies.deleteMessage(input)),
        remote: (input, serverId) =>
          remote(
            serverId,
            MESSAGE_DELETE_CAPABILITY,
            MESSAGE_DELETE_ROUTES.agent,
            decodeMessageDeleteResultFromHost,
            input,
          ),
      }),
      deleteTaskMessage: scopedHandler(parseTaskMessageDeleteInput, {
        local: (input) => runCauseEffect(dependencies.deleteTaskMessage(input)),
        remote: (input, serverId) =>
          remote(
            serverId,
            MESSAGE_DELETE_CAPABILITY,
            MESSAGE_DELETE_ROUTES.task,
            decodeMessageDeleteResultFromHost,
            input,
          ),
      }),
      deleteChannelMessage: scopedHandler(parseChannelMessageDeleteInput, {
        local: (input) => runCauseEffect(dependencies.deleteChannelMessage(input)),
        remote: (input, serverId) =>
          remote(
            serverId,
            MESSAGE_DELETE_CAPABILITY,
            MESSAGE_DELETE_ROUTES.channel,
            decodeMessageDeleteResultFromHost,
            input,
          ),
      }),
      deleteAgentHistory: scopedHandler(parseHistoryDeleteInput, {
        local: (input) => runCauseEffect(dependencies.deleteAgentHistory(input)),
        remote: (input, serverId) =>
          remote(
            serverId,
            CHAT_HISTORY_CAPABILITY,
            CHAT_HISTORY_ROUTES.agentDelete,
            decodeHistoryDeleteResultFromHost,
            input,
          ),
      }),
      deleteChannelHistory: scopedHandler(parseChannelHistoryDeleteInput, {
        local: (input) => runCauseEffect(dependencies.deleteChannelHistory(input)),
        remote: (input, serverId) =>
          remote(
            serverId,
            CHAT_HISTORY_CAPABILITY,
            CHAT_HISTORY_ROUTES.channelDelete,
            decodeHistoryDeleteResultFromHost,
            input,
          ),
      }),
    },
  };
}
