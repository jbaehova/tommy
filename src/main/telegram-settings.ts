import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { registerSecretValue } from "@tommy/logging";
import { Effect, Schema } from "effect";

export interface TelegramSettings {
  token: string;
  managerId: number;
  ownerId: number;
  publicOrigin: string;
}

/** Safe to report. File paths, file contents and native errors stay private. */
export class TelegramSettingsError extends Schema.TaggedError<TelegramSettingsError>()("TelegramSettingsError", {
  field: Schema.Literals(["owner", "origin", "credential"]),
}) {}

export const readTelegramSettings = Effect.fn("TelegramSettings.read")(function* (env: NodeJS.ProcessEnv) {
  const file = env.TOMMY_TELEGRAM_MANAGER_TOKEN_FILE;
  const owner = env.TOMMY_TELEGRAM_OWNER_ID;
  const origin = env.TOMMY_TELEGRAM_PUBLIC_URL;
  if (!file && !owner && !origin) return null;
  if (!owner || !/^[1-9][0-9]{0,15}$/.test(owner) || Number(owner) >= 2 ** 52) {
    return yield* Effect.fail(new TelegramSettingsError({ field: "owner" }));
  }
  const url = URL.parse(origin ?? "");
  if (url?.protocol !== "https:" || url.username || url.password || url.href !== `${url.origin}/`) {
    return yield* Effect.fail(new TelegramSettingsError({ field: "origin" }));
  }
  if (!file || !isAbsolute(file)) return yield* Effect.fail(new TelegramSettingsError({ field: "credential" }));
  const token = yield* Effect.tryPromise({
    try: async () => {
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 512) {
          throw new Error("credential");
        }
        const value = (await handle.readFile("utf8")).trim();
        if (!/^[1-9][0-9]{0,15}:[A-Za-z0-9_-]{16,256}$/.test(value)) throw new Error("credential");
        return value;
      } finally {
        await handle.close();
      }
    },
    catch: () => new TelegramSettingsError({ field: "credential" }),
  });
  registerSecretValue(token);
  const managerId = Number(token.split(":")[0]);
  if (managerId >= 2 ** 52 || managerId === Number(owner)) {
    return yield* Effect.fail(new TelegramSettingsError({ field: "credential" }));
  }
  return { token, managerId, ownerId: Number(owner), publicOrigin: url.origin } satisfies TelegramSettings;
});
