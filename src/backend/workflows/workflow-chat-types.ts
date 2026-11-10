/** Host-owned connector values used by Slack and Telegram workflow adapters. */

export type MessagingTelegramSend =
  | { action: "reply"; threadKey: string; messageId: string; text: string }
  | { action: "post"; text: string }
  | { action: "react"; messageId: string; emoji: string };

/** A message in a Telegram group that starts a conversation with Tommy, for the Telegram triggers of workflows. */
export interface MessagingTelegramMention {
  connectionId: string;
  chatName: string;
  chatId: string;
  /** The topic or reply chain of the message, which a reply keeps. */
  threadKey: string;
  messageId: string;
  authorId: string;
  authorName: string;
  /** The text without the service account mention. */
  text: string;
  /** ISO time. */
  receivedAt: string;
}

/**
 * A post or a reaction of a workflow's Slack output, in one channel of the connection's workspace.
 * `threadId` is the timestamp of the thread's first message; `emoji` is a Slack reaction name.
 */
export type MessagingSlackSend =
  | { action: "reply"; channelId: string; threadId: string; text: string }
  | { action: "post"; channelId: string; text: string }
  | { action: "react"; channelId: string; messageId: string; emoji: string };

/** A message in a Slack channel that mentions Tommy, for the Slack triggers of workflows. */
export interface MessagingSlackMention {
  connectionId: string;
  workspaceName: string;
  channelId: string;
  channelName: string;
  /** The timestamp of the message. */
  messageId: string;
  /** The thread a reply goes to: the mention's thread, or the mention itself at the top level. */
  threadId: string;
  authorId: string;
  authorName: string;
  /** The text with each mention as `@name`. */
  text: string;
  /** The files of the message. Their addresses need the connection token, so a workflow sees only their names. */
  files: readonly { name: string; mimeType: string; size: number }[];
  /** ISO time. */
  receivedAt: string;
}
