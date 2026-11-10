// Optional live-voice-v1. Each caller may start one realtime voice call on a Codex agent's
// existing host-owned thread. The caller must have chat access. It sends only an audio SDP offer
// and an optional voice. The host keeps Codex credentials and returns the SDP answer. Audio goes
// directly between the client and OpenAI. The account must have a ChatGPT sign-in and access to
// realtime v3; no price or account entitlement is implied by this capability.
//
// One call may use a provider thread. A new start replaces an earlier call of its owner.
// A thread in a call of another owner returns a busy error; it cannot be taken over by starting.
// Events are sent only to the initiating logical session. Stop and disconnect use the authenticated
// owner, never a client-supplied owner ID. A stale or foreign stop changes nothing. Host account,
// provider and agent changes end the call. Existing STT/TTS routes keep their meaning.
//
// Bounds and voice names below are fixed for this optional contract. Future incompatible behavior
// needs a new capability string.
import { isDynamicRecord, isOneOf, isString } from "../runtime-values";
import { type AdminDecoder, adminRoute, empty, fields, identifier, type OptionalRouteCodec, oneOf } from "./admin-wire";

export const LIVE_VOICE_CAPABILITY = "live-voice-v1";

export const LIVE_VOICE_ROUTES = {
  start: "/v1/live-voice/start",
  stop: "/v1/live-voice/stop",
  cancel: "/v1/live-voice/cancel",
} as const;

export const LIVE_VOICE_EVENT = "live-voice";

export const LIVE_VOICE_SDP_LIMIT = 65_536;
export const LIVE_VOICE_TRANSCRIPT_LIMIT = 100_000;
export const LIVE_VOICE_REASON_LIMIT = 4_000;

/** The voices of this contract. A later Codex voice needs a second capability string. */
const LIVE_VOICE_NAMES = [
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

export type LiveVoiceName = (typeof LIVE_VOICE_NAMES)[number];

export function isLiveVoiceName(value: unknown): value is LiveVoiceName {
  return isOneOf(LIVE_VOICE_NAMES, value);
}

const sdp: AdminDecoder = (value) => {
  if (!isText(value, LIVE_VOICE_SDP_LIMIT) || !value.trim()) throw new Error("Invalid live voice SDP.");
  return value;
};

export const LIVE_VOICE_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    LIVE_VOICE_ROUTES.start,
    adminRoute(
      fields({ agentId: identifier, sdp }, { voice: oneOf(...LIVE_VOICE_NAMES), requestId: identifier }),
      fields({ sessionId: identifier, sdp }),
    ),
  ],
  [LIVE_VOICE_ROUTES.stop, adminRoute(fields({ sessionId: identifier }), empty)],
  [LIVE_VOICE_ROUTES.cancel, adminRoute(fields({ requestId: identifier }), empty)],
]);

export interface LiveVoiceStartRequest {
  agentId: string;
  sdp: string;
  voice?: LiveVoiceName;
  requestId?: string;
}

export interface LiveVoiceSessionResponse {
  sessionId: string;
  sdp: string;
}

/** The request the host reads. The transport has already run it through the codec above. */
export function decodeLiveVoiceStartRequest(value: unknown): LiveVoiceStartRequest {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.agentId) ||
    !isText(value.sdp, LIVE_VOICE_SDP_LIMIT) ||
    !value.sdp.trim()
  )
    throw new Error("Invalid live voice start.");
  if (value.voice !== undefined && !isLiveVoiceName(value.voice)) throw new Error("Invalid live voice start.");
  if (value.requestId !== undefined && !isIdentifier(value.requestId)) throw new Error("Invalid live voice start.");
  return {
    agentId: value.agentId,
    sdp: value.sdp,
    ...(value.voice ? { voice: value.voice } : {}),
    ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
  };
}

export function decodeLiveVoiceStopRequest(value: unknown): string {
  if (!isDynamicRecord(value) || !isIdentifier(value.sessionId)) throw new Error("Invalid live voice stop.");
  return value.sessionId;
}

/** Cancel only the matching pending start or call of the authenticated owner. */
export function decodeLiveVoiceCancelRequest(value: unknown): string {
  if (!isDynamicRecord(value) || !isIdentifier(value.requestId)) throw new Error("Invalid live voice cancellation.");
  return value.requestId;
}

/** The answer of the host, as the client type. */
export function decodeLiveVoiceSessionResponse(value: unknown): LiveVoiceSessionResponse {
  if (
    !isDynamicRecord(value) ||
    !isIdentifier(value.sessionId) ||
    !isText(value.sdp, LIVE_VOICE_SDP_LIMIT) ||
    !value.sdp.trim()
  )
    throw new Error("Invalid live voice session.");
  return { sessionId: value.sessionId, sdp: value.sdp };
}

export type LiveVoiceEvent =
  | {
      type: typeof LIVE_VOICE_EVENT;
      kind: "transcript";
      sessionId: string;
      role: "user" | "assistant";
      text: string;
      final: boolean;
    }
  | { type: typeof LIVE_VOICE_EVENT; kind: "ended"; sessionId: string; error: string | null };

/** Null for any other event. A malformed live voice event throws, so the stream fails closed. */
export function liveVoiceEvent(value: unknown): LiveVoiceEvent | null {
  if (!isDynamicRecord(value) || value.type !== LIVE_VOICE_EVENT) return null;
  const { kind, sessionId } = value;
  if (!isIdentifier(sessionId)) throw new Error("Invalid live voice event.");
  if (kind === "transcript") {
    const { role, text, final } = value;
    if (
      (role !== "user" && role !== "assistant") ||
      !isText(text, LIVE_VOICE_TRANSCRIPT_LIMIT) ||
      typeof final !== "boolean"
    )
      throw new Error("Invalid live voice event.");
    return { type: LIVE_VOICE_EVENT, kind, sessionId, role, text, final };
  }
  if (kind === "ended") {
    const { error } = value;
    if (error !== null && !isText(error, LIVE_VOICE_REASON_LIMIT)) throw new Error("Invalid live voice event.");
    return { type: LIVE_VOICE_EVENT, kind, sessionId, error };
  }
  throw new Error("Invalid live voice event.");
}

function isIdentifier(value: unknown): value is string {
  return isString(value) && value.length > 0 && value.length <= 128;
}

function isText(value: unknown, maximum: number): value is string {
  return isString(value) && value.length <= maximum;
}
