import { CODEX_LIVE_VOICES, type CodexLiveVoice } from "@tommy/contracts/ipc-voice";
import { useColorScheme } from "react-native";
import { SettingsRow, SettingsSection } from "@/features/settings/components/settings-content";
import { SettingsPicker, SettingsSwitch } from "@/features/settings/components/settings-controls";
import { useText } from "@/shared/lib/text";
import { Txt } from "@/shared/ui/text";
import { liveVoiceWebRtc } from "../model/live-voice-webrtc";
import { saveVoiceSettings, useVoiceSettings } from "../model/voice-settings";

/** An installed native module is required. Older binaries keep their existing speech conversation. */
export function RealtimeVoiceSettings({ onError }: { onError: (message: string) => void }) {
  const { t } = useText();
  const dark = useColorScheme() === "dark";
  const settings = useVoiceSettings();
  if (!liveVoiceWebRtc) return null;
  const save = (change: Parameters<typeof saveVoiceSettings>[0]) => {
    void saveVoiceSettings(change).catch(() => onError(t("mobile.settings.saveFailed")));
  };
  return (
    <SettingsSection
      title={t("mobile.settings.voice.gptLive.title")}
      footer={`${t("mobile.settings.voice.gptLive.footer")} ${t("mobile.settings.voice.gptLive.cost")}`}
    >
      <SettingsRow>
        <SettingsSwitch
          value={settings.conversation === "gpt"}
          disabled={!settings.ready}
          dark={dark}
          label={t("mobile.settings.voice.gptLive.title")}
          onValueChange={(enabled) => save({ conversation: enabled ? "gpt" : "phone" })}
        />
      </SettingsRow>
      {settings.conversation === "gpt" ? (
        <SettingsRow
          trailing={
            <SettingsPicker<CodexLiveVoice | "automatic">
              value={settings.liveVoice ?? "automatic"}
              enabled={settings.ready}
              dark={dark}
              label={t("mobile.settings.voice.voice")}
              options={[
                { value: "automatic", label: t("mobile.settings.voice.gptLive.automatic") },
                ...CODEX_LIVE_VOICES.map((voice) => ({
                  value: voice,
                  label: voice.charAt(0).toUpperCase() + voice.slice(1),
                })),
              ]}
              onChange={(voice) => save({ liveVoice: voice === "automatic" ? null : voice })}
            />
          }
        >
          <Txt>{t("mobile.settings.voice.voice")}</Txt>
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}
