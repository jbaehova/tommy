// One streamed dictation with the OpenAI Realtime API and `gpt-live-transcribe`. The host holds the
// socket and the API key. A client sends audio to the host and never sees the key.
//
// The model has no server voice detection, so this finds the pauses itself: each pause commits one
// turn, and the text of that turn then arrives. The socket is injected, so a check needs no network.

import { isDynamicRecord } from "@tommy/contracts/runtime-values";
import { sourceText } from "@tommy/i18n/source";
import { createTommyLogger } from "@tommy/logging";
import WebSocket from "ws";
import { rawDataText } from "./ws-raw-data";

const logger = createTommyLogger("voice-openai-stream");

const OPENAI_REALTIME_TRANSCRIPTION_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const OPENAI_TRANSCRIPTION_MODEL = "gpt-live-transcribe";
const OPENAI_SAMPLE_RATE = 24_000;
const INPUT_SAMPLE_RATE = 16_000;
const OPEN_TIMEOUT_MS = 15_000;
/** A client sends audio four times a second, so this ends a stream whose client went away. */
const IDLE_TIMEOUT_MS = 15_000;
/** After Stop, how long the last turns have to answer. */
const FINISH_TIMEOUT_MS = 15_000;
/** This much quiet ends a turn. */
const PAUSE_MS = 700;
/** A turn with less speech than this is not sent: the service refuses a buffer that is too small. */
const MINIMUM_TURN_MS = 200;
/** Peak level, from 0 to 32767, that counts as speech. */
const SPEECH_LEVEL = 700;

export interface VoiceStreamSocket {
  send(text: string): void;
  close(): void;
}

interface VoiceStreamSocketEvents {
  onOpen: () => void;
  onMessage: (text: string) => void;
  /** The service refused the HTTP upgrade, with this status code. */
  onRejected: (statusCode: number) => void;
  /** The socket ended, asked or not. Called once. */
  onClose: () => void;
}

export type OpenVoiceStreamSocket = (apiKey: string, events: VoiceStreamSocketEvents) => VoiceStreamSocket;

export const openOpenAiSocket: OpenVoiceStreamSocket = (apiKey, events) => {
  const socket = new WebSocket(OPENAI_REALTIME_TRANSCRIPTION_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    handshakeTimeout: OPEN_TIMEOUT_MS,
  });
  socket.on("open", events.onOpen);
  socket.on("message", (data) => events.onMessage(rawDataText(data)));
  socket.on("unexpected-response", (request, response) => {
    events.onRejected(response.statusCode ?? 0);
    request.destroy();
  });
  socket.on("close", events.onClose);
  socket.on("error", () => {
    // `close` follows. The error can carry the headers of the request.
  });
  return { send: (text) => socket.send(text), close: () => socket.terminate() };
};

/** Why a stream failed. The message goes to the client. */
export class VoiceStreamFailure extends Error {}

function failureFor(category: string): VoiceStreamFailure {
  if (category === "http-401" || category === "http-403" || category === "invalid_api_key")
    return new VoiceStreamFailure(sourceText("error.voice.cloud.keyRejected"));
  if (category === "insufficient_quota") return new VoiceStreamFailure(sourceText("error.voice.cloud.quotaExceeded"));
  if (category === "http-429" || category === "rate_limit_exceeded")
    return new VoiceStreamFailure(sourceText("error.voice.cloud.rateLimited"));
  return new VoiceStreamFailure(sourceText("error.voice.transcriptionFailed"));
}

/** 16 kHz PCM16 to the 24 kHz PCM16 of the service, by linear interpolation. */
function resamplePcm16(input: Uint8Array): Uint8Array {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const count = Math.floor(input.byteLength / 2);
  const outputCount = Math.floor((count * OPENAI_SAMPLE_RATE) / INPUT_SAMPLE_RATE);
  const output = new Uint8Array(outputCount * 2);
  const out = new DataView(output.buffer);
  for (let index = 0; index < outputCount; index += 1) {
    const position = (index * INPUT_SAMPLE_RATE) / OPENAI_SAMPLE_RATE;
    const left = Math.floor(position);
    const right = Math.min(left + 1, count - 1);
    const a = view.getInt16(left * 2, true);
    const b = view.getInt16(right * 2, true);
    out.setInt16(index * 2, Math.round(a + (b - a) * (position - left)), true);
  }
  return output;
}

