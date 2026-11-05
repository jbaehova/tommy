import { randomUUID } from "node:crypto";
import { sourceText } from "@tommy/i18n/source";
import type { Effect } from "effect";
import {
  OpenAiTranscriptionSession,
  type OpenVoiceStreamSocket,
  openOpenAiSocket,
  VoiceStreamFailure,
} from "./voice-openai-stream";

interface HostVoiceKeys {
  get(): string | null;
  set(key: string | null): Effect.Effect<void, { readonly cause: unknown }>;
}

/** A person dictates from one device at a time, so one more stream ends an abandoned one. */
const MAXIMUM_STREAMS = 4;

/** The dictation streams of this host and the OpenAI API key they use. */
export class HostVoice {
  readonly #keys: HostVoiceKeys;
  readonly #open: OpenVoiceStreamSocket;
  readonly #streams = new Map<string, OpenAiTranscriptionSession>();

  constructor(options: { keys: HostVoiceKeys; open?: OpenVoiceStreamSocket }) {
    this.#keys = options.keys;
    this.#open = options.open ?? openOpenAiSocket;
  }

  keySaved(): boolean {
    return Boolean(this.#keys.get());
  }

  setKey(key: string | null): Effect.Effect<void, { readonly cause: unknown }> {
    return this.#keys.set(key?.trim() || null);
  }

  async start(): Promise<string> {
    const apiKey = this.#keys.get();
    if (!apiKey) throw new VoiceStreamFailure(sourceText("error.voice.cloud.keyRequired"));
    while (this.#streams.size >= MAXIMUM_STREAMS) {
      const [oldest] = this.#streams.keys();
      if (oldest) this.cancel(oldest);
    }
    const session = new OpenAiTranscriptionSession({ apiKey, open: this.#open, onText: () => {} });
    const streamId = randomUUID();
    this.#streams.set(streamId, session);
    try {
      await session.ready;
    } catch (error) {
      this.#streams.delete(streamId);
      throw error;
    }
    return streamId;
  }

  /** Answers the text so far, so that the client shows it while the person speaks. */
  append(streamId: string, pcm: Uint8Array): string {
    const session = this.#session(streamId);
    try {
      session.append(pcm);
    } catch (error) {
      this.#streams.delete(streamId);
      throw error;
    }
    return session.text;
  }

  async finish(streamId: string): Promise<string> {
    const session = this.#session(streamId);
    this.#streams.delete(streamId);
    return session.finish();
  }

  cancel(streamId: string): void {
    this.#streams.get(streamId)?.cancel();
    this.#streams.delete(streamId);
  }

  stop(): void {
    for (const streamId of [...this.#streams.keys()]) this.cancel(streamId);
  }

  #session(streamId: string): OpenAiTranscriptionSession {
    const session = this.#streams.get(streamId);
    if (!session) throw new VoiceStreamFailure(sourceText("error.voice.cloud.streamEnded"));
    return session;
  }
}
