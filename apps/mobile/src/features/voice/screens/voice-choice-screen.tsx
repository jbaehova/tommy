import { SPEECH_VOICES } from "@tommy/contracts/ipc";
import { Stack } from "expo-router";
import { Button, Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import Check from "lucide-react-native/icons/check";
import Play from "lucide-react-native/icons/play";
import Square from "lucide-react-native/icons/square";
import { View } from "react-native";
import { useCSSVariable } from "uniwind";
import { SettingsContent, SettingsRow, SettingsSection } from "@/features/settings/components/settings-content";
import { haptics } from "@/shared/lib/haptics";
import { useText } from "@/shared/lib/text";
import { useVoicePreview } from "../components/use-voice-preview";
import type { ReplyVoiceChoice } from "../model/reply-voice";
import { useSupertonicModel } from "../model/supertonic-model";
import { saveVoiceSettings, useVoiceSettings } from "../model/voice-settings";
import { supertonicVoiceLabel } from "./voice-settings-screen";

interface VoiceOption {
  id: string;
  title: string;
  selected: boolean;
  choice: ReplyVoiceChoice;
  select: () => Promise<void>;
}

/** Play or Stop for one voice. It is apart from the row, so a press plays the voice and does not choose it. */
function PreviewButton({
  label,
  playing,
  disabled,
  onPress,
}: {
  label: string;
  playing: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const [foreground] = useThemeColor(["foreground"]);
  return (
    <Button isIconOnly size="sm" variant="ghost" accessibilityLabel={label} isDisabled={disabled} onPress={onPress}>
      {playing ? (
        <Square color={String(foreground)} fill={String(foreground)} size={14} />
      ) : (
        <Play color={String(foreground)} fill={String(foreground)} size={16} />
      )}
    </Button>
  );
}

/** The Supertonic voices. A press chooses the voice; the button at the end plays a sample of it. */
export function VoiceChoiceScreen() {
  const { t } = useText();
  const settings = useVoiceSettings();
  const modelReady = useSupertonicModel((state) => state.phase === "ready");
  const preview = useVoicePreview();
  const accent = String(useCSSVariable("--tommy-accent"));
  const options: VoiceOption[] = SPEECH_VOICES.map((voice) => ({
    id: voice,
    title: supertonicVoiceLabel(voice, t),
    selected: settings.supertonicVoice === voice,
    choice: { supertonicVoice: voice },
    select: () => saveVoiceSettings({ supertonicVoice: voice }),
  }));
  return (
    <SettingsContent>
      <Stack.Screen options={{ title: t("mobile.settings.voice.supertonic.title") }} />
      <SettingsSection
        footer={
          preview.error ??
          (modelReady ? t("mobile.settings.voice.choiceFooter") : t("mobile.settings.voice.choiceDownloadFirst"))
        }
      >
        {options.map((option) => (
          <SettingsRow
            key={option.id}
            checked={option.selected}
            disclosure={false}
            trailing={
              <View className="flex-row items-center gap-1">
                {/* A slot of the same width on every row, so the play buttons stay in one column. */}
                <View className="w-6 items-center">
                  {option.selected ? <Check size={18} color={accent} strokeWidth={2} /> : null}
                </View>
                <PreviewButton
                  label={t(
                    preview.playing === option.id
                      ? "mobile.settings.voice.stopVoice"
                      : "mobile.settings.voice.playVoice",
                    { name: option.title },
                  )}
                  playing={preview.playing === option.id}
                  disabled={!modelReady}
                  onPress={() => preview.toggle(option.id, option.choice)}
                />
              </View>
            }
            onPress={() => {
              if (option.selected) return;
              void haptics.selection();
              void option.select();
            }}
          >
            <Typography.Paragraph>{option.title}</Typography.Paragraph>
          </SettingsRow>
        ))}
      </SettingsSection>
    </SettingsContent>
  );
}