function peakLevel(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let peak = 0;
  for (let offset = 0; offset + 1 < pcm.byteLength; offset += 2) {
    peak = Math.max(peak, Math.abs(view.getInt16(offset, true)));
  }
  return peak;
}

type Phase = "opening" | "streaming" | "finishing" | "ended" | "failed";

/** One turn of speech, in the order that the user said it. */
interface Turn {
  itemId: string | null;
  text: string;
  done: boolean;
}

/**
 * One dictation. `ready` settles when the service accepts the session or refuses it. `finish` commits
 * the last audio and answers the whole text. Each change of the text goes to `onText`.
 */
export class OpenAiTranscriptionSession {
  readonly ready: Promise<void>;
  readonly #socket: VoiceStreamSocket;
  readonly #onText: (text: string) => void;
  #phase: Phase = "opening";
  #failure: VoiceStreamFailure | null = null;
  #settleReady: { resolve: () => void; reject: (failure: VoiceStreamFailure) => void } | null = null;
  #settleFinish: (() => void) | null = null;
  #openTimer: NodeJS.Timeout | null;
  #idleTimer: NodeJS.Timeout | null = null;
  #finishTimer: NodeJS.Timeout | null = null;
  readonly #turns: Turn[] = [];
  #speechMs = 0;
  #pauseMs = 0;

