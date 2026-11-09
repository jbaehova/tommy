import { Typography } from "heroui-native";
import { useEffect, useState } from "react";
import { Linking } from "react-native";
import { AgentChoice } from "@/features/agents/components/agent-choice";
import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import { SettingsContent, SettingsRow, SettingsSection } from "@/features/settings/components/settings-content";
import { type MobileAgent, useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { serverStatusLabel, showsOnline } from "@/features/workspace/model/server-status";
import { haptics } from "@/shared/lib/haptics";
import { useText } from "@/shared/lib/text";
import { type AssistantTarget, loadAssistantTarget, saveAssistantTarget } from "../model/assistant-target";

/** Android has no request dialog for this role, so the user picks Tommy in the phone's settings. */
const DEFAULT_APPS_SETTINGS = "android.settings.MANAGE_DEFAULT_APPS_SETTINGS";

function openDefaultApps(): void {
  Linking.sendIntent(DEFAULT_APPS_SETTINGS).catch(() => Linking.openSettings());
}

/** Which agent the phone's assistant action opens, and the way to make Tommy that assistant. */
export function AssistantSettingsScreen() {
  const { t } = useText();
  const { session } = useMobileSession();
  const { agents, servers } = useMobileWorkspace();
  const [selected, setSelected] = useState<AssistantTarget | null>(null);
  const apiUrl = session?.apiUrl;
  const userId = session?.user.id;

  useEffect(() => {
    if (!apiUrl || !userId) return;
    let mounted = true;
    void loadAssistantTarget(apiUrl, userId).then((saved) => {
      // A choice made during the read is newer than the saved one.
      if (mounted) setSelected((current) => current ?? saved);
    });
    return () => {
      mounted = false;
    };
  }, [apiUrl, userId]);

  function select(agent: MobileAgent): void {
    if (!apiUrl || !userId) return;
    const target = { serverId: agent.serverId, agentId: agent.id };
    const previous = selected;
    setSelected(target);
    saveAssistantTarget(apiUrl, userId, target).catch(() => {
      void haptics.notification("error");
      setSelected(previous);
    });
  }

  return (
    <SettingsContent>
      <SettingsSection footer={t("mobile.settings.assistant.footer")}>
        <SettingsRow onPress={openDefaultApps}>
          <Typography.Paragraph>{t("mobile.settings.assistant.openPhoneSettings")}</Typography.Paragraph>
        </SettingsRow>
      </SettingsSection>
      {servers.map((server) => {
        const serverAgents = agents.filter((agent) => agent.serverId === server.id);
        return (
          <SettingsSection
            key={server.id}
            title={server.name}
            footer={showsOnline(server) ? undefined : serverStatusLabel(server, t)}
          >
            {serverAgents.length > 0 ? (
              serverAgents.map((agent) => (
                <AgentChoice
                  key={agent.id}
                  agent={agent}
                  checked={selected?.serverId === agent.serverId && selected.agentId === agent.id}
                  onSelect={select}
                />
              ))
            ) : (
              <SettingsRow disclosure={false}>
                <Typography.Paragraph className="text-grouped-secondary">
                  {server.initialConnectionPending ? serverStatusLabel(server, t) : t("mobile.share.noAgents")}
                </Typography.Paragraph>
              </SettingsRow>
            )}
          </SettingsSection>
        );
      })}
    </SettingsContent>
  );
}
