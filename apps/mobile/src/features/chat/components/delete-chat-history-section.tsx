import { SettingsRow, SettingsSection } from "@/features/settings/components/settings-content";
import { useText } from "@/shared/lib/text";
import { Txt } from "@/shared/ui/text";
import { useChatDeletion } from "./use-chat-deletion";

/** Agent setup and side threads stay. The confirmation states the shared history scope. */
export function DeleteChatHistorySection(input: { serverId: string; agentId?: string; channelId?: string }) {
  const { t } = useText();
  const deletion = useChatDeletion(input);
  if (!deletion.canDeleteHistory) return null;
  return (
    <SettingsSection>
      <SettingsRow disclosure={false} disabled={deletion.pending} onPress={deletion.deleteHistory}>
        <Txt tone="danger">{t("mobile.chat.delete.history")}</Txt>
      </SettingsRow>
    </SettingsSection>
  );
}
