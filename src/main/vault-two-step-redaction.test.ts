// @vitest-environment node
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactText } from "@tommy/logging";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { VaultService } from "./vault-service";
import { VaultStore } from "./vault-store";

const cipher = {
  encrypt: (value: string) => Buffer.from(value).reverse(),
  decrypt: (value: Buffer) => Buffer.from(value).reverse().toString(),
};
const setupKey = "JBSWY3DPEHPK3PXP";

describe("Vault authenticator secret boundary", () => {
  it("preserves the committed authenticator key when the base write fails before an unrelated save", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tommy-two-step-commit-"));
    try {
      const path = join(directory, "vault.json");
      const store = new VaultStore(path, cipher);
      const vault = new VaultService({ store, canPersist: () => true });
      await Effect.runPromise(vault.load());
      const state = await Effect.runPromise(
        vault.save({
          kind: "login",
          id: null,
          website: "https://example.com",
          username: "user",
          password: "example-password",
          notes: "",
          twoStepKey: setupKey,
        }),
      );
      const login = state.items[0];
      if (!login || login.kind !== "login") throw new Error("Expected a login.");
      const replacement = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
      // A directory at the base path makes only the second atomic rename fail.
      await rename(path, `${path}.previous`);
      await mkdir(path);
      await expect(
        Effect.runPromise(
          vault.save({
            kind: "login",
            id: login.id,
            website: "https://example.com",
            username: "user",
            password: null,
            notes: "",
            twoStepKey: replacement,
          }),
        ),
      ).rejects.toThrow();
      await rm(path, { recursive: true });
      await rename(`${path}.previous`, path);
      const diskKeys = JSON.parse(
        cipher.decrypt(Buffer.from(JSON.parse(await readFile(`${path}.two-step`, "utf8")).record, "base64")),
      );
      expect(diskKeys).toEqual([{ id: login.id, key: replacement }]);
      expect(store.read().logins[0]?.twoStepKey).toBe(replacement);
      await Effect.runPromise(
        vault.save({
          kind: "login",
          id: login.id,
          website: "https://example.com",
          username: "changed",
          password: null,
          notes: "",
        }),
      );
      const restarted = new VaultStore(path, cipher);
      expect(await Effect.runPromise(restarted.load())).toBe(true);
      expect(restarted.read().logins[0]?.twoStepKey).toBe(replacement);
      expect(restarted.read().logins[0]?.username).toBe("changed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps keys out of summaries, agents, reveal, logs and the older Vault record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tommy-two-step-"));
    try {
      const path = join(directory, "vault.json");
      const vault = new VaultService({ store: new VaultStore(path, cipher), canPersist: () => true });
      await Effect.runPromise(vault.load());
      const state = await Effect.runPromise(
        vault.save({
          kind: "login",
          id: null,
          website: "https://example.com",
          username: "user",
          password: "example-password",
          notes: "",
          twoStepKey: setupKey,
        }),
      );
      const login = state.items[0];
      if (!login || login.kind !== "login") throw new Error("Expected a login.");
      expect(login.hasTwoStep).toBe(true);
      expect(JSON.stringify(state)).not.toContain(setupKey);
      expect(JSON.stringify(vault.items.listForAgent())).not.toContain(setupKey);
      expect(JSON.stringify(await Effect.runPromise(vault.logins.loginsFor("https://example.com")))).not.toContain(
        setupKey,
      );
      expect(redactText(setupKey)).not.toContain(setupKey);
      expect(redactText(setupKey.toLowerCase())).not.toContain(setupKey.toLowerCase());
      const envelope = JSON.parse(await readFile(path, "utf8"));
      expect(cipher.decrypt(Buffer.from(envelope.record, "base64"))).not.toContain(setupKey);
      // A released client that omits the new field cannot clear it.
      await Effect.runPromise(
        vault.save({
          kind: "login",
          id: login.id,
          website: "https://example.com",
          username: "changed",
          password: null,
          notes: "",
        }),
      );
      expect((await Effect.runPromise(vault.codes())).codes[0]?.code).toMatch(/^\d{6}$/u);
      expect(await Effect.runPromise(vault.logins.secretFor(login.id, "https://other.example.org", "totp"))).toBeNull();
      // A corrupt sidecar is preserved. The items stay usable without their two-step keys.
      await writeFile(`${path}.two-step`, "unreadable");
      const reader = new VaultService({ store: new VaultStore(path, cipher), canPersist: () => true });
      await Effect.runPromise(reader.load());
      const readerState = reader.state();
      expect(readerState.status).toBe("ready");
      expect(readerState.items.filter((item) => item.kind === "login")).toHaveLength(1);
      expect(readerState.items.some((item) => item.kind === "login" && item.hasTwoStep)).toBe(false);
      // A save with no key writes the items only. A save that adds a key fails, so the file is not replaced.
      await Effect.runPromise(
        reader.save({
          kind: "login",
          id: login.id,
          website: "https://example.com",
          username: "kept",
          password: null,
          notes: "",
        }),
      );
      await expect(
        Effect.runPromise(
          reader.save({
            kind: "login",
            id: login.id,
            website: "https://example.com",
            username: "kept",
            password: null,
            notes: "",
            twoStepKey: setupKey,
          }),
        ),
      ).rejects.toThrow();
      expect(await readFile(`${path}.two-step`, "utf8")).toBe("unreadable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("removes orphaned setup keys only after a successful base write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tommy-two-step-orphan-"));
    try {
      const path = join(directory, "vault.json");
      const store = new VaultStore(path, cipher);
      const vault = new VaultService({ store, canPersist: () => true });
      await Effect.runPromise(vault.load());
      await Effect.runPromise(
        vault.save({
          kind: "login",
          id: null,
          website: "https://example.com",
          username: "user",
          password: "example-password",
          notes: "",
          twoStepKey: setupKey,
        }),
      );
      // An older build knows the base format and can remove a login without reading its sidecar.
      const withoutLogin = { ...store.read(), logins: [] };
      await writeFile(
        path,
        JSON.stringify({ version: 1, record: cipher.encrypt(JSON.stringify(withoutLogin)).toString("base64") }),
      );
      const reopened = new VaultStore(path, cipher);
      expect(await Effect.runPromise(reopened.load())).toBe(true);
      const before = JSON.parse(await readFile(`${path}.two-step`, "utf8"));
      expect(cipher.decrypt(Buffer.from(before.record, "base64"))).toContain(setupKey);
      await Effect.runPromise(reopened.update((record) => ({ ...record })));
      const after = JSON.parse(await readFile(`${path}.two-step`, "utf8"));
      expect(JSON.parse(cipher.decrypt(Buffer.from(after.record, "base64")))).toEqual([]);
      expect(reopened.read().logins).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
