import { useQuery, useQueryClient } from "@tanstack/react-query";
import { canAdministerServer } from "@tommy/contracts/ipc";
import { machineMetricRatio } from "@tommy/contracts/ipc-machine-resources";
import { useIsFocused } from "expo-router";
import { useEffect, useState } from "react";
import { useColorScheme } from "react-native";
import { useQueryScope } from "@/features/auth/context/mobile-session-context";
import { SettingsNote, SettingsRow, SettingsSection } from "@/features/settings/components/settings-content";
import { SettingsSwitch } from "@/features/settings/components/settings-controls";
import {
  useMobileWorkspaceActions,
  useMobileWorkspaceSelector,
} from "@/features/workspace/context/mobile-workspace-context";
import { queryKeys } from "@/features/workspace/model/query-keys";
import { useText } from "@/shared/lib/text";
import { useAppForeground } from "@/shared/lib/use-app-foreground";
import { Txt } from "@/shared/ui/text";

/** Opt in on this page. It never starts a background resource monitor. */
export function ServerMachineResources({ serverId }: { serverId: string }) {
  const { t, format } = useText();
  const dark = useColorScheme() === "dark";
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const { loadMachineMetrics } = useMobileWorkspaceActions();
  const allowed = useMobileWorkspaceSelector(
    (current) =>
      current.canReadMachineResources(serverId) &&
      current.servers.some(
        (server) => server.id === serverId && server.state === "online" && canAdministerServer(server.role),
      ),
  );
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const [shown, setShown] = useState(false);
  const active = allowed && shown && focused && foreground;
  const queryKey = queryKeys.machineResources(queryScope, serverId);
  const metrics = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const value = await loadMachineMetrics(serverId);
      if (signal.aborted) throw new Error(t("mobile.server.resources.failed"));
      return value;
    },
    enabled: active,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: active ? 10_000 : false,
    refetchIntervalInBackground: false,
  });
  useEffect(() => {
    if (active) return;
    void queryClient.cancelQueries({ queryKey: queryKeys.machineResources(queryScope, serverId), exact: true });
    if (!focused || !allowed) setShown(false);
  }, [active, focused, allowed, queryClient, queryScope, serverId]);
  if (!allowed) return null;
  const percent = (metric: "cpu" | "memory" | "disk") => {
    const ratio = metrics.data ? machineMetricRatio(metrics.data, metric) : null;
    return ratio === null ? t("mobile.server.resources.unavailable") : format.percent(ratio);
  };
  return (
    <SettingsSection title={t("mobile.server.resources.title")}>
      <SettingsRow>
        <SettingsSwitch
          value={shown}
          disabled={!focused}
          dark={dark}
          label={t("mobile.server.resources.show")}
          onValueChange={setShown}
        />
      </SettingsRow>
      {active && metrics.data ? (
        <>
          <SettingsRow trailing={<Txt>{percent("cpu")}</Txt>}>
            <Txt>{t("mobile.server.resources.cpu")}</Txt>
          </SettingsRow>
          <SettingsRow trailing={<Txt>{percent("memory")}</Txt>}>
            <Txt>{t("mobile.server.resources.memory")}</Txt>
          </SettingsRow>
          <SettingsRow trailing={<Txt>{percent("disk")}</Txt>}>
            <Txt>{t("mobile.server.resources.disk")}</Txt>
          </SettingsRow>
        </>
      ) : active ? (
        <SettingsNote>
          {t(metrics.isError ? "mobile.server.resources.failed" : "mobile.server.resources.loading")}
        </SettingsNote>
      ) : null}
    </SettingsSection>
  );
}
