import { IconButton, Mic, Popover } from "@tommy/ui";
import { LiveVoicePanel } from "@tommy/ui/features/conversation/LiveVoicePanel";
import { useText } from "@tommy/ui/text";
import { createEffect, createSignal, Show } from "solid-js";
import { useConversationViewScope } from "./conversation-scope";

/** Opening the controls does not request microphone access. Start is an explicit action. */
export function ConversationLiveVoice() {
  const { t } = useText();
  const { props, liveVoice, liveVoiceChoice, setLiveVoiceChoice, voicePhase, sideThreadOpen, liveVoiceActive } =
    useConversationViewScope();
  const [open, setOpen] = createSignal(false);
  createEffect(liveVoice, () => {
    setOpen(false);
  });
  const available = () =>
    voicePhase() === "idle" &&
    !sideThreadOpen() &&
    !props.workspaceCovered &&
    (props.server?.kind === "local" || props.server?.state === "online");
  function changeOpen(value: boolean): void {
    if (!value && liveVoiceActive()) return;
    setOpen(value);
  }
  return (
    <Show when={liveVoice()}>
      {(call) => (
        <Popover.Root open={open()} onOpenChange={changeOpen} placement="bottom-end">
          <Popover.Trigger as={IconButton} variant="ghost" label={t("conversation.liveVoice.title")}>
            <Mic aria-hidden="true" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content class="ui-popover-menu-surface conversation-live-voice-popover">
              <LiveVoicePanel
                phase={call().phase()}
                muted={call().muted()}
                heard={call().heard()}
                said={call().said()}
                error={call().error()}
                levels={call().levels()}
                available={available()}
                voice={liveVoiceChoice()}
                onVoiceChange={setLiveVoiceChoice}
                onStart={() => {
                  if (available()) void call().start();
                }}
                onEnd={() => call().end()}
                onToggleMute={() => call().toggleMute()}
                onInterrupt={() => call().interrupt()}
              />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
    </Show>
  );
}
