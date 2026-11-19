import { sourceText } from "@tommy/i18n/source";
import { Effect } from "effect";
import type { MailboxStore, TelegramExchangeOrigin } from "../mailbox-store";
import { StoredStateFailure } from "../stored-state-effects";
import { ToolOperationFailed } from "./tool-operation";

export type TelegramExchangeGate = (
  senderAgentId: string,
  recipients: readonly string[],
  origins: ReturnType<MailboxStore["telegramExchangeOriginsForTurn"]>,
  text: string,
) => Effect.Effect<TelegramExchangeOrigin, ToolOperationFailed>;

/** Applies the same Telegram receipt policy to explicit tool calls and implicit final replies. */
export class AgentTelegramExchange {
  gate: TelegramExchangeGate | null = null;

  constructor(private readonly mailbox: MailboxStore) {}

  readonly confirmFailure = Effect.fn("AgentTelegramExchange.confirmFailure")(function* (
    this: AgentTelegramExchange,
    sender: string,
    recipient: string,
    origin: TelegramExchangeOrigin,
    notice: string,
  ) {
    const gate = this.gate;
    if (!gate)
      return yield* new StoredStateFailure({
        cause: new Error(sourceText("error.messaging.telegramExchangeUnavailable")),
      });
    const receipt = yield* gate(sender, [recipient], [{ exchange: origin }], notice).pipe(
      Effect.mapError(({ cause }) => new StoredStateFailure({ cause })),
    );
    if (gate !== this.gate)
      return yield* new StoredStateFailure({
        cause: new Error(sourceText("error.messaging.telegramExchangeUnavailable")),
      });
    return receipt;
  }).bind(this);

  readonly confirm = Effect.fn("AgentTelegramExchange.confirm")(function* (
    this: AgentTelegramExchange,
    agentId: string,
    turnId: string,
    recipients: string[],
    text: () => string,
    key: string,
  ) {
    if (this.mailbox.receiptForKey(key)) return;
    const origins = this.mailbox.telegramExchangeOriginsForTurn(agentId, turnId);
    // Agents of a Telegram owner talk inside Tommy, as in the app. Telegram shows the messages in
    // each bot's chat. Only a chain that started over Telegram bot-to-bot messages stays there.
    if (!origins.some((origin) => origin.exchange)) return;
    const gate = this.gate;
    const failure = () =>
      new ToolOperationFailed({ cause: new Error(sourceText("error.messaging.telegramExchangeUnavailable")) });
    if (!gate) return yield* failure();
    const validateRecipients = yield* Effect.try({
      try: () => this.mailbox.prepareDelivery(recipients),
      catch: failure,
    });
    const result = yield* gate(agentId, recipients, origins, text());
    if (
      gate !== this.gate ||
      JSON.stringify(origins) !== JSON.stringify(this.mailbox.telegramExchangeOriginsForTurn(agentId, turnId))
    ) {
      return yield* failure();
    }
    yield* Effect.try({ try: validateRecipients, catch: failure });
    return result;
  }).bind(this);
}
