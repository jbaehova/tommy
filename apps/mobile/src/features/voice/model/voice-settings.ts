import { type CodexLiveVoice, isCodexLiveVoice, isSpeechVoice, type SpeechVoice } from "@tommy/contracts/ipc";
import { isDynamicRecord } from "@tommy/contracts/runtime-values";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

/**
 * What recognizes the user's speech. The server is the default: it streams the audio to OpenAI with
 * its own key. The phone's recognizer needs no server and hears one language. Parakeet runs on the
 * phone and finds the language itself.
 */
export type RecognitionEngine = "system" | "parakeet" | "host";

const RECOGNITION_ENGINES: readonly RecognitionEngine[] = ["system", "parakeet", "host"];
const isRecognitionEngine = (value: unknown): value is RecognitionEngine =>
  RECOGNITION_ENGINES.some((engine) => engine === value);

export type ConversationVoiceMode = "phone" | "gpt";

interface VoiceSettings {
  conversation: ConversationVoiceMode;
  liveVoice: CodexLiveVoice | null;
  recognition: RecognitionEngine;
  supertonicVoice: SpeechVoice;
}

const DEFAULT_SETTINGS: VoiceSettings = {
  conversation: "phone",
  liveVoice: null,
  recognition: "host",
  supertonicVoice: "F1",
};

const SETTINGS_KEY = "tommy.mobile.voice-settings.v1";
/** An earlier version kept an ElevenLabs key here. It is removed at the first start. */
const RETIRED_ELEVENLABS_KEY = "tommy.mobile.elevenlabs-key.v1";

export const useVoiceSettings = create<VoiceSettings & { ready: boolean }>(() => ({
  ...DEFAULT_SETTINGS,
  ready: false,
}));

/** A stored value from an earlier version or a damaged entry falls back to the defaults, field by field. */
function decodeSettings(raw: string | null): VoiceSettings {
  if (!raw) return DEFAULT_SETTINGS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (!isDynamicRecord(value)) return DEFAULT_SETTINGS;
  return {
    conversation: value.conversation === "gpt" ? "gpt" : "phone",
    liveVoice: isCodexLiveVoice(value.liveVoice) ? value.liveVoice : null,
    recognition: isRecognitionEngine(value.recognition) ? value.recognition : DEFAULT_SETTINGS.recognition,
    supertonicVoice: isSpeechVoice(value.supertonicVoice) ? value.supertonicVoice : DEFAULT_SETTINGS.supertonicVoice,
  };
}

export async function loadVoiceSettings(): Promise<void> {
  if (useVoiceSettings.getState().ready) return;
  try {
    void SecureStore.deleteItemAsync(RETIRED_ELEVENLABS_KEY).catch(() => undefined);
    const settings = await SecureStore.getItemAsync(SETTINGS_KEY);
    // A second startup read must not overwrite a change made in Settings.
    if (!useVoiceSettings.getState().ready) useVoiceSettings.setState(decodeSettings(settings));
  } finally {
    useVoiceSettings.setState({ ready: true });
  }
}

/** Applies at once, also when storage fails; the caller reports the failure. */
export async function saveVoiceSettings(change: Partial<VoiceSettings>): Promise<void> {
  const { recognition, supertonicVoice, conversation, liveVoice } = { ...useVoiceSettings.getState(), ...change };
  const settings = { recognition, supertonicVoice, conversation, liveVoice };
  useVoiceSettings.setState(settings);
  await SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(settings));
}
