import type { MachineMetrics } from "@tommy/contracts/ipc";
import { Switch } from "@tommy/ui";
import { MachineResources } from "@tommy/ui/features/files/MachineResources";
import { useText } from "@tommy/ui/text";
import { createEffect, createMemo, createStore, createUniqueId, Show } from "solid-js";
import { serverCanAdminister } from "../servers/server-capabilities";
import { useServers } from "../servers/servers-context";
import type { UsagePort } from "./usage-port";

/** No resource sampling starts until an administrator opts in for this open report. */
export function UsageMachineResources(props: { serverId: string; port: UsagePort }) {
  const { t, errorMessage } = useText();
  const resourcesSwitchId = createUniqueId();
  const { servers } = useServers();
  const [state, setState] = createStore<{
    serverId: string;
    enabled: boolean;
    metrics: MachineMetrics | null;
    error: string | null;
  }>({ serverId: props.serverId, enabled: false, metrics: null, error: null });
  const server = () => servers().find((entry) => entry.id === props.serverId);
  const available = () =>
    serverCanAdminister(server(), "machine-resources-v1") && !!props.port.storage && !!props.port.hostAdmin;
  createEffect(
    () => props.serverId,
    (serverId) =>
      setState((draft) => {
        draft.serverId = serverId;
        draft.enabled = false;
        draft.metrics = null;
        draft.error = null;
      }),
  );
  const samplingScope = createMemo(
    () => ({
      serverId: props.serverId,
      enabled: state.serverId === props.serverId && state.enabled && available(),
      online: server()?.kind === "local" || server()?.state === "online",
      read: props.port.storage?.getMachineMetrics,
    }),
    {
      equals: (before, after) =>
        before.serverId === after.serverId &&
        before.enabled === after.enabled &&
        before.online === after.online &&
        before.read === after.read,
    },
  );
  createEffect(samplingScope, ({ serverId, enabled, online, read }) => {
    setState((draft) => {
      draft.metrics = null;
      draft.error = null;
    });
    if (!enabled || !online || !read) return;
    const readMetrics = read;
    let current = true;
    let loading = false;
    async function refresh(): Promise<void> {
      if (!current || loading || document.hidden) return;
      loading = true;
      try {
        const metrics = await readMetrics(serverId);
        if (current)
          setState((draft) => {
            draft.metrics = metrics;
            draft.error = null;
          });
      } catch (error) {
        if (current)
          setState((draft) => {
            draft.error = errorMessage(error, t("files.machine.readFailed"));
          });
      } finally {
        loading = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    const visibility = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  });
  return (
    <Show when={available()}>
      <section class="usage-machine-resources">
        <label class="usage-machine-resources-toggle" for={resourcesSwitchId}>
          <span>{t("usage.panel.showResources")}</span>
          <Switch
            id={resourcesSwitchId}
            checked={state.serverId === props.serverId && state.enabled}
            onChange={(enabled) =>
              setState((draft) => {
                draft.enabled = enabled;
              })
            }
          />
        </label>
        <Show when={state.serverId === props.serverId && state.enabled}>
          <MachineResources
            metrics={state.metrics}
            error={state.error}
            alerts={null}
            members={[]}
            onChangeAlerts={async (settings) => {
              await props.port.hostAdmin?.setMachineAlerts(settings, props.serverId);
            }}
          />
        </Show>
      </section>
    </Show>
  );
}
