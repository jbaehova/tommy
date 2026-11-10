import {
  type CodexLiveVoice,
  VOICE_LIVE_LIMITS,
  type VoiceLiveEvent,
  type VoiceLiveSession,
  type VoiceLiveStart,
} from "@tommy/contracts/ipc-voice";
import { isDynamicRecord, isString } from "@tommy/contracts/runtime-values";
import { currentText } from "@tommy/ui/text";
import { createStore, onSettled } from "solid-js";
import { voiceCaptureError } from "../voice-status";

const LEVEL_COUNT = 24;
const LEVEL_INTERVAL_MS = 80;
const ICE_TIMEOUT_MS = 10_000;
const EARLY_END_LIMIT = 64;

export type LiveVoicePhase = "idle" | "starting" | "listening" | "thinking" | "speaking" | "failed";
export interface CodexLivePort {
  startLive(input: VoiceLiveStart): Promise<VoiceLiveSession>;
  stopLive(input: { sessionId: string }): Promise<void>;
  cancelLive(input: { requestId: string }): Promise<void>;
  onLiveEvent(listener: (event: VoiceLiveEvent) => void): () => void;
}
interface LiveState {
  phase: LiveVoicePhase;
  muted: boolean;
  heard: string;
  said: string;
  error: string | null;
  levels: number[];
}
const quiet = () => new Array<number>(LEVEL_COUNT).fill(0);

