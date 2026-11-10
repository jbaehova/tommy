// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSecretStorage, type PlatformSecretStorage } from "./secret-storage-cipher";

const unavailable: PlatformSecretStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error("Unavailable");
  },
  decryptString: () => {
    throw new Error("Unreadable");
  },
  getSelectedStorageBackend: () => "gnome_libsecret",
};

describe("Optional key file secret protection", () => {
  it("requires explicit fallback policy and persists authenticated ciphertext with a private key", () => {
    const directory = mkdtempSync(join(tmpdir(), "tommy-key-file-"));
    try {
      const keyPath = join(directory, "secret-storage.key");
      const options = { keyPath, platform: "linux" as const, isReady: () => true, storage: unavailable };
      expect(
        createSecretStorage(options)
          .cipher(() => "Unavailable")
          .canPersist(),
      ).toBe(false);
      expect(existsSync(keyPath)).toBe(false);
      const first = createSecretStorage({ ...options, allowKeyFileFallback: true }).cipher(() => "Unavailable");
      const encrypted = first.encrypt("private-example-secret");
      expect(encrypted.toString()).not.toContain("private-example-secret");
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
      const key = readFileSync(keyPath);
      const second = createSecretStorage({ ...options, allowKeyFileFallback: true }).cipher(() => "Unavailable");
      expect(second.decrypt(encrypted)).toBe("private-example-secret");
      expect(readFileSync(keyPath).equals(key)).toBe(true);
      encrypted[encrypted.length - 1] = (encrypted.at(-1) ?? 0) ^ 1;
      expect(() => second.decrypt(encrypted)).toThrow();
      // Turning the policy off does not make existing encrypted secrets unreadable.
      const original = first.encrypt("retained-secret");
      expect(
        createSecretStorage(options)
          .cipher(() => "Unavailable")
          .decrypt(original),
      ).toBe("retained-secret");
      // A missing key never becomes a newly generated replacement during decryption.
      rmSync(keyPath);
      expect(() => second.decrypt(original)).toThrow();
      expect(existsSync(keyPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("keeps a working keyring after corrupt ciphertext instead of activating file protection", () => {
    const directory = mkdtempSync(join(tmpdir(), "tommy-keyring-corruption-"));
    try {
      const keyPath = join(directory, "secret-storage.key");
      const storage: PlatformSecretStorage = {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`keyring:${value}`),
        decryptString: () => {
          throw new Error("Damaged ciphertext");
        },
        getSelectedStorageBackend: () => "gnome_libsecret",
      };
      const protectedStore = createSecretStorage({
        keyPath,
        platform: "linux",
        isReady: () => true,
        storage,
        allowKeyFileFallback: true,
      });
      const cipher = protectedStore.cipher(() => "Unavailable");
      expect(() => cipher.decrypt(Buffer.from("damaged"))).toThrow("Damaged ciphertext");
      expect(existsSync(keyPath)).toBe(false);
      expect(cipher.encrypt("example-secret").toString()).toBe("keyring:example-secret");
      expect(protectedStore.madeKeyFile()).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
