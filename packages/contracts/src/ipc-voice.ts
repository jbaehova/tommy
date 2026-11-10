import { isBoundedString } from "./ipc-bounded-values";
import { isBoolean, isDynamicRecord, isOneOf } from "./runtime-values";

export const VOICE_AUDIO_LIMITS = {
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
  maximumSeconds: 120,
  maximumWavBytes: 3_840_044,
  /** A kept recording is Opus in WebM: 120 s at 32 kbps is about 480 KB, and the rest is room for VBR. */
  maximumRecordingBytes: 1_048_576,
} as const;

export interface VoiceTranscriptionResult {
  text: string;
}

/** The dictation model of the host. It streams through the host with its OpenAI API key. */
export const OPENAI_VOICE_MODEL_ID = "gpt-live-transcribe";
export const VOICE_MODEL_IDS = [OPENAI_VOICE_MODEL_ID] as const;
export type VoiceModelId = (typeof VOICE_MODEL_IDS)[number];
export const DEFAULT_VOICE_MODEL_ID: VoiceModelId = OPENAI_VOICE_MODEL_ID;

interface VoiceModelCapabilities {
  /** The product name. It is not translated. */
  name: string;
  /**
   * True when the model takes a fixed language. Parakeet always finds the language itself, and Bark
   * recognizes English only.
   */
  supportsLanguage: boolean;
  /**
   * True when the composer shows text while you speak. Whisper reads 30 s for each pass, so it
   * transcribes only after Stop.
   */
  livePreview: boolean;
}

/** A model that runs at a provider. It is ready when its API key is saved. */
export interface CloudVoiceModelInfo extends VoiceModelCapabilities {
  kind: "cloud";
  id: typeof OPENAI_VOICE_MODEL_ID;
}

export type VoiceModelInfo = CloudVoiceModelInfo;

export const VOICE_MODELS: readonly VoiceModelInfo[] = [
  {
    kind: "cloud",
    id: OPENAI_VOICE_MODEL_ID,
    name: "OpenAI Live Transcribe",
    supportsLanguage: false,
    livePreview: true,
  },
];

/** The model finds the spoken language itself. */
export const AUTOMATIC_VOICE_LANGUAGE = "automatic";

/**
 * The Whisper language codes that the settings offer. Each one has a `language.name.*` catalog
 * name; `jw` is Whisper's code for Javanese (`jv`). Automatic also finds the languages not listed.
 */
export const WHISPER_LANGUAGES = [
  "af",
  "am",
  "ar",
  "az",
  "be",
  "bg",
  "bn",
  "bs",
  "ca",
  "cs",
  "cy",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "eu",
  "fa",
  "fi",
  "fr",
  "gl",
  "gu",
  "he",
  "hi",
  "hr",
  "hu",
  "hy",
  "id",
  "is",
  "it",
  "ja",
  "jw",
  "ka",
  "kk",
  "km",
  "kn",
  "ko",
  "lo",
  "lt",
  "lv",
  "mk",
  "ml",
  "mn",
  "mr",
  "ms",
  "mt",
  "my",
  "ne",
  "nl",
  "no",
  "pa",
  "pl",
  "pt",
  "ro",
  "ru",
  "si",
  "sk",
  "sl",
  "sq",
  "sr",
  "su",
  "sv",
  "sw",
  "ta",
  "te",
  "th",
  "tr",
  "uk",
  "ur",
  "uz",
  "vi",
  "yue",
  "zh",
] as const;
export type WhisperLanguage = (typeof WHISPER_LANGUAGES)[number];
export type VoiceLanguage = typeof AUTOMATIC_VOICE_LANGUAGE | WhisperLanguage;

export interface VoiceSettings {
  modelId: VoiceModelId;
  /** Used only by a model that `supportsLanguage`. */
  language: VoiceLanguage;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  modelId: DEFAULT_VOICE_MODEL_ID,
  language: AUTOMATIC_VOICE_LANGUAGE,
};

export type VoiceModelPhase = "missing" | "downloading" | "ready" | "error";

export interface VoiceModelStatus {
  modelId: VoiceModelId;
  phase: VoiceModelPhase;
  progress: number | null;
  message: string | null;
}

/** The OpenAI API key of the server, or null to remove it. Main never sends a saved key back. */
export interface VoiceApiKeyInput {
  key: string | null;
}

/** The longest API key main accepts, as for provider keys. */
export const VOICE_API_KEY_MAX_LENGTH = 512;

/**
 * One streamed dictation. The renderer sends the recording in parts while the user speaks;
 * `streamId` keeps the parts and the text of one recording apart from a later one.
 */
export interface VoiceStream {
  streamId: string;
}

/**
 * New audio of a stream: little-endian 16-bit mono PCM at 16 kHz that follows the audio sent
 * before. At most `VOICE_STREAM_LIMITS.maximumChunkBytes` in one part.
 */
export interface VoiceStreamAudio extends VoiceStream {
  pcm: Uint8Array;
}

export const VOICE_STREAM_LIMITS = {
  /** 5 s of audio. The renderer sends about every 250 ms. */
  maximumChunkBytes: 160_000,
} as const;

/** The text of a stream so far: the final segments and the segment the user still speaks. */
export interface VoiceStreamTranscript extends VoiceStream {
  text: string;
}

export function isVoiceModelId(value: unknown): value is VoiceModelId {
  return isOneOf(VOICE_MODEL_IDS, value);
}

