import type { WorkflowNode } from "@tommy/contracts/ipc";
import { SettingsRow, SettingsSection } from "@/features/settings/components/settings-content";
import { useText } from "@/shared/lib/text";
import { Txt } from "@/shared/ui/text";

/** A phone shows the saved host connection fields without offering an unimplemented picker. */
export function SavedWorkflowIntegration({ node }: { node: WorkflowNode }) {
  const { t } = useText();
  const text = (name: string): string => {
    const value = node.fields[name];
    return typeof value === "string" ? value : "";
  };
  const kind = node.kind === "trigger" ? text("trigger") : text("target");
  const title =
    kind === "slack"
      ? t("mobile.workflow.output.slack")
      : kind === "telegram"
        ? t("mobile.workflow.output.telegram")
        : t("mobile.workflow.output.tommyChannel");
  const action = text("action");
  const rows = [
    ...(kind === "chat-channel"
      ? []
      : [
          {
            label: t("mobile.workflow.integration.connection"),
            value:
              text("connectionId") === "trigger"
                ? t("mobile.workflow.integration.sameMessage")
                : text("connectionId") || t("mobile.workflow.integration.any"),
          },
        ]),
    {
      label: t("mobile.workflow.integration.channel"),
      value: text("channelId") || text("placeId") || t("mobile.workflow.integration.any"),
    },
    ...(node.kind === "trigger"
      ? [
          {
            label: t("mobile.workflow.integration.filter"),
            value: text("text") || t("mobile.workflow.integration.any"),
          },
        ]
      : kind === "chat-channel"
        ? []
        : [
            {
              label: t("mobile.workflow.integration.action"),
              value:
                action === "post"
                  ? t("mobile.workflow.integration.action.post")
                  : action === "react"
                    ? t("mobile.workflow.integration.action.react")
                    : t("mobile.workflow.integration.action.reply"),
            },
          ]),
    ...(action === "react" && text("emoji")
      ? [{ label: t("mobile.workflow.discord.emoji"), value: text("emoji") }]
      : []),
  ];
  return (
    <SettingsSection title={title} footer={t("mobile.workflow.integration.hostOnly")}>
      {rows.map((row) => (
        <SettingsRow
          key={row.label}
          trailing={
            <Txt tone="secondary" numberOfLines={1}>
              {row.value}
            </Txt>
          }
        >
          <Txt>{row.label}</Txt>
        </SettingsRow>
      ))}
    </SettingsSection>
  );
}
