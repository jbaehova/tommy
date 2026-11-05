import type { ServerConnectionState, ServerSummary } from "@tommy/contracts/ipc";
import type { AppTextKey, AppTranslate } from "@tommy/i18n";
import { ServerGradientLogo } from "@tommy/ui";
import { createEffect, createSignal, Show } from "solid-js";

const SERVER_STATE_LABELS = {
  online: "server.state.online",
  connecting: "server.state.connecting",
  offline: "server.state.offline",
  error: "server.state.error",
  incompatible: "server.state.incompatible",
} as const satisfies Record<ServerConnectionState, AppTextKey>;

export function serverStatusLabels(
  server: Pick<ServerSummary, "notificationsMuted" | "state">,
  t: AppTranslate,
): string[] {
  return [
    ...(server.notificationsMuted ? [t("server.rail.notificationsMuted")] : []),
    ...(server.state === "online" ? [] : [t(SERVER_STATE_LABELS[server.state])]),
  ];
}

export function ServerMark(props: { server: Pick<ServerSummary, "id" | "logoUrl"> }) {
  const [failed, setFailed] = createSignal(false);
  createEffect(
    () => props.server.logoUrl,
    () => {
      setFailed(false);
    },
  );
  return (
    <Show when={!failed() ? props.server.logoUrl : null} fallback={<ServerGradientLogo seed={props.server.id} />}>
      {(url) => <img class="server-rail-logo" src={url()} alt="" draggable={false} onError={() => setFailed(true)} />}
    </Show>
  );
}
