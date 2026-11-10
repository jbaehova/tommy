import { ConfirmDialog, IconButton, Trash2 } from "@tommy/ui";
import { useText } from "@tommy/ui/text";
import { Show } from "solid-js";
import { useConversationViewScope } from "./conversation-scope";

export function ConversationHistoryActions() {
  const { t } = useText();
  const { messageDeletion, sideThreadOpen } = useConversationViewScope();
  const history = () => messageDeletion.state.request?.kind === "history";
  return (
    <>
      <Show when={messageDeletion.historyAvailable() && !sideThreadOpen()}>
        <IconButton
          variant="ghost"
          label={t("chat.delete.history")}
          disabled={messageDeletion.busy() || messageDeletion.state.pending}
          onClick={messageDeletion.requestHistory}
        >
          <Trash2 aria-hidden="true" />
        </IconButton>
      </Show>
      <ConfirmDialog
        open={messageDeletion.state.request !== null}
        title={t(history() ? "chat.delete.historyTitle" : "chat.delete.messageTitle")}
        description={t(history() ? "chat.delete.historyDescription" : "chat.delete.messageDescription")}
        confirmLabel={t(history() ? "chat.delete.history" : "chat.delete.message")}
        pending={messageDeletion.state.pending}
        error={messageDeletion.state.error ?? undefined}
        onCancel={messageDeletion.cancel}
        onConfirm={messageDeletion.confirm}
      />
    </>
  );
}
