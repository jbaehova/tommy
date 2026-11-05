import { HOST_VOICE_ROUTES, HostVoiceStream, HostVoiceText } from "@tommy/contracts/host-voice";
import type { TeamProtocolV2Json } from "@tommy/contracts/team-protocol/v2";
import { Schema } from "effect";

const decodeStream = Schema.decodeUnknownSync(HostVoiceStream);
const decodeText = Schema.decodeUnknownSync(HostVoiceText);

export type HostVoiceRequest = <T>(path: string, decode: (value: unknown) => T, body: TeamProtocolV2Json) => Promise<T>;

/**
 * One dictation through the server, which holds the OpenAI API key and the socket to OpenAI. The
 * microphone sends base64 of 16 kHz 16-bit mono PCM, which is the format that the host reads. Chunks
 * go one at a time, so that they arrive in order.
 */
export class HostDictationSession {
  readonly #request: HostVoiceRequest;
  readonly #onText: (text: string) => void;
  readonly #onFailure: (error: unknown) => void;
  #streamId: string | null = null;
  #queue: Promise<void> = Promise.resolve();
  #ended = false;

  constructor(options: {
    request: HostVoiceRequest;
    onText: (text: string) => void;
    /** A chunk failed. Called once, and never after `cancel`. */
    onFailure: (error: unknown) => void;
  }) {
    this.#request = options.request;
    this.#onText = options.onText;
    this.#onFailure = options.onFailure;
  }

  /** Rejects when the server has no key or cannot reach OpenAI. */
  async start(): Promise<void> {
    const { streamId } = await this.#request(HOST_VOICE_ROUTES.start, decodeStream, {});
    this.#streamId = streamId;
    if (this.#ended) this.#sendCancel(streamId);
  }

  append(pcm: string): void {
    const streamId = this.#streamId;
    if (!streamId || this.#ended) return;
    this.#queue = this.#queue.then(async () => {
      if (this.#ended) return;
      try {
        const { text } = await this.#request(HOST_VOICE_ROUTES.append, decodeText, { streamId, audio: pcm });
        if (!this.#ended) this.#onText(text);
      } catch (error) {
        if (this.#ended) return;
        this.#ended = true;
        this.#onFailure(error);
      }
    });
  }

  /** Waits for the chunks on the way, then for the last text. */
  async finish(): Promise<void> {
    await this.#queue;
    const streamId = this.#streamId;
    if (!streamId || this.#ended) return;
    this.#ended = true;
    try {
      const { text } = await this.#request(HOST_VOICE_ROUTES.finish, decodeText, { streamId });
      this.#onText(text);
    } catch (error) {
      this.#onFailure(error);
    }
  }

  cancel(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#streamId) this.#sendCancel(this.#streamId);
  }

  #sendCancel(streamId: string): void {
    void this.#request(HOST_VOICE_ROUTES.cancel, () => undefined, { streamId }).catch(() => undefined);
  }
}
