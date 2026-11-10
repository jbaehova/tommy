import type { SkillSuggestionEvent } from "@tommy/contracts/ipc-skill-learning";
import { BookOpen, Button } from "@tommy/ui";
import { Show } from "solid-js";
import { useText } from "../../text";
import { ChatActionCard, type ChatActionCardStatus } from "./ChatActionCard";

export type SkillSuggestionState = "ready" | "saving" | "saved" | "skipped" | "failed";

export interface SkillSuggestionCardProps {
  suggestion: SkillSuggestionEvent;
  state: SkillSuggestionState;
  enabled: boolean;
  error?: string | null;
  onSave(): void;
  onSkip?(): void;
}

/** The host supplies the proposal. Save names that message, never model text or a file path. */
export function SkillSuggestionCard(props: SkillSuggestionCardProps) {
  const { t } = useText();
  const status = (): ChatActionCardStatus | undefined => {
    if (props.state === "saved") return { kind: "done", text: t("chat.skillSuggestion.saved") };
    if (props.state === "skipped") return { kind: "note", text: t("chat.skillSuggestion.skipped") };
    if (!props.enabled) return { kind: "note", text: t("chat.skillSuggestion.off") };
    if (props.state === "saving") return { kind: "busy", text: t("chat.skillSuggestion.saving") };
    if (props.state === "failed") return { kind: "error", text: props.error || t("chat.skillSuggestion.failed") };
    return undefined;
  };
  return (
    <ChatActionCard
      icon={<BookOpen aria-hidden="true" />}
      eyebrow={t(
        props.suggestion.action === "update" ? "chat.skillSuggestion.updateTitle" : "chat.skillSuggestion.title",
      )}
      title={props.suggestion.skillName}
      status={status()}
      class="skill-suggestion-card"
    >
      <p class="skill-suggestion-question">{props.suggestion.question}</p>
      <Show when={props.state !== "saved" && props.state !== "skipped"}>
        <div class="skill-suggestion-actions">
          <Button
            type="button"
            size="sm"
            disabled={!props.enabled}
            loading={props.state === "saving"}
            loadingLabel={t("chat.skillSuggestion.saving")}
            onClick={() => props.onSave()}
          >
            {t("chat.skillSuggestion.save")}
          </Button>
          <Show when={props.onSkip}>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={props.state === "saving"}
              onClick={() => props.onSkip?.()}
            >
              {t("chat.skillSuggestion.skip")}
            </Button>
          </Show>
        </div>
      </Show>
    </ChatActionCard>
  );
}
