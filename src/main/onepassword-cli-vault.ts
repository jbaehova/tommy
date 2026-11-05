// The logins of 1Password, read with the `op` CLI and a service account token. The browser fills them
// through the `PasswordVault` port, so an agent that signs in never gets the password in a tool result.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerSecretValue, registerSecretValues } from "@tommy/logging";
import { Effect, Schema } from "effect";
import { causeHelpers } from "../backend/effect-boundary";
import { type PasswordVault, PasswordVaultError, websiteMatchesOrigin } from "../backend/password-vault";

const { io: opCall, sync: opDecode } = causeHelpers(PasswordVaultError);

const LIST_LIFETIME_MS = 60_000;
const OP_TIMEOUT_MS = 20_000;

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
        type: Schema.String,
        purpose: Schema.optionalKey(Schema.String),
        value: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

type ListedItem = (typeof listSchema.Type)[number];

const run = promisify(execFile);

export class OnePasswordCliVault implements PasswordVault {
  readonly #token: string | undefined;
  #list: { items: readonly ListedItem[]; expires: number } | null = null;

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

function saved(item: ListedItem, origin: string): boolean {
  return (item.urls ?? []).some(({ href }) => websiteMatchesOrigin({ url: href, autofill: "anywhere" }, origin));
}