export function isVoiceLanguage(value: unknown): value is VoiceLanguage {
  return value === AUTOMATIC_VOICE_LANGUAGE || isOneOf(WHISPER_LANGUAGES, value);
}

/**
 * Supertonic 3, the local model that reads replies aloud. Saved in `speech-preference.json` and
 * named in model statuses; never rename it.
 */
export const SPEECH_MODEL_ID = "supertonic-3";

export const SPEECH_MODEL = {
  id: SPEECH_MODEL_ID,
  /** The product name. It is not translated. */
  name: "Supertonic 3",
  /** The download size of all files. */
  bytes: 145_296_838,
} as const;

/** The voice styles of Supertonic 3: five female and five male. Saved in `speech-preference.json`. */
export const SPEECH_VOICES = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"] as const;
export type SpeechVoice = (typeof SPEECH_VOICES)[number];

/** The languages Supertonic 3 reads. Each one has a `language.name.*` catalog name. */
export const SPEECH_LANGUAGES = [
  "ar",
  "bg",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "fi",
  "fr",
  "hi",
  "hr",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "lt",
  "lv",
  "nl",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sl",
  "sv",
  "tr",
  "uk",
  "vi",
] as const;
export type SpeechLanguage = (typeof SPEECH_LANGUAGES)[number];

export const SPEECH_LIMITS = {
  /** The longest text of one `speak` request. The renderer sends a reply in parts. */
  maximumTextLength: 1_000,
} as const;

export function isSpeechVoice(value: unknown): value is SpeechVoice {
  return isOneOf(SPEECH_VOICES, value);
}

export function isSpeechLanguage(value: unknown): value is SpeechLanguage {
  return isOneOf(SPEECH_LANGUAGES, value);
}

// ---------------------------------------------------------------------------------------------
// The user's own voice server: an OpenAI-compatible `/v1/audio` API on their network or online.

export const VOICE_SERVER_LIMITS = {
  address: 2_048,
  apiKey: 4_096,
  /** A model or voice name, such as `Systran/faster-whisper-large-v3`. */
  name: 256,
  /** The models or voices of one kind that a server lists. */
  entries: 500,
  message: 2_000,
} as const;

/**
 * What the server does for Tommy. Dictation uses `POST /audio/transcriptions` and spoken replies
 * use `POST /audio/speech`. A route that is on has its model, and speech also has its voice.
 */
export interface VoiceServerRoutes {
  dictation: boolean;
  speech: boolean;
  transcriptionModel: string | null;
  speechModel: string | null;
  voice: string | null;
}

/** Main to renderer. The key never comes back; `hasApiKey` is all the renderer may know about it. */
export interface VoiceServerSettings {
  /** The base address of the API, such as `http://studio.local:8000/v1`. */
  address: string;
  hasApiKey: boolean;
  routes: VoiceServerRoutes;
}

/** What the server lists, by route. A list is empty when the server has nothing for that route. */
export interface VoiceServerModels {
  transcription: string[];
  speech: string[];
  voices: string[];
}

/** The form field that the user must change after a failed test. */
export type VoiceServerProbeField = "address" | "apiKey";

export type VoiceServerProbe =
  | { ok: true; models: VoiceServerModels }
  | { ok: false; field: VoiceServerProbeField; message: string };

function isNameList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= VOICE_SERVER_LIMITS.entries &&
    value.every((entry) => isBoundedString(entry, VOICE_SERVER_LIMITS.name) && entry.length > 0)
  );
}

function isOptionalName(value: unknown): value is string | null {
  return value === null || (isBoundedString(value, VOICE_SERVER_LIMITS.name) && value.length > 0);
}

/** A route that is on names its model, and spoken replies also name a voice. */
export function isVoiceServerRoutes(value: unknown): value is VoiceServerRoutes {
  return (
    isDynamicRecord(value) &&
    isBoolean(value.dictation) &&
    isBoolean(value.speech) &&
    isOptionalName(value.transcriptionModel) &&
    isOptionalName(value.speechModel) &&
    isOptionalName(value.voice) &&
    (!value.dictation || value.transcriptionModel !== null) &&
    (!value.speech || (value.speechModel !== null && value.voice !== null))
  );
}

/** Fails closed like `isCustomProviderSummary`: a record that carries an `apiKey` is refused. */
export function isVoiceServerSettings(value: unknown): value is VoiceServerSettings {
  return (
    isDynamicRecord(value) &&
    !("apiKey" in value) &&
    isBoundedString(value.address, VOICE_SERVER_LIMITS.address) &&
    isBoolean(value.hasApiKey) &&
    isVoiceServerRoutes(value.routes)
  );
}

export function isVoiceServerProbe(value: unknown): value is VoiceServerProbe {
  if (!isDynamicRecord(value)) return false;
  if (value.ok === false)
    return (
      isOneOf<VoiceServerProbeField>(["address", "apiKey"], value.field) &&
      isBoundedString(value.message, VOICE_SERVER_LIMITS.message)
    );
  const models = value.models;
  return (
    value.ok === true &&
    isDynamicRecord(models) &&
    isNameList(models.transcription) &&
    isNameList(models.speech) &&
    isNameList(models.voices)
  );
}

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
export interface ScopedVoiceLiveEvent {
  serverId: string;
  event: VoiceLiveEvent;
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
