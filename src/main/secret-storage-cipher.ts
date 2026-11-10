// Linux: a keyring that is locked at start, that is not running yet, or that keeps its items only in
// memory gives `safeStorage` another key after a restart, or no key. Every secret that Tommy
// stored is then lost, the account session too, so the user must sign in after each restart.
// With explicit fallback policy, after a failure Tommy encrypts new secrets with its own key in a
// 0600 file in userData. That is file-permission protection, as on a self-hosted server. A keyring
// that works keeps the secrets. macOS and Windows always use `safeStorage`.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { createTommyLogger } from "@tommy/logging";
import { isMissingFileError } from "../backend/file-errors";
export interface PlatformSecretStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend(): string;
}

export const SECRET_STORAGE_KEY_FILE = "secret-storage.key";

/** The first bytes of a value that the key file encrypts. `safeStorage` values start with `v10` or `v11`. */
const KEY_FILE_FORMAT = Buffer.from("tmk1", "ascii");
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const logger = createTommyLogger("secret-storage");

export interface SecretStorageCipher {
  canPersist: () => boolean;
  encrypt: (value: string) => Buffer;
  decrypt: (value: Buffer) => string;
}

export interface SecretStorage {
  /** A cipher that throws `unavailableMessage()` when nothing can encrypt. */
  cipher: (unavailableMessage: () => string) => SecretStorageCipher;
  /** True when the keyring failed in this process and Tommy made the key file for it. */
  madeKeyFile: () => boolean;
}

function isExistingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/**
 * One instance for each userData folder, so that every store sees the change to the key file at
 * the same time.
 */
export function createSecretStorage(options: {
  keyPath: string;
  platform?: NodeJS.Platform;
  allowKeyFileFallback?: boolean;
  isReady: () => boolean;
  storage: PlatformSecretStorage;
}): SecretStorage {
  const safeStorage = options.storage;
  const enabled = options.allowKeyFileFallback === true;
  const linux = (options.platform ?? process.platform) === "linux";
  let madeKeyFile = false;

  /**
   * The key file, or null when there is none and the keyring keeps the secrets. Not kept in memory:
   * a user who deletes the file goes back to the keyring, and no new secret uses the deleted key.
   */
  function readKey(): Buffer | null {
    let text: string;
    try {
      text = readFileSync(options.keyPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
    const value = Buffer.from(text.trim(), "base64");
    if (value.length !== KEY_BYTES) throw new Error("The secret storage key file is not valid.");
    return value;
  }

  /** Makes the key file. A file that another process made first wins, so no key replaces another. */
  function createKey(reason: "unavailable"): Buffer {
    const existing = readKey();
    if (existing) return existing;
    const folder = dirname(options.keyPath);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const temporaryPath = `${options.keyPath}.${randomUUID()}.tmp`;
    try {
      // The key is on disk before the link: after a power loss, an empty key file would stop all secrets.
      const file = openSync(temporaryPath, "wx", 0o600);
      try {
        writeSync(file, `${randomBytes(KEY_BYTES).toString("base64")}\n`);
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      chmodSync(temporaryPath, 0o600);
      try {
        linkSync(temporaryPath, options.keyPath);
      } catch (error) {
        if (!isExistingFile(error)) throw error;
      }
    } finally {
      rmSync(temporaryPath, { force: true });
    }
    const folderHandle = openSync(folder, "r");
    try {
      fsyncSync(folderHandle);
    } finally {
      closeSync(folderHandle);
    }
    const created = readKey();
    if (!created) throw new Error("The secret storage key file was not made.");
    madeKeyFile = true;
    // The backend name only: it tells a locked keyring from a missing one in a report.
    logger.warn("The system keyring did not keep the secrets. Tommy keeps new secrets in its own key file.", {
      reason,
      backend: safeStorage.getSelectedStorageBackend(),
    });
    return created;
  }

  /** The key file on Linux when the keyring cannot encrypt. Null when the keyring keeps the secrets. */
  function keyForWrite(): Buffer | null {
    if (!linux || !enabled) return null;
    const existing = readKey();
    if (existing) return existing;
    // Before `ready`, `safeStorage` has no key on Linux even when the keyring works.
    if (!options.isReady() || safeStorage.isEncryptionAvailable()) return null;
    return createKey("unavailable");
  }

  const canPersist = () => {
    try {
      return keyForWrite() !== null || safeStorage.isEncryptionAvailable();
    } catch (error) {
      logger.warn("The secret storage key file could not be used.", {
        error: error instanceof Error ? error.name : typeof error,
      });
      return false;
    }
  };

  const encrypt = (value: string, unavailableMessage: () => string): Buffer => {
    let fileKey: Buffer | null;
    try {
      fileKey = keyForWrite();
    } catch (error) {
      logger.warn("The secret storage key file could not be used.", {
        error: error instanceof Error ? error.name : typeof error,
      });
      throw new Error(unavailableMessage());
    }
    if (!fileKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error(unavailableMessage());
      try {
        return safeStorage.encryptString(value);
      } catch {
        if (!enabled || !linux || !options.isReady()) throw new Error(unavailableMessage());
        fileKey = createKey("unavailable");
      }
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", fileKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([KEY_FILE_FORMAT, iv, cipher.getAuthTag(), encrypted]);
  };

  const decrypt = (value: Buffer): string => {
    if (value.subarray(0, KEY_FILE_FORMAT.length).equals(KEY_FILE_FORMAT)) {
      const fileKey = readKey();
      if (!fileKey) throw new Error("The secret storage key file is missing.");
      const body = value.subarray(KEY_FILE_FORMAT.length);
      if (body.length < IV_BYTES + TAG_BYTES) throw new Error("The encrypted secret is not valid.");
      const decipher = createDecipheriv("aes-256-gcm", fileKey, body.subarray(0, IV_BYTES));
      decipher.setAuthTag(body.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([decipher.update(body.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
    }
    // Corrupt ciphertext does not prove a working keyring failed. Reads never create or replace
    // a key; an unavailable or failed encryption activates the opt-in write fallback.
    return safeStorage.decryptString(value);
  };

  return {
    cipher: (unavailableMessage) => ({
      canPersist,
      encrypt: (value) => encrypt(value, unavailableMessage),
      decrypt,
    }),
    madeKeyFile: () => madeKeyFile,
  };
}
