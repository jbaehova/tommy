import {
  decodeVoiceLiveCancel,
  decodeVoiceLiveStart,
  decodeVoiceLiveStop,
  LOCAL_SERVER_ID,
  type VoiceLiveEvent,
  type VoiceLiveSession,
  type VoiceLiveStart,
} from "@tommy/contracts/ipc";
import { LIVE_VOICE_CAPABILITY, LIVE_VOICE_ROUTES } from "@tommy/contracts/team-protocol/live-voice-v1";
import { sourceText } from "@tommy/i18n/source";
import type { Effect } from "effect";
import type { WebContents } from "electron";
import type { LiveVoiceFailed } from "../../backend/agent/live-voice";
import { runCauseEffect } from "../../backend/effect-boundary";
import { decodeVoiceLiveSessionFromHost } from "../remote-extension-decoding";
import { acceptEmpty } from "../remote-host-decoding";
import type { RemoteServerManager } from "../remote-server-manager";
import { agentRequest } from "./agent-inputs";
import { eventPayloadHandler, type IpcGroupHandlers } from "./define-ipc-group";
import { routeToServer } from "./route-to-server";

export interface LiveVoiceIpcService {
  start(input: VoiceLiveStart, ownerId: string): Effect.Effect<VoiceLiveSession, LiveVoiceFailed>;
  stop(sessionId: string, ownerId: string): Effect.Effect<void, LiveVoiceFailed>;
  cancel(requestId: string, ownerId: string): Effect.Effect<void, LiveVoiceFailed>;
  stopOwner(ownerId: string): Effect.Effect<void, LiveVoiceFailed>;
}

interface WindowCalls {
  sender: WebContents;
  ownerId: string;
  epoch: number;
  sessions: Map<string, string>;
  pending: Map<string, Set<string>>;
}

const remoteVoiceTargets = new Map<string, Map<string, WindowCalls>>();

function forgetRemoteTarget(serverId: string, sessionId: string, calls: WindowCalls): void {
  const targets = remoteVoiceTargets.get(serverId);
  if (targets?.get(sessionId) !== calls) return;
  targets.delete(sessionId);
  if (targets.size === 0) remoteVoiceTargets.delete(serverId);
}

/** A remote logical session can serve several windows. Only the starting window gets speech. */
export function remoteLiveVoiceEventTarget(serverId: string, event: VoiceLiveEvent): WebContents | null {
  const calls = remoteVoiceTargets.get(serverId)?.get(event.sessionId);
  if (!calls) return null;
  const destroyed = calls.sender.isDestroyed();
  if (event.type === "ended" || destroyed) {
    forgetRemoteTarget(serverId, event.sessionId, calls);
    if (calls.sessions.get(serverId) === event.sessionId) calls.sessions.delete(serverId);
  }
  return destroyed ? null : calls.sender;
}

