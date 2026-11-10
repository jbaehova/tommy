import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Equal-length hashes hide secret length and keep comparisons constant-time. */
export function equalWebhookSecret(expected: string, supplied: string): boolean {
  if (supplied.length < 1 || supplied.length > 4_096) return false;
  return timingSafeEqual(
    createHash("sha256").update(expected).digest(),
    createHash("sha256").update(supplied).digest(),
  );
}

export function verifyGitHubWebhook(secret: string, body: Uint8Array, signature: string): boolean {
  if (!/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

/** Slack v0 authenticates its timestamp and the exact raw bytes. */
export function verifySlackWebhook(
  secret: string,
  body: Uint8Array,
  timestamp: string,
  signature: string,
  nowMs = Date.now(),
): boolean {
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(Number(timestamp) * 1_000 - nowMs) > 300_000) return false;
  if (!/^v0=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(`v0:${timestamp}:`).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(3), "hex"));
}
