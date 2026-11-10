// The Vault items of this computer, encrypted at rest by the operating system. The file holds one
// envelope. Authenticator setup keys use a separate encrypted envelope, so older builds preserve them.

import { readFile, rm } from "node:fs/promises";
import { sourceText } from "@tommy/i18n/source";
import { createTommyLogger } from "@tommy/logging";
import { Effect, Result, Schema, Semaphore } from "effect";
import { writeJsonFileAtomically } from "../backend/atomic-json-file";
import { causeHelpers } from "../backend/effect-boundary";
import { PasswordVaultError } from "../backend/password-vault";
import type { SecretCipher } from "./provider-credential-store";

const logger = createTommyLogger("vault-store");

const { io: vaultCall, sync: vaultDecode } = causeHelpers(PasswordVaultError);

/** The name of the agent that added an item. Absent when the user added it. */
const addedBy = Schema.optionalKey(Schema.String);

const loginSchema = Schema.Struct({
  id: Schema.String,
  /** An `https:` address or a host name, as the user typed it. */
  website: Schema.String,
  username: Schema.String,
  password: Schema.String,
  twoStepKey: Schema.optionalKey(Schema.String),
  notes: Schema.String,
  addedBy,
});

const cardSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  nameOnCard: Schema.String,
  /** Digits only. */
  number: Schema.String,
  expMonth: Schema.Number,
  expYear: Schema.Number,
  /** Digits only, or "" when the user did not save one. */
  securityCode: Schema.String,
  billingContactId: Schema.NullOr(Schema.String),
  /**
   * The HTTPS pages where the owner let agents fill this card, each with the origins of the frames that
   * got its fields. A fill anywhere else waits for the owner's approval. Absent when there is none.
   */
  fillSites: Schema.optionalKey(
    Schema.Array(Schema.Struct({ page: Schema.String, frames: Schema.Array(Schema.String) })),
  ),
  addedBy,
});

const contactSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  fullName: Schema.String,
  address: Schema.String,
  address2: Schema.String,
  city: Schema.String,
  region: Schema.String,
  postalCode: Schema.String,
  country: Schema.String,
  phone: Schema.String,
  email: Schema.String,
  addedBy,
});

const apiKeySchema = Schema.Struct({
  id: Schema.String,
  /** An environment variable name, unique in the Vault. */
  name: Schema.String,
  key: Schema.String,
  notes: Schema.String,
  addedBy,
});

const recordSchema = Schema.Struct({
  logins: Schema.Array(loginSchema),
  cards: Schema.Array(cardSchema),
  contacts: Schema.Array(contactSchema),
  // Absent in a file that a build before API keys wrote. Such a build drops the key on its next write.
  apiKeys: Schema.Array(apiKeySchema).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});

export type StoredLogin = typeof loginSchema.Type;
export type StoredCard = typeof cardSchema.Type;
export type StoredContact = typeof contactSchema.Type;
export type StoredApiKey = typeof apiKeySchema.Type;
export type VaultRecord = typeof recordSchema.Type;

const EMPTY_VAULT_RECORD: VaultRecord = { logins: [], cards: [], contacts: [], apiKeys: [] };

/** `version` is checked: an envelope that this build cannot read is reported as unreadable. */
const envelopeSchema = Schema.Struct({ version: Schema.Literal(1), record: Schema.String });
const twoStepKeysSchema = Schema.Array(Schema.Struct({ id: Schema.String, key: Schema.String }));

/** Thousands of items fit; a larger file is not one that this app wrote. */
const MAX_VAULT_ENVELOPE_BYTES = 4 * 1024 * 1024;

function unreadable() {
  return new PasswordVaultError({ cause: new Error(sourceText("error.vault.unreadable")) });
}

/**
 * Reads and writes the Vault file. The decrypted record is kept in memory only. Writes run one at a
 * time, because the settings page and an import can change the Vault together.
 */
export class VaultStore {
  readonly #path: string;
  readonly #cipher: SecretCipher;
  #record: VaultRecord = EMPTY_VAULT_RECORD;
  #twoStepKeys = new Map<string, string>();
  // True while the two-step file is there but cannot be read. The items stay usable without their
  // two-step keys, and the file is kept as it is until the user resets the Vault.
  #twoStepUnreadable = false;
  readonly #queue = Semaphore.makeUnsafe(1);

