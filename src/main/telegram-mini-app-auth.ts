import { createHmac, timingSafeEqual } from "node:crypto";
import { Option, Schema } from "effect";

const sessionSeconds = 300;
const ownerFromJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ id: Schema.Number })));

/** Telegram signs the decoded fields, sorted by key, with a key derived from the manager token. */
export function telegramMiniAppOwner(
  authorization: string | undefined,
  managerToken: string,
  ownerId: number,
  nowSeconds: number,
): boolean {
  if (!authorization?.startsWith("tma ") || authorization.length > 8192) return false;
  const fields = new URLSearchParams(authorization.slice(4));
  const hash = fields.get("hash");
  if (!hash || !/^[a-f\d]{64}$/.test(hash)) return false;
  if (new Set(fields.keys()).size !== fields.size) return false;

  for (const [key, value] of fields) {
    if (!/^[a-z][a-z0-9_]*$/.test(key) || /[\r\n]/.test(value)) return false;
  }
  fields.delete("hash");
  fields.sort();
  const signed = Array.from(fields, ([key, value]) => `${key}=${value}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(managerToken).digest();
  const expected = createHmac("sha256", key).update(signed).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) return false;

  const timestamp = fields.get("auth_date") ?? "";
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const age = nowSeconds - Number(timestamp);
  if (age < 0 || age > sessionSeconds) return false;
  const user = ownerFromJson(fields.get("user"));
  return Option.isSome(user) && Number.isSafeInteger(ownerId) && ownerId > 0 && user.value.id === ownerId;
}
