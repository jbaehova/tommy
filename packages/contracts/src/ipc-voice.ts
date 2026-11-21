import { isBoundedString } from "./ipc-bounded-values";
import { isBoolean, isDynamicRecord, isOneOf } from "./runtime-values";

/** Realtime v3 voices accepted by the host's signed-in Codex App Server. */
export const CODEX_LIVE_VOICES = [
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "cove",
  "aube",
  "bubbie",
  "haetsal",
  "hanul",
  "himari",
  "leher",
  "miko",
  "neer",
  "porto",
  "rindo",
  "rio",
  "rivage",
  "selva",
  "sonna",
  "tinta",
  "viola",
] as const;
export type CodexLiveVoice = (typeof CODEX_LIVE_VOICES)[number];

export const VOICE_LIVE_LIMITS = {
  maximumSdpLength: 65_536,
  maximumTranscriptLength: 100_000,
  maximumReasonLength: 4_000,
} as const;

/** Audio goes directly to OpenAI. Codex authentication stays on the host. */
export interface VoiceLiveStart {
  agentId: string;
  sdp: string;
  voice?: CodexLiveVoice;
  /** A per-attempt nonce, so Stop can cancel before an SDP answer exists. */
  requestId?: string;
}
export interface VoiceLiveStop {
  sessionId: string;
}
export interface VoiceLiveCancel {
  requestId: string;
}
export interface VoiceLiveSession {
  sessionId: string;
  sdp: string;
}
export type VoiceLiveEvent =
  | { type: "transcript"; sessionId: string; role: "user" | "assistant"; text: string; final: boolean }
  | { type: "ended"; sessionId: string; error: string | null };

export function isCodexLiveVoice(value: unknown): value is CodexLiveVoice {
  return isOneOf(CODEX_LIVE_VOICES, value);
}

function liveIdentifier(value: unknown): value is string {
  return isBoundedString(value, 128) && value.length > 0;
}

export function decodeVoiceLiveStart(value: unknown): VoiceLiveStart {
  if (
    !isDynamicRecord(value) ||
    !liveIdentifier(value.agentId) ||
    !isBoundedString(value.sdp, VOICE_LIVE_LIMITS.maximumSdpLength) ||
    !value.sdp.trim() ||
    (value.voice !== undefined && !isCodexLiveVoice(value.voice)) ||
    (value.requestId !== undefined && !liveIdentifier(value.requestId))
  )
    throw new Error("Invalid live voice start.");
  return {
    agentId: value.agentId,
    sdp: value.sdp,
    ...(value.voice === undefined ? {} : { voice: value.voice }),
    ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
  };
}

export function decodeVoiceLiveStop(value: unknown): VoiceLiveStop {
  if (!isDynamicRecord(value) || !liveIdentifier(value.sessionId)) throw new Error("Invalid live voice stop.");
  return { sessionId: value.sessionId };
}

export function decodeVoiceLiveCancel(value: unknown): VoiceLiveCancel {
  if (!isDynamicRecord(value) || !liveIdentifier(value.requestId)) throw new Error("Invalid live voice cancellation.");
  return { requestId: value.requestId };
}

export function decodeVoiceLiveSession(value: unknown): VoiceLiveSession {
  if (
    !isDynamicRecord(value) ||
    !liveIdentifier(value.sessionId) ||
    !isBoundedString(value.sdp, VOICE_LIVE_LIMITS.maximumSdpLength) ||
    !value.sdp.trim()
  )
    throw new Error("Invalid live voice session.");
  return { sessionId: value.sessionId, sdp: value.sdp };
}

export function decodeVoiceLiveEvent(value: unknown): VoiceLiveEvent {
  if (!isDynamicRecord(value) || !liveIdentifier(value.sessionId)) throw new Error("Invalid live voice event.");
  if (
    value.type === "transcript" &&
    (value.role === "user" || value.role === "assistant") &&
    isBoundedString(value.text, VOICE_LIVE_LIMITS.maximumTranscriptLength) &&
    isBoolean(value.final)
  )
    return { type: "transcript", sessionId: value.sessionId, role: value.role, text: value.text, final: value.final };
  if (
    value.type === "ended" &&
    (value.error === null || isBoundedString(value.error, VOICE_LIVE_LIMITS.maximumReasonLength))
  )
    return { type: "ended", sessionId: value.sessionId, error: value.error };
  throw new Error("Invalid live voice event.");
}
