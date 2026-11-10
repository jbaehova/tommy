import type { ScopedVoiceLiveEvent, VoiceLiveEvent, VoiceLiveSession } from "@tommy/contracts/ipc";
import { VOICE_LIVE_LIMITS } from "@tommy/contracts/ipc";
import { decodeRecord, requiredString } from "@tommy/contracts/ipc-decoding";
import { isString } from "@tommy/contracts/runtime-values";

export function decodeVoiceLiveSessionFromMain(value: unknown): VoiceLiveSession {
  const session = decodeRecord(value, "live voice session from main");
  const sessionId = requiredString(session, "sessionId");
  const sdp = requiredString(session, "sdp");
  if (!sessionId || sessionId.length > 128 || !sdp.trim() || sdp.length > VOICE_LIVE_LIMITS.maximumSdpLength)
    throw new Error("Invalid live voice session from main.");
  return { sessionId, sdp };
}

function liveEvent(value: unknown): VoiceLiveEvent {
  const event = decodeRecord(value, "live voice event from main");
  const sessionId = requiredString(event, "sessionId");
  if (!sessionId || sessionId.length > 128) throw new Error("Invalid live voice event from main.");
  if (
    event.type === "transcript" &&
    (event.role === "user" || event.role === "assistant") &&
    isString(event.text) &&
    event.text.length <= VOICE_LIVE_LIMITS.maximumTranscriptLength &&
    typeof event.final === "boolean"
  )
    return { type: event.type, sessionId, role: event.role, text: event.text, final: event.final };
  if (
    event.type === "ended" &&
    (event.error === null || (isString(event.error) && event.error.length <= VOICE_LIVE_LIMITS.maximumReasonLength))
  )
    return { type: event.type, sessionId, error: event.error };
  throw new Error("Invalid live voice event from main.");
}

export function decodeScopedVoiceLiveEventFromMain(value: unknown): ScopedVoiceLiveEvent {
  const scoped = decodeRecord(value, "scoped live voice event from main");
  const serverId = requiredString(scoped, "serverId");
  if (!serverId || serverId.length > 128) throw new Error("Invalid scoped live voice event from main.");
  return { serverId, event: liveEvent(scoped.event) };
}
