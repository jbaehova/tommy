// The workflow steps that read and answer Discord. Tommy has no Discord connection, so nothing starts them.

export interface MessagingDiscordMention {
  connectionId: string;
  serverName: string;
  channelId: string;
  channelName: string;
  messageId: string;
  authorId: string;
  authorName: string;
  authorRoleIds: readonly string[];
  /** The text with each mention as `@name`. */
  text: string;
  files: readonly { name: string; mimeType: string; size: number; url: string }[];
  /** ISO time. */
  receivedAt: string;
}

export type MessagingDiscordSend =
  | { action: "reply"; channelId: string; messageId: string; text: string }
  | { action: "post"; channelId: string; text: string }
  | { action: "react"; channelId: string; messageId: string; emoji: string };

export type MessagingMentionResult = "none" | "started" | "skipped";

export type MessagingPostFailure = "gone" | "not-running" | "refused" | "unknown";
