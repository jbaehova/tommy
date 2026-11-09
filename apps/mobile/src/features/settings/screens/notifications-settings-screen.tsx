import { useLocalSearchParams } from "expo-router";
import { Typography } from "heroui-native";
import { useState } from "react";
import { Linking } from "react-native";
import { useUniwind } from "uniwind";
import { NotificationMatrix } from "@/features/push-notifications/components/notification-matrix";
import { pushNotificationsNative } from "@/features/push-notifications/push-notifications-native";
import { SettingsContent, SettingsRow, SettingsSection } from "@/features/settings/components/settings-content";
import { SettingsPicker, SettingsSwitch } from "@/features/settings/components/settings-controls";
import {
  savePushNotificationPreference,
  usePushNotificationPreference,
} from "@/features/settings/model/push-notifications";
import { haptics } from "@/shared/lib/haptics";
import { useText } from "@/shared/lib/text";

/**
 * The one place for the notification settings. First what the user hears about from each server and
 * agent, which the host keeps for all of their devices, and the mute of this phone. Then the ways this
 * phone tells the user, and the one sound that they play. Notifications reach the phone through
 * Google. The server settings and the agent settings open this screen with
 * `serverId`, and the agent settings also with `agentId`, to show that server and that agent.
 */
export function NotificationsSettingsScreen() {
  const { t } = useText();
  const { theme } = useUniwind();
  const { serverId, agentId } = useLocalSearchParams<{ serverId?: string; agentId?: string }>();
  const preference = usePushNotificationPreference();
  const [error, setError] = useState<string | null>(null);
  const dark = theme === "dark";
  const busy = !preference.ready || preference.saving;
  const denied = preference.enabled && preference.permission === "denied";
  const soundAvailable = !busy && preference.enabled;

  function save(change: Parameters<typeof savePushNotificationPreference>[0]) {
    setError(null);
    void savePushNotificationPreference(change).catch(() => {
      setError(t("mobile.settings.saveFailed"));
      void haptics.notification("error");
    });
  }

  return (
    <SettingsContent>
      <NotificationMatrix initialServerId={serverId} highlightAgentId={agentId} />
      <SettingsSection
        title={t("mobile.settings.notifications.thisPhone")}
        footer={
          error ??
          (denied
            ? t("mobile.settings.notifications.deniedAndroid")
            : `${t("mobile.settings.notifications.footerAndroid")}\n\n${t("mobile.settings.notifications.previewFooterAndroid")}`)
        }
      >
        <SettingsRow>
          <SettingsSwitch
            value={preference.enabled}
            disabled={busy}
            label={t("mobile.settings.notifications.toggle")}
            dark={dark}
            onValueChange={(enabled) => save({ enabled })}
          />
        </SettingsRow>
        {denied ? (
          <SettingsRow disclosure={false} onPress={() => void Linking.openSettings()}>
            <Typography.Paragraph>{t("mobile.settings.notifications.openSettingsAndroid")}</Typography.Paragraph>
          </SettingsRow>
        ) : null}
        <SettingsRow>
          <SettingsSwitch
            value={preference.preview}
            disabled={busy || !preference.enabled}
            label={t("mobile.settings.notifications.preview")}
            dark={dark}
            onValueChange={(preview) => save({ preview })}
          />
        </SettingsRow>
      </SettingsSection>
      {null}
      <SettingsSection
        title={t("mobile.settings.notifications.sound")}
        footer={t("mobile.settings.notifications.soundFooterAndroid")}
      >
        {/* The hosts get the sound with the notification choices, also with notifications off. */}
        <SettingsRow>
          <SettingsSwitch
            value={preference.playSound}
            disabled={!soundAvailable}
            label={t("mobile.settings.notifications.playSound")}
            dark={dark}
            onValueChange={(playSound) => save({ playSound })}
          />
        </SettingsRow>
        <SettingsRow
          trailing={
            <SettingsPicker
              value={preference.sound}
              options={[
                { value: "tommy", label: t("mobile.settings.notifications.sound.tommy") },
                { value: "warm", label: t("mobile.settings.notifications.sound.warm") },
                { value: "mech", label: t("mobile.settings.notifications.sound.mech") },
                { value: "bubble", label: t("mobile.settings.notifications.sound.bubble") },
                { value: "press", label: t("mobile.settings.notifications.sound.press") },
                {
                  value: "default",
                  label: t("mobile.settings.notifications.sound.defaultAndroid"),
                },
              ]}
              enabled={soundAvailable && preference.playSound}
              dark={dark}
              label={t("mobile.settings.notifications.sound")}
              onChange={(sound) => {
                void haptics.selection();
                save({ sound });
                // Without notification permission the phone plays nothing, as it would for a notification.
                void pushNotificationsNative?.previewSound(sound).catch(() => undefined);
              }}
            />
          }
        >
          <Typography.Paragraph>{t("mobile.settings.notifications.sound")}</Typography.Paragraph>
        </SettingsRow>
      </SettingsSection>
    </SettingsContent>
  );
}
