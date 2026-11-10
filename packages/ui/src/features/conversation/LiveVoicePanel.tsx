import { CODEX_LIVE_VOICES, type CodexLiveVoice } from "@tommy/contracts/ipc-voice";
import { Button, Mic, MicOff, SearchSelect, Square } from "@tommy/ui";
import { useText } from "@tommy/ui/text";
import { For, Show } from "solid-js";

export type LiveVoicePhase = "idle" | "starting" | "listening" | "thinking" | "speaking" | "failed";
export interface LiveVoicePanelProps {
  phase: LiveVoicePhase;
  muted: boolean;
  heard: string;
  said: string;
  error: string | null;
  levels: readonly number[];
  available: boolean;
  voice?: CodexLiveVoice | null;
  onVoiceChange?: (voice: CodexLiveVoice | null) => void;
  onStart: () => void;
  onEnd: () => void;
  onToggleMute: () => void;
  /** Silences the reply; it does not cancel the agent's work. */
  onInterrupt: () => void;
}
const VOICES = ["automatic", ...CODEX_LIVE_VOICES] as const;

/** Reusable call controls. The consumer supplies the host transport and its permission gate. */
export function LiveVoicePanel(props: LiveVoicePanelProps) {
  const { t } = useText();
  const active = () => props.phase !== "idle" && props.phase !== "failed";
  const phase = () => {
    if (props.muted && active()) return t("conversation.liveVoice.muted");
    switch (props.phase) {
      case "starting":
        return t("conversation.liveVoice.starting");
      case "listening":
        return t("conversation.liveVoice.listening");
      case "thinking":
        return t("conversation.liveVoice.thinking");
      case "speaking":
        return t("conversation.liveVoice.speaking");
      default:
        return t("conversation.liveVoice.title");
    }
  };
  return (
    <section class="live-voice-panel" aria-label={t("conversation.liveVoice.title")}>
      <div class="live-voice-panel-heading">
        <Mic aria-hidden="true" />
        <strong>{phase()}</strong>
      </div>
      <p class="live-voice-panel-notice">{t("conversation.liveVoice.notice")}</p>
      <Show when={props.onVoiceChange}>
        <SearchSelect<(typeof VOICES)[number]>
          options={[...VOICES]}
          value={props.voice ?? "automatic"}
          label={(voice) =>
            voice === "automatic"
              ? t("conversation.liveVoice.defaultVoice")
              : voice.charAt(0).toUpperCase() + voice.slice(1)
          }
          onChange={(voice) => props.onVoiceChange?.(voice === "automatic" ? null : voice)}
          disabled={active()}
          aria-label={t("conversation.liveVoice.voice")}
          size="sm"
        />
      </Show>
      <Show when={active()}>
        <div class="live-voice-panel-levels" aria-hidden="true">
          <For each={props.levels} keyed={false}>
            {(level) => <span style={{ "--live-voice-level": Math.min(1, Math.max(0, level())) }} />}
          </For>
        </div>
        <div class="live-voice-panel-transcript" aria-live="polite" aria-atomic="true">
          {props.phase === "speaking" ? props.said : props.heard}
        </div>
      </Show>
      <Show when={props.error}>
        <p class="live-voice-panel-error" role="alert">
          {props.error}
        </p>
      </Show>
      <div class="live-voice-panel-controls">
        <Show
          when={active()}
          fallback={
            <Button size="sm" disabled={!props.available} onClick={() => props.onStart()}>
              <Mic aria-hidden="true" />
              {t("conversation.liveVoice.start")}
            </Button>
          }
        >
          <Button
            variant="secondary"
            size="sm"
            aria-pressed={props.muted ? "true" : "false"}
            onClick={() => props.onToggleMute()}
          >
            {props.muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
            {props.muted ? t("conversation.liveVoice.unmute") : t("conversation.liveVoice.mute")}
          </Button>
          <Show when={props.phase === "speaking" || props.phase === "thinking"}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => props.onInterrupt()}
              title={t("conversation.liveVoice.silenceHint")}
            >
              {t("conversation.liveVoice.silence")}
            </Button>
          </Show>
          <Button variant="destructive-ghost" size="sm" onClick={() => props.onEnd()}>
            <Square aria-hidden="true" />
            {t("conversation.liveVoice.end")}
          </Button>
        </Show>
      </div>
    </section>
  );
}
