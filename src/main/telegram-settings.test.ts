import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { readTelegramSettings } from "./telegram-settings";

it("accepts only a private regular manager credential and a bare HTTPS origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "tommy-telegram-settings-"));
  const file = join(root, "credential");
  const token = "123456:fixture_credential_for_example";
  const env = {
    TOMMY_TELEGRAM_OWNER_ID: "456",
    TOMMY_TELEGRAM_PUBLIC_URL: "https://example.com",
    TOMMY_TELEGRAM_MANAGER_TOKEN_FILE: file,
  };
  try {
    expect(await Effect.runPromise(readTelegramSettings({}))).toBeNull();
    await writeFile(file, token, { mode: 0o600 });
    expect(await Effect.runPromise(readTelegramSettings(env))).toMatchObject({ managerId: 123456, ownerId: 456 });
    await symlink(file, join(root, "link"));
    const invalid = [
      { ...env, TOMMY_TELEGRAM_MANAGER_TOKEN_FILE: join(root, "link") },
      { ...env, TOMMY_TELEGRAM_OWNER_ID: "123456" },
      { ...env, TOMMY_TELEGRAM_PUBLIC_URL: "https://example.com/?token=private" },
    ];
    for (const input of invalid) {
      const result = await Effect.runPromise(Effect.result(readTelegramSettings(input)));
      expect(result._tag).toBe("Failure");
      expect(JSON.stringify(result)).not.toContain(token);
    }
    await chmod(file, 0o644);
    await expect(Effect.runPromise(readTelegramSettings(env))).rejects.toMatchObject({ field: "credential" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
