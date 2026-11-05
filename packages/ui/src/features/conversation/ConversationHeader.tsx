import type { ComponentProps, JSX } from "@solidjs/web";
import { Badge, Button, Clock3, Lock } from "@tommy/ui";
import { ProviderModelPicker } from "@tommy/ui/components/ProviderModelPicker";
import type { AgentProfile } from "@tommy/ui/data";
import { AgentAvatar } from "@tommy/ui/features/agents/AgentAvatar";
import { agentAccessLockLabel } from "@tommy/ui/features/agents/agent-access";
import { SidePanelToggle, type SidePanelToggleProps } from "@tommy/ui/features/conversation/SidePanel";
import { useText } from "@tommy/ui/text";
import { Show } from "solid-js";

export interface ConversationHeaderProps {
  agent: AgentProfile | null | undefined;
  /** The title of a chat that has no one agent, such as a channel. It shows when `agent` is missing. */
  title?: JSX.Element | undefined;
  modelPicker: ComponentProps<typeof ProviderModelPicker>;
  /** A model, effort, provider or account chosen during the running turn. It applies from the next turn. */
  pendingModel?: ConversationHeaderPendingModel | undefined;
  onSettingsIntent: () => void;
  onOpenSettings: () => void;
  /** Set while a side thread is open: the agent's name then opens the agent's own chat, not its settings. */
  onOpenChat?: (() => void) | undefined;
  /** Missing when the chat has no side panel, such as a deleted channel. */
  sidePanel?: SidePanelToggleProps | undefined;
  /** The thread tabs of the agent, after its name. */
  threads?: JSX.Element | undefined;
  /**
   * Set when the agent has thread tabs: the agent's name is then the first tab, for the agent's own
   * chat, and is selected while that chat is open.
   */
  titleSelected?: boolean | undefined;
}

export interface ConversationHeaderPendingModel {
  /** The model, and the effort when it changes too, of the running turn. */
  running: string;
  /** The same for the next turn. */
  next: string;
}

export function ConversationHeader(props: ConversationHeaderProps) {
  const { t } = useText();
  const titleTab = () => (props.titleSelected === undefined ? undefined : "");
  const titleSelected = () => (props.titleSelected ? "" : undefined);
  return (
    <header class="window-drag conversation-header">
      <div class="conversation-heading-group">
        <Show when={props.agent} fallback={props.title}>
          {(agent) => (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              class="conversation-title no-drag"
              data-tab={titleTab()}
              data-selected={titleSelected()}
              aria-label={props.onOpenChat ? t("conversation.header.mainChat") : t("conversation.header.settings")}
              onPointerEnter={() => props.onOpenChat || props.onSettingsIntent()}
              onFocus={() => props.onOpenChat || props.onSettingsIntent()}
              onClick={() => (props.onOpenChat ?? props.onOpenSettings)()}
            >
              <AgentAvatar agent={agent()} />
              <h1>{agent().name}</h1>
            </Button>
          )}
        </Show>
        <Show when={props.agent && agentAccessLockLabel(props.agent, t)}>
          {(label) => (
            <span class="conversation-access-lock" role="img" aria-label={label()} title={label()}>
              <Lock aria-hidden="true" />
            </span>
          )}
        </Show>
        {props.threads}
      </div>
      <div class="conversation-header-actions no-drag">
        <Show when={props.agent && props.pendingModel}>
          {(change) => {
            const detail = () => t("conversation.header.modelNextTurnDetail", change());
            return (
              <Badge variant="info-light" class="conversation-model-pending" role="status" title={detail()}>
                <Clock3 aria-hidden="true" />
                {t("conversation.header.modelNextTurn")}
                <span class="sr-only">{detail()}</span>
              </Badge>
            );
          }}
        </Show>
        <Show when={props.agent}>
          <ProviderModelPicker {...props.modelPicker} />
        </Show>
        <Show when={props.sidePanel}>{(sidePanel) => <SidePanelToggle {...sidePanel()} />}</Show>
      </div>
    </header>
  );
}