/** A renderer names its session only. Main derives the call owner from the trusted sender. */
export function voiceLiveIpcHandlers({
  liveVoice,
  remoteServers,
}: {
  liveVoice: LiveVoiceIpcService;
  remoteServers: Pick<RemoteServerManager, "request" | "supportsCapability">;
}): Pick<IpcGroupHandlers["voice"], "startLive" | "stopLive" | "cancelLive"> {
  const windows = new WeakMap<WebContents, WindowCalls>();

  function remoteStop(serverId: string, sessionId: string) {
    return runCauseEffect(
      remoteServers.request(serverId, LIVE_VOICE_ROUTES.stop, acceptEmpty, { method: "POST", body: { sessionId } }),
    );
  }

  function remoteCancel(serverId: string, requestId: string) {
    return runCauseEffect(
      remoteServers.request(serverId, LIVE_VOICE_ROUTES.cancel, acceptEmpty, { method: "POST", body: { requestId } }),
    );
  }

  function forgetPending(calls: WindowCalls, serverId: string, requestId: string | undefined): void {
    if (!requestId) return;
    const pending = calls.pending.get(serverId);
    pending?.delete(requestId);
    if (pending?.size === 0) calls.pending.delete(serverId);
  }

  async function endCalls(calls: WindowCalls): Promise<void> {
    calls.epoch += 1;
    const sessions = [...calls.sessions];
    const pending = [...calls.pending].flatMap(([serverId, requests]) =>
      [...requests].map((requestId) => ({ serverId, requestId })),
    );
    calls.sessions.clear();
    calls.pending.clear();
    for (const [serverId, sessionId] of sessions) forgetRemoteTarget(serverId, sessionId, calls);
    await Promise.allSettled([
      runCauseEffect(liveVoice.stopOwner(calls.ownerId)),
      ...sessions
        .filter(([serverId]) => serverId !== LOCAL_SERVER_ID)
        .map(([serverId, sessionId]) => remoteStop(serverId, sessionId)),
      ...pending
        .filter(({ serverId }) => serverId !== LOCAL_SERVER_ID)
        .map(({ serverId, requestId }) => remoteCancel(serverId, requestId)),
    ]);
  }

  function windowCalls(sender: WebContents): WindowCalls {
    const existing = windows.get(sender);
    if (existing) return existing;
    const calls: WindowCalls = {
      sender,
      ownerId: `local:${sender.id}`,
      epoch: 0,
      sessions: new Map(),
      pending: new Map(),
    };
    windows.set(sender, calls);
    const end = () => {
      void endCalls(calls);
    };
    sender.once("destroyed", end);
    sender.on("render-process-gone", end);
    sender.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) end();
    });
    return calls;
  }

  return {
    startLive: eventPayloadHandler(agentRequest(decodeVoiceLiveStart), async (event, { serverId, payload }) => {
      const calls = windowCalls(event.sender);
      const ending = endCalls(calls);
      const epoch = calls.epoch;
      const { requestId } = payload;
      if (requestId) {
        const pending = calls.pending.get(serverId) ?? new Set<string>();
        pending.add(requestId);
        calls.pending.set(serverId, pending);
      }
      try {
        await ending;
        if (
          event.sender.isDestroyed() ||
          calls.epoch !== epoch ||
          (requestId && !calls.pending.get(serverId)?.has(requestId))
        )
          throw new Error(sourceText("error.voice.live.disconnected"));
        const session = await routeToServer(serverId, {
          local: () => runCauseEffect(liveVoice.start(payload, calls.ownerId)),
          remote: (target) => {
            if (!remoteServers.supportsCapability(target, LIVE_VOICE_CAPABILITY))
              throw new Error(sourceText("error.voice.live.unavailable"));
            return runCauseEffect(
              remoteServers.request(target, LIVE_VOICE_ROUTES.start, decodeVoiceLiveSessionFromHost, {
                method: "POST",
                body: payload,
              }),
            );
          },
        });
        if (
          event.sender.isDestroyed() ||
          calls.epoch !== epoch ||
          (requestId && !calls.pending.get(serverId)?.has(requestId))
        ) {
          if (serverId === LOCAL_SERVER_ID) await runCauseEffect(liveVoice.stop(session.sessionId, calls.ownerId));
          else await remoteStop(serverId, session.sessionId);
          throw new Error(sourceText("error.voice.live.disconnected"));
        }
        calls.sessions.set(serverId, session.sessionId);
        if (serverId !== LOCAL_SERVER_ID) {
          const targets = remoteVoiceTargets.get(serverId) ?? new Map<string, WindowCalls>();
          targets.set(session.sessionId, calls);
          remoteVoiceTargets.set(serverId, targets);
        }
        return session;
      } finally {
        forgetPending(calls, serverId, requestId);
      }
    }),
    stopLive: eventPayloadHandler(agentRequest(decodeVoiceLiveStop), async (event, { serverId, payload }) => {
      const calls = windows.get(event.sender);
      if (!calls || calls.sessions.get(serverId) !== payload.sessionId) return;
      forgetRemoteTarget(serverId, payload.sessionId, calls);
      if (serverId === LOCAL_SERVER_ID) await runCauseEffect(liveVoice.stop(payload.sessionId, calls.ownerId));
      else await remoteStop(serverId, payload.sessionId);
      if (calls.sessions.get(serverId) === payload.sessionId) calls.sessions.delete(serverId);
    }),
    cancelLive: eventPayloadHandler(agentRequest(decodeVoiceLiveCancel), async (event, { serverId, payload }) => {
      const calls = windows.get(event.sender);
      if (!calls?.pending.get(serverId)?.has(payload.requestId)) return;
      // Record Stop before awaiting the adapter, including while a preceding call is closing.
      forgetPending(calls, serverId, payload.requestId);
      if (serverId === LOCAL_SERVER_ID) await runCauseEffect(liveVoice.cancel(payload.requestId, calls.ownerId));
      else await remoteCancel(serverId, payload.requestId);
    }),
  };
}