  constructor(options: { apiKey: string; open: OpenVoiceStreamSocket; onText: (text: string) => void }) {
    this.#onText = options.onText;
    this.ready = new Promise((resolve, reject) => {
      this.#settleReady = { resolve, reject };
    });
    // A refused start is reported through `ready`. This keeps it from counting as unhandled first.
    this.ready.catch(() => {});
    this.#socket = options.open(options.apiKey, {
      onOpen: () => this.#configure(),
      onMessage: (text) => this.#receive(text),
      onRejected: (statusCode) => this.#fail(`http-${statusCode}`),
      onClose: () => this.#closed(),
    });
    this.#openTimer = setTimeout(() => this.#fail("open-timeout"), OPEN_TIMEOUT_MS);
  }

  get text(): string {
    return this.#turns
      .map((turn) => turn.text.trim())
      .filter(Boolean)
      .join(" ");
  }

  /** Sends the next part of the 16 kHz PCM16 audio. A failed or ended stream throws. */
  append(pcm: Uint8Array): void {
    if (this.#failure) throw this.#failure;
    if (this.#phase !== "streaming") throw new VoiceStreamFailure(sourceText("error.voice.cloud.streamEnded"));
    this.#armIdleTimer();
    if (pcm.byteLength === 0) return;
    this.#socket.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: Buffer.from(resamplePcm16(pcm)).toString("base64"),
      }),
    );
    const durationMs = (pcm.byteLength / 2 / INPUT_SAMPLE_RATE) * 1_000;
    if (peakLevel(pcm) >= SPEECH_LEVEL) {
      this.#speechMs += durationMs;
      this.#pauseMs = 0;
      return;
    }
    this.#pauseMs += durationMs;
    if (this.#pauseMs >= PAUSE_MS) this.#commit();
  }

  /** Commits the last audio, waits for every turn, and answers the whole text. */
  async finish(): Promise<string> {
    if (this.#failure) throw this.#failure;
    if (this.#phase !== "streaming") throw new VoiceStreamFailure(sourceText("error.voice.cloud.streamEnded"));
    this.#phase = "finishing";
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    this.#commit();
    if (this.#turns.some((turn) => !turn.done)) {
      await new Promise<void>((resolve) => {
        this.#settleFinish = resolve;
        // The text so far stands for a turn that does not answer in time.
        this.#finishTimer = setTimeout(() => this.#endFinish(), FINISH_TIMEOUT_MS);
      });
    }
    this.#clearTimers();
    this.#socket.close();
    if (this.#failure) throw this.#failure;
    this.#phase = "ended";
    return this.text;
  }

  /** Ends the stream and drops its text. */
  cancel(): void {
    if (this.#phase === "ended" || this.#phase === "failed") return;
    this.#phase = "ended";
    this.#clearTimers();
    this.#settleReady?.reject(new VoiceStreamFailure(sourceText("error.voice.cloud.streamEnded")));
    this.#settleReady = null;
    this.#endFinish();
    this.#socket.close();
  }

  #configure(): void {
    this.#socket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: OPENAI_SAMPLE_RATE },
              transcription: { model: OPENAI_TRANSCRIPTION_MODEL },
              turn_detection: null,
            },
          },
        },
      }),
    );
  }

  /** The audio since the last commit becomes one turn, when it holds enough speech. */
  #commit(): void {
    if (this.#speechMs < MINIMUM_TURN_MS) return;
    this.#speechMs = 0;
    this.#pauseMs = 0;
    this.#turns.push({ itemId: null, text: "", done: false });
    this.#socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  }

  /** Completions of different turns can come out of order, so each event names its item. */
  #turnOf(itemId: unknown): Turn | undefined {
    return typeof itemId === "string" ? this.#turns.find((turn) => turn.itemId === itemId) : undefined;
  }

  #receive(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.#fail("invalid-message");
      return;
    }
    if (!isDynamicRecord(message) || typeof message.type !== "string") return;
    switch (message.type) {
      case "session.updated":
        if (this.#phase !== "opening") return;
        this.#phase = "streaming";
        if (this.#openTimer) clearTimeout(this.#openTimer);
        this.#openTimer = null;
        this.#armIdleTimer();
        this.#settleReady?.resolve();
        this.#settleReady = null;
        return;
      case "input_audio_buffer.committed": {
        // Commits answer in the order that they were sent.
        const turn = this.#turns.find((candidate) => candidate.itemId === null);
        if (turn && typeof message.item_id === "string") turn.itemId = message.item_id;
        return;
      }
      case "conversation.item.input_audio_transcription.delta": {
        const turn = this.#turnOf(message.item_id);
        if (turn && typeof message.delta === "string") {
          turn.text += message.delta;
          this.#changed();
        }
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const turn = this.#turnOf(message.item_id);
        if (!turn) return;
        if (typeof message.transcript === "string") turn.text = message.transcript;
        turn.done = true;
        this.#changed();
        if (this.#turns.every((candidate) => candidate.done)) this.#endFinish();
        return;
      }
      case "conversation.item.input_audio_transcription.failed": {
        const turn = this.#turnOf(message.item_id);
        if (turn) turn.done = true;
        if (this.#turns.every((candidate) => candidate.done)) this.#endFinish();
        return;
      }
      case "error": {
        const error = isDynamicRecord(message.error) ? message.error : {};
        const code =
          typeof error.code === "string" ? error.code : typeof error.type === "string" ? error.type : "error";
        // The buffer was empty after the last turn: nothing is lost.
        if (code === "input_audio_buffer_commit_empty") {
          const empty = this.#turns.findLast((turn) => turn.itemId === null);
          if (empty) this.#turns.splice(this.#turns.indexOf(empty), 1);
          if (this.#turns.every((turn) => turn.done)) this.#endFinish();
          return;
        }
        this.#fail(code);
        return;
      }
      default:
        return;
    }
  }

  #changed(): void {
    if (this.#phase === "streaming" || this.#phase === "finishing") this.#onText(this.text);
  }

  #armIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.#fail("idle"), IDLE_TIMEOUT_MS);
  }

  #endFinish(): void {
    const settle = this.#settleFinish;
    this.#settleFinish = null;
    settle?.();
  }

  #fail(category: string): void {
    if (this.#phase === "ended" || this.#phase === "failed") return;
    // Only the category: the text of a service error can quote the request.
    logger.warn("OpenAI ended a dictation stream.", { category });
    this.#failure = failureFor(category);
    this.#phase = "failed";
    this.#clearTimers();
    this.#settleReady?.reject(this.#failure);
    this.#settleReady = null;
    this.#endFinish();
    this.#socket.close();
  }

  #closed(): void {
    if (this.#phase === "finishing") this.#endFinish();
    else this.#fail("closed");
  }

  #clearTimers(): void {
    if (this.#openTimer) clearTimeout(this.#openTimer);
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#finishTimer) clearTimeout(this.#finishTimer);
    this.#openTimer = null;
    this.#idleTimer = null;
    this.#finishTimer = null;
  }
}
