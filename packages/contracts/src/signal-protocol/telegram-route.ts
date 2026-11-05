// The Telegram route: how a Telegram update finds the host that answers it, and how that host
// answers without the bot token.
//
// One Tommy bot serves every user. Its token is in Signal only: a host that had it could read and
// post in every chat of every user. Telegram posts each update to
// `https://signal.example.com/v1/telegram/updates/<bot ID>` with a secret header. Signal checks the
// header, reads the chat ID, and passes the update to the `ingress` socket that holds a route ticket
// for that chat. The host calls the Bot API through the same socket (`telegram-call`): Signal
// accepts only the methods below, with only the parameters below, and only for the chats routed to
// that socket.
//
// A chat is linked to a host with a one-use code. The host asks the account service for a code, and
// the user opens `https://t.me/<bot>?startgroup=<code>` (a group) or `?start=<code>` (a direct chat).
// Telegram then sends `/start <code>` in that chat. Signal asks the account service to link the chat
// to the host that asked for the code, and routes the chat to that host's socket at once.
//
// The route ticket is an ES256 JWT that `apps/auth-api` mints for a host that proves its machine
// token, with the key of the Slack route ticket and its own audience. It names only the chats that
// the account service links to that host, and it expires: the host asks for a new one each time its
// `ingress` socket connects.

/** The most chats one host can link. */
export const TELEGRAM_ROUTE_CHATS_LIMIT = 64;

export interface TelegramInlineButton {
  text: string;
  /** 1 to 64 bytes. */
  callback_data: string;
}
