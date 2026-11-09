// The logins and credit cards of 1Password, read with the `op` CLI and a service account token. The
// browser fills them through the `PasswordVault` and `SharedCards` ports, so an agent never gets a
// password or a card number in a tool result.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cardBrand } from "@tommy/contracts/ipc";
import { registerSecretValue, registerSecretValues } from "@tommy/logging";
import { Effect, Result, Schema } from "effect";
import { causeHelpers } from "../backend/effect-boundary";
import { type PasswordVault, PasswordVaultError, websiteMatchesOrigin } from "../backend/password-vault";
import {
  cardNumberLogForms,
  SHARED_CARD_ID_PREFIX,
  type SharedCards,
  type VaultCardForAgent,
  type VaultCardSecret,
} from "../backend/vault-items";

const { io: opCall, sync: opDecode } = causeHelpers(PasswordVaultError);

const LIST_LIFETIME_MS = 60_000;
const OP_TIMEOUT_MS = 20_000;
const CARD_READ_CONCURRENCY = 4;

const listSchema = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    vault: Schema.Struct({ id: Schema.String }),
    additional_information: Schema.optionalKey(Schema.String),
    urls: Schema.optionalKey(Schema.Array(Schema.Struct({ href: Schema.String }))),
  }),
);

const itemSchema = Schema.Struct({
  fields: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.optionalKey(Schema.String),
        type: Schema.String,
        purpose: Schema.optionalKey(Schema.String),
        value: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

type ListedItem = (typeof listSchema.Type)[number];

const run = promisify(execFile);

export class OnePasswordCliVault implements PasswordVault, SharedCards {
  readonly #token: string | undefined;
  #list: { items: readonly ListedItem[]; expires: number } | null = null;
  #cardItems: { items: readonly ListedItem[]; expires: number } | null = null;
  // Only what an agent may see. The number and the security code are read again for each fill.
  #cards: { cards: readonly VaultCardForAgent[]; expires: number } | null = null;

  constructor(token: string | undefined) {
    this.#token = token || undefined;
    if (this.#token) registerSecretValue(this.#token);
  }

  connected(): boolean {
    return this.#token !== undefined;
  }

  readonly loginsFor = Effect.fn("OnePasswordCliVault.loginsFor")(function* (
    this: OnePasswordCliVault,
    origin: string,
  ) {
    if (!this.connected()) return null;
    const items = yield* this.#items();
    return yield* Effect.forEach(
      items.filter((item) => saved(item, origin)),
      (item) =>
        Effect.map(this.#fields(item, []), (fields) => ({
          id: item.id,
          title: item.title,
          username: item.additional_information || null,
          hasOneTimePassword: fields.some((field) => field.type === "OTP"),
        })),
    );
  });

  readonly secretFor = Effect.fn("OnePasswordCliVault.secretFor")(function* (
    this: OnePasswordCliVault,
    loginId: string,
    origin: string,
    kind: "password" | "totp",
  ) {
    if (!this.connected()) return null;
    const items = yield* this.#items();
    const item = items.find((candidate) => candidate.id === loginId);
    if (!item || !saved(item, origin)) return null;
    if (kind === "totp") {
      const fields = yield* this.#fields(item, []);
      if (!fields.some((field) => field.type === "OTP")) return null;
      const code = (yield* this.#op("item", "get", item.id, "--vault", item.vault.id, "--otp")).trim();
      return code || null;
    }
    const fields = yield* this.#fields(item, ["--reveal"]);
    const password = fields.find((field) => field.purpose === "PASSWORD")?.value || null;
    if (password) registerSecretValues([password], { allowShort: true });
    return password;
  });

  readonly cards = Effect.fn("OnePasswordCliVault.cards")(function* (this: OnePasswordCliVault) {
    if (!this.connected()) return { cards: [], unreadable: 0 };
    if (this.#cards && this.#cards.expires > Date.now()) return { cards: this.#cards.cards, unreadable: 0 };
    const items = yield* this.#creditCards();
    // One unreadable item must not hide the other cards.
    const reads = yield* Effect.forEach(
      items,
      (item) => Effect.map(Effect.result(this.#card(item)), (read) => ({ item, read })),
      { concurrency: CARD_READ_CONCURRENCY },
    );
    const cards: VaultCardForAgent[] = [];
    let failure: PasswordVaultError | null = null;
    let unreadable = 0;
    for (const { item, read } of reads) {
      if (Result.isFailure(read)) {
        failure = read.failure;
        unreadable += 1;
      } else if (read.success) cards.push(cardForAgent(item, read.success));
    }
    if (failure && cards.length === 0) return yield* failure;
    if (unreadable === 0) this.#cards = { cards, expires: Date.now() + LIST_LIFETIME_MS };
    return { cards, unreadable };
  });

  readonly cardSummary = Effect.fn("OnePasswordCliVault.cardSummary")(function* (
    this: OnePasswordCliVault,
    cardId: string,
  ) {
    const item = yield* this.#creditCard(cardId);
    if (!item) return null;
    const card = yield* this.#card(item);
    return card ? cardForAgent(item, card) : null;
  });

  readonly cardSecret = Effect.fn("OnePasswordCliVault.cardSecret")(function* (
    this: OnePasswordCliVault,
    cardId: string,
  ) {
    const item = yield* this.#creditCard(cardId);
    return item ? yield* this.#card(item) : null;
  });

  #creditCard(cardId: string): Effect.Effect<ListedItem | null, PasswordVaultError> {
    if (!this.connected()) return Effect.succeed(null);
    return Effect.map(
      this.#creditCards(),
      (items) => items.find((candidate) => sharedCardId(candidate) === cardId) ?? null,
    );
  }

  #creditCards(): Effect.Effect<readonly ListedItem[], PasswordVaultError> {
    return Effect.gen({ self: this }, function* () {
      if (this.#cardItems && this.#cardItems.expires > Date.now()) return this.#cardItems.items;
      const output = yield* this.#op("item", "list", "--categories", "Credit Card", "--format", "json");
      const items = yield* opDecode(() => Schema.decodeUnknownSync(listSchema)(JSON.parse(output)));
      this.#cardItems = { items, expires: Date.now() + LIST_LIFETIME_MS };
      return items;
    });
  }

  /** The values of one card, or null when it has no usable number or expiry. */
  #card(item: ListedItem): Effect.Effect<VaultCardSecret | null, PasswordVaultError> {
    return this.#op("item", "get", item.id, "--vault", item.vault.id, "--format", "json", "--reveal").pipe(
      Effect.flatMap((output) =>
        opDecode(() => cardFromFields(Schema.decodeUnknownSync(itemSchema)(JSON.parse(output)).fields ?? [])),
      ),
      // A failure can quote the output, and the output holds the card number. Logs get this text only.
      Effect.mapError(() => new PasswordVaultError({ cause: new Error("op could not read a credit card item.") })),
    );
  }

  #items(): Effect.Effect<readonly ListedItem[], PasswordVaultError> {
    return Effect.gen({ self: this }, function* () {
      if (this.#list && this.#list.expires > Date.now()) return this.#list.items;
      const output = yield* this.#op("item", "list", "--categories", "Login", "--format", "json");
      const items = yield* opDecode(() => Schema.decodeUnknownSync(listSchema)(JSON.parse(output)));
      this.#list = { items, expires: Date.now() + LIST_LIFETIME_MS };
      return items;
    });
  }

  #fields(item: ListedItem, flags: readonly string[]) {
    return Effect.gen({ self: this }, function* () {
      const output = yield* this.#op("item", "get", item.id, "--vault", item.vault.id, "--format", "json", ...flags);
      return yield* opDecode(() => Schema.decodeUnknownSync(itemSchema)(JSON.parse(output)).fields ?? []);
    });
  }

  #op(...args: readonly string[]): Effect.Effect<string, PasswordVaultError> {
    return opCall(async (signal) => {
      const { stdout } = await run("op", args, {
        env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: this.#token },
        maxBuffer: 32 * 1024 * 1024,
        signal,
        timeout: OP_TIMEOUT_MS,
      });
      return stdout;
    });
  }
}

