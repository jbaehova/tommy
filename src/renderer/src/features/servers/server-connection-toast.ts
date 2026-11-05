import { toast } from "@tommy/ui";
import { currentText } from "@tommy/ui/text";
import { createEffect, onCleanup } from "solid-js";

/** A connection that comes back within this time, such as after a server restart, shows no notice. */
const OUTAGE_NOTICE_DELAY_MS = 30_000;

/** A retry changes the same notice. Only a workspace that recovered from a shown outage earns a success notice. */
export function createServerConnectionToast(
  read: () => { id: string; name: string; ready: boolean; quiet: boolean } | null,
) {
  let serverId: string | null = null;
  let wasReady = false;
  let outage = false;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const id = () => `server-connection:${serverId}`;
  const restoredId = () => `${id()}:restored`;
  const cancelNotice = () => {
    clearTimeout(noticeTimer);
    noticeTimer = undefined;
  };
  createEffect(read, (value) => {
    if (value?.id !== serverId) {
      cancelNotice();
      toast.dismiss(id());
      toast.dismiss(restoredId());
      serverId = value?.id ?? null;
      wasReady = false;
      outage = false;
    }
    if (!value) return;
    const { t } = currentText();
    if (value.ready) {
      cancelNotice();
      toast.dismiss(id());
      if (outage) toast.success(t("server.connection.restored", { name: value.name }), { id: restoredId() });
      wasReady = true;
      outage = false;
    } else if (value.quiet) {
      cancelNotice();
      outage = false;
      toast.dismiss(id());
    } else if (wasReady && !outage && noticeTimer === undefined) {
      noticeTimer = setTimeout(() => {
        noticeTimer = undefined;
        outage = true;
        toast(t("server.connection.reconnecting", { name: value.name }), {
          id: id(),
          description: t("server.connection.cachedHint"),
          duration: Number.POSITIVE_INFINITY,
        });
      }, OUTAGE_NOTICE_DELAY_MS);
    }
  });
  onCleanup(() => {
    cancelNotice();
    toast.dismiss(id());
    toast.dismiss(restoredId());
  });
}
