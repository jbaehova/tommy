import {
  VOICE_API_KEY_MAX_LENGTH,
  VOICE_STREAM_LIMITS,
  type VoiceApiKeyInput,
  type VoiceStream,
  type VoiceStreamAudio,
} from "@tommy/contracts/ipc";
import { sourceText } from "@tommy/i18n/source";
import { isObject } from "./validation";

/** The one place an OpenAI key from the renderer enters main. Null removes the saved key. */
export function parseVoiceApiKey(input: unknown): VoiceApiKeyInput {
  if (!isObject(input)) throw new Error(sourceText("error.provider.keyRequired"));
  if (input.key === null) return { key: null };
  if (typeof input.key !== "string" || !input.key.trim()) throw new Error(sourceText("error.provider.keyRequired"));
  if (input.key.length > VOICE_API_KEY_MAX_LENGTH) throw new Error(sourceText("error.provider.keyTooLong"));
  const key = input.key.trim();
  // The key goes into an HTTP header, which refuses other characters when the socket opens.
  if (!/^[\x21-\x7e]+$/u.test(key)) throw new Error(sourceText("error.provider.keyInvalidCharacters"));
  return { key };
}

export function parseVoiceStream(input: unknown): VoiceStream {
  if (!isObject(input) || typeof input.streamId !== "string" || !input.streamId || input.streamId.length > 64)
    throw new Error("A voice stream is required.");
  return { streamId: input.streamId };
}

export function parseVoiceStreamAudio(input: unknown): VoiceStreamAudio {
  const { streamId } = parseVoiceStream(input);
  if (!isObject(input) || !(input.pcm instanceof Uint8Array)) throw new Error("Voice audio is required.");
  // 16-bit samples: an odd length cannot be PCM.
  if (input.pcm.byteLength % 2 !== 0 || input.pcm.byteLength > VOICE_STREAM_LIMITS.maximumChunkBytes)
    throw new Error("Voice audio has an invalid length.");
  return { streamId, pcm: input.pcm };
}
