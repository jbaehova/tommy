import { type Href, router } from "expo-router";
import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import type { LucideIcon } from "lucide-react-native";
import Bell from "lucide-react-native/icons/bell";
import EyeOff from "lucide-react-native/icons/eye-off";
import Globe from "lucide-react-native/icons/globe";
import Info from "lucide-react-native/icons/info";
import LifeBuoy from "lucide-react-native/icons/life-buoy";
import Lock from "lucide-react-native/icons/lock";
import Mic from "lucide-react-native/icons/mic";
import Palette from "lucide-react-native/icons/palette";
import Server from "lucide-react-native/icons/server";
import Smartphone from "lucide-react-native/icons/smartphone";
import Sparkles from "lucide-react-native/icons/sparkles";
import Vibrate from "lucide-react-native/icons/vibrate";
import Workflow from "lucide-react-native/icons/workflow";
import { SettingsContent, SettingsRow, SettingsSection } from "@/features/settings/components/settings-content";
import { useMobileWorkspaceSelector } from "@/features/workspace/context/workspace-store";
import { useText } from "@/shared/lib/text";

function NavRow({ icon: Icon, title, hint, href }: { icon: LucideIcon; title: string; hint?: string; href: Href }) {
  const secondary = String(useThemeColor("muted"));
  return (
    <SettingsRow
      leading={<Icon color={secondary} size={18} strokeWidth={1.8} />}
      supportingText={hint}
      onPress={() => router.push(href)}
    >
      <Typography.Paragraph>{title}</Typography.Paragraph>
    </SettingsRow>
  );
}

export function SettingsScreen() {
  const { t } = useText();
  const serverId = useMobileWorkspaceSelector((current) => current.activeServer.id);
  return (
    <SettingsContent>
      <SettingsSection>
        <NavRow
          icon={Server}
          title={t("mobile.server.drawer.serverSettings")}
          href={{ pathname: "/server-settings", params: { serverId } }}
        />
        <NavRow
          icon={Workflow}
          title={t("mobile.app.route.workflows")}
          href={{ pathname: "/server-workflows", params: { serverId } }}
        />
      </SettingsSection>
      <SettingsSection title={t("mobile.settings.home.preferences")}>
        <NavRow icon={Palette} title={t("mobile.settings.appearance.title")} href="/settings/appearance" />
        <NavRow icon={Sparkles} title={t("mobile.settings.animations.title")} href="/settings/animations" />
        <NavRow icon={Globe} title={t("mobile.settings.language.title")} href="/settings/language" />
        <NavRow icon={Mic} title={t("mobile.settings.voice.title")} href="/settings/voice" />
        <NavRow icon={Smartphone} title={t("mobile.settings.assistant.title")} href="/settings/assistant" />
        <NavRow icon={Vibrate} title={t("mobile.settings.feedback.haptics")} href="/settings/haptics" />
        <NavRow icon={Bell} title={t("mobile.settings.notifications.title")} href="/settings/notifications" />
        <NavRow icon={Lock} title={t("mobile.appLock.title")} href="/settings/app-lock" />
        <NavRow icon={EyeOff} title={t("mobile.settings.conversations.hiddenChats")} href="/settings/hidden-chats" />
      </SettingsSection>
      <SettingsSection>
        <NavRow icon={LifeBuoy} title={t("mobile.settings.home.support")} href="/settings/support" />
        <NavRow icon={Info} title={t("mobile.settings.home.about")} href="/settings/about" />
      </SettingsSection>
    </SettingsContent>
  );
}
