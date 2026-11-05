// What failed, as a fixed code. A failed turn can move to a backup model when the code allows it.

import { Schema } from "effect";
import { type DynamicRecord, isDynamicRecord } from "./runtime-values";

export const CauseCode = Schema.Literals([
  "invalid_upload_request",
  "authentication",
  "permission",
  "rate_limit",
  "usage_limit",
  "billing",
  "network",
  "timeout",
  "storage",
  "not_found",
  "conflict",
  "provider_unavailable",
  "attachment_type_unsupported",
  "attachment_too_large",
  "attachment_upload_failed",
  "cancelled",
  "unknown",
]);
export type CauseCode = typeof CauseCode.Type;
export const isCauseCode = Schema.is(CauseCode);

const STRUCTURED_CAUSES: Readonly<Record<string, CauseCode>> = {
  invalid_upload_request: "invalid_upload_request",
  usageLimitExceeded: "usage_limit",
  contextWindowExceeded: "unknown",
  unauthorized: "authentication",
  authentication_error: "authentication",
  rate_limit_exceeded: "rate_limit",
  rate_limit_error: "rate_limit",
  rateLimitExceeded: "rate_limit",
  serverOverloaded: "provider_unavailable",
  internalServerError: "provider_unavailable",
  flexUnavailable: "provider_unavailable",
  insufficient_quota: "billing",
  ECONNREFUSED: "network",
  ECONNRESET: "network",
  ENOTFOUND: "network",
  ETIMEDOUT: "timeout",
  ENOSPC: "storage",
  EACCES: "permission",
  ABORT_ERR: "cancelled",
};

/** Inspect locally. The result is always a fixed code, never part of the input. */
export function classifyFailure(error: unknown): CauseCode {
  const record = isDynamicRecord(error) ? error : undefined;
  for (const key of [record?.codexErrorInfo, record?.code]) {
    if (isCauseCode(key)) return key;
    if (typeof key === "string" && Object.hasOwn(STRUCTURED_CAUSES, key)) return STRUCTURED_CAUSES[key] ?? "unknown";
    if (isDynamicRecord(key)) {
      const cause = codexFailureCause(key);
      if (cause) return cause;
    }
  }
  if (isDynamicRecord(record?.error)) {
    const nested = classifyFailure(record.error);
    if (nested !== "unknown") return nested;
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : record?.message;
  if (typeof message !== "string") return "unknown";
  if (/\binvalid upload request\b/iu.test(message)) return "invalid_upload_request";
  if (
    /\b(?:401 unauthorized|invalid_api_key|not authenticated|authentication failed|authentication_error)\b/iu.test(
      message,
    )
  )
    return "authentication";
  if (/\b(?:rate[ _-]?limit(?:_error|_exceeded)?|too many requests)\b/iu.test(message)) return "rate_limit";
  if (/\b(?:insufficient (?:funds|balance|quota)|payment required|credits? exhausted)\b/iu.test(message))
    return "billing";
  if (/\b(?:usage limit|hit your (?:weekly |session )?limit)\b/iu.test(message)) return "usage_limit";
  if (/\b(?:timed? out|ETIMEDOUT|gateway time-?out|deadline exceeded|DEADLINE_EXCEEDED)\b/iu.test(message))
    return "timeout";
  if (
    /\b(?:fetch failed|failed to fetch|network request failed|connection error|socket hang up|stream disconnected|error sending request|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN)\b/iu.test(
      message,
    )
  )
    return "network";
  if (/\b(?:ENOSPC|SQLITE_FULL|disk full)\b/iu.test(message)) return "storage";
  if (/\b(?:EACCES|permission denied|403 forbidden)\b/iu.test(message)) return "permission";
  // An outage: Claude's "API Error: 529 … overloaded_error", OpenAI's "server_error", Google's
  // UNAVAILABLE status in capitals, or a 5xx status that the text names as a status.
  if (
    /\b(?:service unavailable|bad gateway|internal server error|overloaded(?:_error)?|server_error|api_error|server had an error|high demand|temporarily unavailable|upstream connect error)\b/iu.test(
      message,
    ) ||
    /\bUNAVAILABLE\b/u.test(message) ||
    /\b(?:API Error|status(?: code)?|HTTP(?:\/[\d.]+)?)\W{0,4}5\d\d\b/iu.test(message)
  )
    return "provider_unavailable";
  return "unknown";
}

/**
 * Codex names a failed connection, a broken stream or a spent retry budget as an object, with the last
 * HTTP status when the provider answered. No status means that the provider did not answer. Any other
 * 4xx is a request that each model can refuse, so the message decides.
 */
function codexFailureCause(info: DynamicRecord): CauseCode | null {
  const failure = [
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "responseStreamDisconnected",
    "responseTooManyFailedAttempts",
  ]
    .map((key) => info[key])
    .find(isDynamicRecord);
  if (!failure) return null;
  const status = failure.httpStatusCode;
  if (typeof status !== "number") return "network";
  if (status === 429) return "rate_limit";
  if (status === 401) return "authentication";
  if (status === 408) return "timeout";
  return status >= 500 ? "provider_unavailable" : null;
}
