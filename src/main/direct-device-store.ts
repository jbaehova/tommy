import { createPublicKey, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { DIRECT_PAIRING_ALPHABET, DIRECT_PAIRING_CODE_LENGTH } from "@tommy/contracts/direct-connection";
import { Effect, Result, Schema, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

/** A code works for this long, once. */
const PAIRING_CODE_LIFETIME_MS = 5 * 60_000;
/** After this many wrong codes, the code stops working and the owner makes a new one. */
const MAXIMUM_PAIRING_FAILURES = 5;

const StoredDevice = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  publicKey: Schema.String,
  pairedAt: Schema.String,
});
export type DirectDevice = typeof StoredDevice.Type;

const StoredDevices = Schema.Struct({ version: Schema.Literal(1), devices: Schema.Array(StoredDevice) });
const decodeStoredDevices = Schema.decodeUnknownSync(StoredDevices);

export type DirectPairingFailure = "invalid_code" | "invalid_key";

/**
 * The devices that can connect to this host. A device proves that it holds its private key at each
 * connection. The file holds only public keys. A pairing code stays in memory and never reaches a log.
 */
export class DirectDeviceStore {
  readonly #path: string;
  readonly #now: () => number;
  readonly #writes = Semaphore.makeUnsafe(1);
  #devices: DirectDevice[] = [];
  #pairing: { code: string; expiresAt: number; failures: number } | null = null;

  constructor(options: { path: string; now?: () => number }) {
    this.#path = options.path;
    this.#now = options.now ?? Date.now;
  }

  readonly load = Effect.fn("DirectDeviceStore.load")(function* (this: DirectDeviceStore) {
    const loaded = yield* Effect.result(readPreferenceFile(this.#path, decodeStoredDevices));
    if (Result.isSuccess(loaded)) this.#devices = [...loaded.success.devices];
    else if (!isMissingFileError(loaded.failure.cause)) return yield* loaded.failure;
  });

  list(): readonly DirectDevice[] {
    return this.#devices;
  }

  get(deviceId: string): DirectDevice | null {
    return this.#devices.find((device) => device.id === deviceId) ?? null;
  }

  /** Makes the one active code. An earlier code stops working. */
  createPairingCode(): { code: string; expiresAt: number } {
    let code = "";
    for (let index = 0; index < DIRECT_PAIRING_CODE_LENGTH; index += 1) {
      code += DIRECT_PAIRING_ALPHABET.charAt(randomInt(DIRECT_PAIRING_ALPHABET.length));
    }
    const expiresAt = this.#now() + PAIRING_CODE_LIFETIME_MS;
    this.#pairing = { code, expiresAt, failures: 0 };
    return { code, expiresAt };
  }

  /** Spends the code and saves the device. A wrong code counts toward the limit. */
  readonly redeem = Effect.fn("DirectDeviceStore.redeem")(function* (
    this: DirectDeviceStore,
    input: { code: string; publicKey: string; name: string },
  ): Effect.fn.Return<DirectDevice | DirectPairingFailure, PreferenceFileFailure> {
    if (!this.#acceptsCode(input.code)) return "invalid_code";
    // The code is spent also when the key is bad: the caller holds a code that it may have read.
    this.#pairing = null;
    if (!isEd25519PublicKey(input.publicKey)) return "invalid_key";
    const device: DirectDevice = {
      id: randomUUID(),
      name: input.name.trim().slice(0, 128) || "Device",
      publicKey: input.publicKey,
      pairedAt: new Date(this.#now()).toISOString(),
    };
    yield* this.#save([...this.#devices, device]);
    return device;
  });

  readonly revoke = Effect.fn("DirectDeviceStore.revoke")(function* (this: DirectDeviceStore, deviceId: string) {
    if (!this.get(deviceId)) return false;
    yield* this.#save(this.#devices.filter((device) => device.id !== deviceId));
    return true;
  });

  #acceptsCode(code: string): boolean {
    const pairing = this.#pairing;
    if (!pairing) return false;
    if (this.#now() >= pairing.expiresAt) {
      this.#pairing = null;
      return false;
    }
    if (constantTimeEqual(code.trim().toUpperCase(), pairing.code)) return true;
    pairing.failures += 1;
    if (pairing.failures >= MAXIMUM_PAIRING_FAILURES) this.#pairing = null;
    return false;
  }

  #save(devices: DirectDevice[]): Effect.Effect<void, PreferenceFileFailure> {
    return this.#writes.withPermit(
      Effect.uninterruptible(
        writePreferenceFile(this.#path, { version: 1, devices }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              this.#devices = devices;
            }),
          ),
        ),
      ),
    );
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function isEd25519PublicKey(value: string): boolean {
  try {
    return createPublicKey(value).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}