type ItemField = NonNullable<(typeof itemSchema.Type)["fields"]>[number];

function sharedCardId(item: ListedItem): string {
  return `${SHARED_CARD_ID_PREFIX}${item.id}`;
}

function cardForAgent(item: ListedItem, card: VaultCardSecret): VaultCardForAgent {
  return {
    id: sharedCardId(item),
    label: item.title,
    nameOnCard: card.nameOnCard,
    brand: cardBrand(card.number),
    last4: card.number.slice(-4),
    expiry: `${String(card.expMonth).padStart(2, "0")}/${card.expYear}`,
    hasSecurityCode: card.securityCode !== "",
    billingContactId: null,
    source: "1password",
  };
}

/** The card in the built-in fields of a 1Password Credit Card item. */
function cardFromFields(fields: readonly ItemField[]): VaultCardSecret | null {
  const value = (id: string) => fields.find((field) => field.id === id)?.value?.trim() ?? "";
  const number = (value("ccnum") || fields.find((field) => field.type === "CREDIT_CARD_NUMBER")?.value || "").replace(
    /\D/gu,
    "",
  );
  const expiry = cardExpiry(
    value("expiry") || fields.find((field) => field.type === "MONTH_YEAR" && field.id !== "validFrom")?.value || "",
  );
  if (number.length < 12 || number.length > 19 || !expiry) return null;
  // As in the Vault: a three-digit code is not registered, because that pattern would remove numbers
  // from every log line.
  registerSecretValues(cardNumberLogForms(number));
  return { number, securityCode: value("cvv"), ...expiry, nameOnCard: value("cardholder") };
}

/** Month and four-digit year from the forms that 1Password writes: YYYYMM, YYYY/MM, MM/YYYY and MM/YY. */
function cardExpiry(text: string): { expMonth: number; expYear: number } | null {
  const value = text.trim();
  const yearFirst = /^(\d{4})[/-]?(\d{2})$/u.exec(value);
  const monthFirst = /^(\d{2})[/-]?(\d{4})$/u.exec(value);
  const shortYear = /^(\d{2})[/-]?(\d{2})$/u.exec(value);
  const candidates = [
    yearFirst && { expMonth: Number(yearFirst[2]), expYear: Number(yearFirst[1]) },
    monthFirst && { expMonth: Number(monthFirst[1]), expYear: Number(monthFirst[2]) },
    shortYear && { expMonth: Number(shortYear[1]), expYear: 2000 + Number(shortYear[2]) },
  ];
  return (
    candidates.find(
      (candidate) => candidate && candidate.expMonth >= 1 && candidate.expMonth <= 12 && candidate.expYear >= 2000,
    ) ?? null
  );
}

function saved(item: ListedItem, origin: string): boolean {
  return (item.urls ?? []).some(({ href }) => websiteMatchesOrigin({ url: href, autofill: "anywhere" }, origin));
}