/** A WebRTC call. Only an explicit start requests microphone access. It ends with its owner. */
export function createCodexLiveConversation(deps: {
  agentId: string;
  port: CodexLivePort;
  voice?: () => CodexLiveVoice | null;
}) {
  const [state, setState] = createStore<LiveState>({
    phase: "idle",
    muted: false,
    heard: "",
    said: "",
    error: null,
    levels: quiet(),
  });
  let disposed = false;
  let generation = 0;
  let phase: LiveVoicePhase = "idle";
  let muted = false;
  let sessionId: string | null = null;
  let pendingRequestId: string | null = null;
  let starting = false;
  const endedEarly = new Map<string, string | null>();
  let peer: RTCPeerConnection | undefined;
  let channel: RTCDataChannel | undefined;
  let microphone: MediaStream | undefined;
  let context: AudioContext | undefined;
  let microphoneMeter: AnalyserNode | undefined;
  let replyMeter: AnalyserNode | undefined;
  let meterTimer: ReturnType<typeof setInterval> | undefined;
  let cancelled: AbortController | undefined;
  let reply: HTMLAudioElement | undefined;
  let currentReply: string | null = null;
  let silencedTurn: string | null = null;
  let silenceNextReply = false;

  function setPhase(next: LiveVoicePhase): void {
    phase = next;
    setState((draft) => {
      draft.phase = next;
    });
  }

  function release(): void {
    generation += 1;
    starting = false;
    cancelled?.abort();
    cancelled = undefined;
    if (meterTimer !== undefined) clearInterval(meterTimer);
    meterTimer = undefined;
    const pending = pendingRequestId;
    pendingRequestId = null;
    if (pending) void deps.port.cancelLive({ requestId: pending }).catch(() => undefined);
    const ended = sessionId;
    sessionId = null;
    if (ended) void deps.port.stopLive({ sessionId: ended }).catch(() => undefined);
    const connection = peer;
    peer = undefined;
    channel?.close();
    channel = undefined;
    connection?.close();
    for (const track of microphone?.getTracks() ?? []) track.stop();
    microphone = undefined;
    microphoneMeter = undefined;
    replyMeter = undefined;
    void context?.close().catch(() => undefined);
    context = undefined;
    if (reply) {
      reply.pause();
      reply.srcObject = null;
    }
    reply = undefined;
  }

  function fail(message: string): void {
    release();
    muted = true;
    setPhase("failed");
    setState((draft) => {
      draft.muted = true;
      draft.error = message;
      draft.levels = quiet();
    });
  }
  function ended(error: string | null): void {
    const { t, errorMessage } = currentText();
    fail(
      error ? errorMessage(new Error(error), t("error.voice.live.disconnected")) : t("error.voice.live.disconnected"),
    );
  }

  const stopEvents = deps.port.onLiveEvent((event) => {
    if (disposed) return;
    if (event.sessionId !== sessionId) {
      if (event.type === "ended" && starting) {
        if (endedEarly.size >= EARLY_END_LIMIT) endedEarly.clear();
        endedEarly.set(event.sessionId, event.error);
      }
      return;
    }
    if (event.type === "ended") {
      sessionId = null;
      ended(event.error);
      return;
    }
    setState((draft) => {
      const text = event.final ? event.text : (event.role === "user" ? draft.heard : draft.said) + event.text;
      if (event.role === "user") draft.heard = text.slice(-VOICE_LIVE_LIMITS.maximumTranscriptLength);
      else draft.said = text.slice(-VOICE_LIVE_LIMITS.maximumTranscriptLength);
    });
  });

  function modelEvent(data: unknown): void {
    if (!isString(data) || data.length > VOICE_LIVE_LIMITS.maximumTranscriptLength) return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (!isDynamicRecord(event) || !isDynamicRecord(event.turn) || !isString(event.turn.id)) return;
    const turn = event.turn;
    if (event.type === "turn.created" && turn.role === "user") {
      silenceNextReply = false;
      if (silencedTurn === null && reply) reply.muted = false;
      setPhase("listening");
      setState((draft) => {
        draft.heard = "";
      });
    } else if (event.type === "turn.done" && turn.role === "user") {
      if (phase !== "speaking") setPhase("thinking");
    } else if (event.type === "turn.created" && turn.role === "assistant") {
      currentReply = event.turn.id;
      if (silenceNextReply) {
        silenceNextReply = false;
        silencedTurn = event.turn.id;
        return;
      }
      setPhase("speaking");
      setState((draft) => {
        draft.said = "";
      });
    } else if (event.type === "turn.done" && turn.role === "assistant") {
      if (silencedTurn === event.turn.id) {
        silencedTurn = null;
        if (reply) reply.muted = false;
      }
      if (phase === "speaking") setPhase("listening");
    }
  }

  function meter(stream: MediaStream): AnalyserNode | undefined {
    if (!context) return undefined;
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    return analyser;
  }
  function startMeter(): void {
    const samples = new Float32Array(512);
    meterTimer = setInterval(() => {
      const analyser = phase === "speaking" ? replyMeter : microphoneMeter;
      let level = 0;
      if (analyser && !(phase !== "speaking" && muted)) {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        const db = 20 * Math.log10(Math.max(Math.sqrt(sum / samples.length), 1e-6));
        level = Math.min(1, Math.max(0, (db + 60) / 50));
      }
      setState((draft) => {
        draft.levels = [...draft.levels.slice(1), level];
      });
    }, LEVEL_INTERVAL_MS);
  }

  async function start(): Promise<void> {
    if (disposed || (phase !== "idle" && phase !== "failed")) return;
    release();
    const own = generation;
    const controller = new AbortController();
    cancelled = controller;
    muted = false;
    currentReply = null;
    silencedTurn = null;
    silenceNextReply = false;
    setPhase("starting");
    setState((draft) => {
      draft.muted = false;
      draft.error = null;
      draft.heard = "";
      draft.said = "";
      draft.levels = quiet();
    });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (error) {
      if (own === generation && !disposed) fail(voiceCaptureError(error));
      return;
    }
    if (own !== generation || disposed) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    microphone = stream;
    for (const track of stream.getAudioTracks()) track.enabled = !muted;
    try {
      reply = new Audio();
      reply.autoplay = true;
      // A missing meter must not stop a call that can still capture and play audio.
      try {
        context = new AudioContext();
        microphoneMeter = meter(stream);
      } catch {
        context = undefined;
      }
      const connection = new RTCPeerConnection();
      peer = connection;
      for (const track of stream.getAudioTracks()) connection.addTrack(track, stream);
      connection.addEventListener("track", (event) => {
        if (peer !== connection || own !== generation) return;
        const received = event.streams[0] ?? new MediaStream([event.track]);
        if (reply) {
          reply.srcObject = received;
          reply.muted = silencedTurn !== null || silenceNextReply;
        }
        replyMeter = meter(received);
      });
      connection.addEventListener("connectionstatechange", () => {
        if (peer === connection && connection.connectionState === "failed") ended(null);
      });
      const events = connection.createDataChannel("oai-events");
      channel = events;
      events.addEventListener("message", (event) => {
        if (peer === connection) modelEvent(event.data);
      });
      events.addEventListener("close", () => {
        if (peer === connection && own === generation) ended(null);
      });
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      await gatherIce(connection, controller.signal);
      if (own !== generation || disposed) return;
      const sdp = connection.localDescription?.sdp;
      if (!sdp) throw new Error(currentText().t("error.voice.live.cannotStart"));
      starting = true;
      endedEarly.clear();
      const voice = deps.voice?.();
      const requestId = crypto.randomUUID();
      pendingRequestId = requestId;
      const session = await deps.port
        .startLive({ agentId: deps.agentId, sdp, requestId, ...(voice ? { voice } : {}) })
        .finally(() => {
          if (own === generation) starting = false;
        });
      if (own !== generation || disposed) {
        void deps.port.stopLive({ sessionId: session.sessionId }).catch(() => undefined);
        return;
      }
      if (endedEarly.has(session.sessionId)) {
        const error = endedEarly.get(session.sessionId) ?? null;
        endedEarly.clear();
        ended(error);
        return;
      }
      endedEarly.clear();
      pendingRequestId = null;
      sessionId = session.sessionId;
      await connection.setRemoteDescription({ type: "answer", sdp: session.sdp });
      if (own !== generation || disposed) return;
      startMeter();
      setPhase("listening");
    } catch (error) {
      if (own !== generation || disposed) return;
      const { t, errorMessage } = currentText();
      fail(errorMessage(error, t("error.voice.live.cannotStart")));
    }
  }

  function end(): void {
    release();
    starting = false;
    endedEarly.clear();
    muted = false;
    setPhase("idle");
    setState((draft) => {
      draft.muted = false;
      draft.error = null;
      draft.levels = quiet();
    });
  }
  function toggleMute(): void {
    if (phase === "idle" || phase === "failed") return;
    muted = !muted;
    for (const track of microphone?.getAudioTracks() ?? []) track.enabled = !muted;
    setState((draft) => {
      draft.muted = muted;
    });
  }
  /** Silences this reply. The Codex turn keeps running in the chat. */
  function interrupt(): void {
    if (phase !== "speaking" && phase !== "thinking") return;
    if (phase === "speaking") silencedTurn = currentReply;
    else silenceNextReply = true;
    if (reply) reply.muted = true;
    setPhase("listening");
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopEvents();
    end();
  }
  onSettled(() => dispose);
  return {
    phase: () => state.phase,
    muted: () => state.muted,
    heard: () => state.heard,
    said: () => state.said,
    error: () => state.error,
    levels: () => state.levels,
    start,
    end,
    toggleMute,
    interrupt,
    dispose,
    disconnected: () => {
      if (phase !== "idle") ended(null);
    },
  };
}

function gatherIce(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", changed);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const changed = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const abort = () => finish(new DOMException("Aborted", "AbortError"));
    const timeout = setTimeout(() => finish(new Error(currentText().t("error.voice.live.timedOut"))), ICE_TIMEOUT_MS);
    peer.addEventListener("icegatheringstatechange", changed);
    signal.addEventListener("abort", abort, { once: true });
    changed();
  });
}
