// Dictation through the host. The host holds the OpenAI API key and the socket to OpenAI. A client
// sends its audio to the host, and it can only learn whether a key is saved.

import { Schema } from "effect";

export const HOST_VOICE_ROUTES = {
  status: "/v1/voice/status",
  setKey: "/v1/voice/key",
  start: "/v1/voice/stream/start",
  append: "/v1/voice/stream/append",
  finish: "/v1/voice/stream/finish",
  cancel: "/v1/voice/stream/cancel",
} as const;

export const HostVoiceStatus = Schema.Struct({ keySaved: Schema.Boolean });
export type HostVoiceStatus = typeof HostVoiceStatus.Type;

export const HostVoiceSetKey = Schema.Struct({ key: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))) });

export const HostVoiceStream = Schema.Struct({ streamId: Schema.String.check(Schema.isMaxLength(64)) });
export type HostVoiceStream = typeof HostVoiceStream.Type;

/** `audio` is base64 of 16 kHz mono PCM16. */
export const HostVoiceAppend = Schema.Struct({
  streamId: Schema.String.check(Schema.isMaxLength(64)),
  audio: Schema.String.check(Schema.isMaxLength(256_000)),
});

export const HostVoiceText = Schema.Struct({ text: Schema.String });
export type HostVoiceText = typeof HostVoiceText.Type;