  constructor(path: string, cipher: SecretCipher) {
    this.#path = path;
    this.#cipher = cipher;
  }

  /**
   * Reads the file. False when the file is there but cannot be read; the file is then kept as it is.
   * An unreadable two-step file does not block the items: they load without their two-step keys.
   */
  load(): Effect.Effect<boolean> {
    return Effect.gen({ self: this }, function* () {
      this.#record = EMPTY_VAULT_RECORD;
      this.#twoStepKeys = new Map();
      this.#twoStepUnreadable = false;
      const result = yield* Effect.result(this.#read());
      if (Result.isFailure(result)) return false;
      this.#record = result.success ?? EMPTY_VAULT_RECORD;
      const keys = yield* Effect.result(this.#readTwoStepKeys());
      if (Result.isFailure(keys)) {
        this.#twoStepUnreadable = true;
        logger.warn("Vault items loaded without two-step keys. The unreadable two-step file is kept unchanged.");
        return true;
      }
      this.#twoStepKeys = new Map(keys.success.map(({ id, key }) => [id, key]));
      this.#record = {
        ...this.#record,
        logins: this.#record.logins.map((login) => {
          const key = this.#twoStepKeys.get(login.id) ?? login.twoStepKey;
          return key ? { ...login, twoStepKey: key } : login;
        }),
      };
      return true;
    });
  }

  read(): VaultRecord {
    return this.#record;
  }

  /**
   * Makes the next record from the current one and stores it. Each committed file updates its
   * in-memory state. An error that `change` throws fails the update; the same record back writes nothing.
   */
  update(change: (current: VaultRecord) => VaultRecord): Effect.Effect<VaultRecord, PasswordVaultError> {
    return this.#serialize(
      Effect.gen({ self: this }, function* () {
        const next = yield* vaultDecode(() => change(this.#record));
        if (next === this.#record) return next;
        const base = { ...next, logins: next.logins.map(({ twoStepKey: _key, ...login }) => login) };
        const encrypted = yield* vaultDecode(() => this.#cipher.encrypt(JSON.stringify(base)).toString("base64"));
        if (encrypted.length + 32 > MAX_VAULT_ENVELOPE_BYTES)
          return yield* new PasswordVaultError({ cause: new Error(sourceText("error.vault.tooLarge")) });
        if (this.#twoStepUnreadable) {
          // The two-step file cannot be read, so it is not replaced. A change that adds a key fails.
          if (next.logins.some((login) => login.twoStepKey)) return yield* unreadable();
          yield* writeJsonFileAtomically(this.#path, { version: 1, record: encrypted }, { createDirectory: true }).pipe(
            Effect.mapError(({ cause }) => new PasswordVaultError({ cause })),
          );
          this.#record = next;
          return next;
        }
        // A separate envelope survives writes from an older application that knows only Vault v1.
        // Keep unlinked keys until the base write commits. A failed base write must not silently
        // discard another saved setup key. A successful base commit permits their cleanup.
        const keys = new Map(this.#twoStepKeys);
        for (const login of this.#record.logins) keys.delete(login.id);
        for (const login of next.logins) if (login.twoStepKey) keys.set(login.id, login.twoStepKey);
        const keyRecord = [...keys].map(([id, key]) => ({ id, key }));
        const encryptedKeys = yield* vaultDecode(() =>
          this.#cipher.encrypt(JSON.stringify(keyRecord)).toString("base64"),
        );
        if (encryptedKeys.length + 32 > MAX_VAULT_ENVELOPE_BYTES) return yield* unreadable();
        yield* writeJsonFileAtomically(
          `${this.#path}.two-step`,
          { version: 1, record: encryptedKeys },
          { createDirectory: true },
        ).pipe(Effect.mapError(({ cause }) => new PasswordVaultError({ cause })));
        // The sidecar already committed. If the base write fails, a later unrelated save must not
        // replace its keys with the old in-memory keys. Keep the old base fields until they commit.
        this.#twoStepKeys = keys;
        this.#record = {
          ...this.#record,
          logins: this.#record.logins.map(({ twoStepKey: _key, ...login }) => {
            const key = keys.get(login.id);
            return key ? { ...login, twoStepKey: key } : login;
          }),
        };
        yield* writeJsonFileAtomically(this.#path, { version: 1, record: encrypted }, { createDirectory: true }).pipe(
          Effect.mapError(({ cause }) => new PasswordVaultError({ cause })),
        );
        this.#record = next;
        this.#twoStepKeys = keys;
        const ids = new Set(next.logins.map((login) => login.id));
        const keptKeys = [...keys].filter(([id]) => ids.has(id));
        if (keptKeys.length !== keys.size) {
          const keptRecord = keptKeys.map(([id, key]) => ({ id, key }));
          const protectedKeys = yield* vaultDecode(() =>
            this.#cipher.encrypt(JSON.stringify(keptRecord)).toString("base64"),
          );
          yield* writeJsonFileAtomically(
            `${this.#path}.two-step`,
            { version: 1, record: protectedKeys },
            { createDirectory: true },
          ).pipe(Effect.mapError(({ cause }) => new PasswordVaultError({ cause })));
          this.#twoStepKeys = new Map(keptKeys);
        }
        return next;
      }),
    );
  }

  /** Removes the file and forgets every item. */
  clear(): Effect.Effect<void, PasswordVaultError> {
    return this.#serialize(
      Effect.gen({ self: this }, function* () {
        yield* vaultCall(() => rm(`${this.#path}.two-step`, { force: true }));
        yield* vaultCall(() => rm(this.#path, { force: true }));
        this.#twoStepKeys = new Map();
        this.#twoStepUnreadable = false;
        this.#record = EMPTY_VAULT_RECORD;
      }),
    );
  }

  #serialize<A>(change: Effect.Effect<A, PasswordVaultError>): Effect.Effect<A, PasswordVaultError> {
    return this.#queue.withPermit(change).pipe(Effect.uninterruptible);
  }

  readonly #readTwoStepKeys = Effect.fn("VaultStore.readTwoStepKeys")(function* (
    this: VaultStore,
  ): Effect.fn.Return<typeof twoStepKeysSchema.Type, PasswordVaultError> {
    const source = yield* vaultCall(() => readFile(`${this.#path}.two-step`, "utf8")).pipe(
      Effect.catch(({ cause }) =>
        cause instanceof Error && "code" in cause && cause.code === "ENOENT"
          ? Effect.succeed(null)
          : Effect.fail(new PasswordVaultError({ cause })),
      ),
    );
    if (source === null) return [];
    if (source.length > MAX_VAULT_ENVELOPE_BYTES) return yield* unreadable();
    return yield* vaultDecode(() => {
      const envelope = Schema.decodeUnknownSync(envelopeSchema)(JSON.parse(source));
      return Schema.decodeUnknownSync(twoStepKeysSchema)(
        JSON.parse(this.#cipher.decrypt(Buffer.from(envelope.record, "base64"))),
      );
    }).pipe(Effect.mapError(unreadable));
  });

  readonly #read = Effect.fn("VaultStore.read")(function* (
    this: VaultStore,
  ): Effect.fn.Return<VaultRecord | null, PasswordVaultError> {
    const source = yield* vaultCall(() => readFile(this.#path, "utf8")).pipe(
      Effect.catch(({ cause }) =>
        cause instanceof Error && "code" in cause && cause.code === "ENOENT"
          ? Effect.succeed(null)
          : Effect.fail(new PasswordVaultError({ cause })),
      ),
    );
    if (source === null) return null;
    if (source.length > MAX_VAULT_ENVELOPE_BYTES) return yield* unreadable();
    return yield* vaultDecode(() => {
      const envelope = Schema.decodeUnknownSync(envelopeSchema)(JSON.parse(source));
      return Schema.decodeUnknownSync(recordSchema)(
        JSON.parse(this.#cipher.decrypt(Buffer.from(envelope.record, "base64"))),
      );
    }).pipe(Effect.mapError(unreadable));
  });
}
