import { createSignal } from "solid-js";
import { voicePort } from "./voice-port";

/** The OpenAI API key of the server. The app can only learn whether a key is saved. */
export function createSettingsVoiceStore() {
  const [keySaved, setKeySaved] = createSignal<boolean | null>(null);
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<unknown>(null);

  async function read(): Promise<void> {
    setError(null);
    try {
      setKeySaved((await voicePort().voice.getModelStatus()).phase === "ready");
    } catch (failure) {
      setError(failure);
    }
  }

  async function save(key: string | null): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setKeySaved((await voicePort().voice.setApiKey({ key })).phase === "ready");
      setDraft("");
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  return { keySaved, draft, setDraft, busy, error, read, save };
}

export type SettingsVoiceStore = ReturnType<typeof createSettingsVoiceStore>;
