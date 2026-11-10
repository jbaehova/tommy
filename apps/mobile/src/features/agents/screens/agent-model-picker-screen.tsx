import { useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import Check from "lucide-react-native/icons/check";
import { useEffect, useState } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { useCSSVariable } from "uniwind";
import { useAgentModelPicker } from "@/features/agents/model/agent-model-picker";
import { useQueryScope } from "@/features/auth/context/mobile-session-context";
import {
  SettingsContent,
  SettingsNote,
  SettingsRow,
  SettingsSection,
} from "@/features/settings/components/settings-content";
import { useMobileWorkspaceActions } from "@/features/workspace/context/mobile-workspace-context";
import { queryKeys } from "@/features/workspace/model/query-keys";
import { SheetFormField } from "@/shared/components/sheet-form-field";
import { haptics } from "@/shared/lib/haptics";
import { useText } from "@/shared/lib/text";
import { Txt } from "@/shared/ui/text";

/** The page adds this many rows at a time, so a provider with hundreds of models opens at once. */
const PAGE_SIZE = 100;
/** The next rows come when the reader is this close to the end. */
const END_DISTANCE = 600;

/**
 * Agent settings > Model, and Create agent > Model: the models of the chosen provider, with a search.
 * A page, not a menu: a menu does not filter, and OpenRouter lists hundreds of models.
 */
export function AgentModelPickerScreen() {
  const { t } = useText();
  const accent = String(useCSSVariable("--tommy-accent"));
  const workspace = useMobileWorkspaceActions();
  const queryScope = useQueryScope();
  const request = useAgentModelPicker((state) => state.request);
  const close = useAgentModelPicker((state) => state.close);
  useEffect(
    () => () => {
      if (request) close(request);
    },
    [request, close],
  );
  const [search, setSearch] = useState("");
  const serverId = request?.serverId ?? "";
  // The same query as the Model row, so the list shows at once from its cache.
  const models = useQuery({
    queryKey: queryKeys.agentModels(queryScope, serverId),
    queryFn: () => workspace.loadAgentModels(serverId),
    enabled: request !== null && request.models === undefined,
    retry: false,
  });
  const [limit, setLimit] = useState(PAGE_SIZE);
  // Only the Model row opens the page. Without its request there is no form to give the pick to.
  useEffect(() => {
    if (!request && router.canGoBack()) router.back();
  }, [request]);
  const words = search.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const options = request?.models ?? models.data?.filter((option) => option.provider === request?.provider) ?? [];
  // The search also reads the model id, as the backup model search does.
  const matches = options.filter((option) => {
    const text = `${option.name} ${option.id}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const changeSearch = (text: string) => {
    setSearch(text);
    setLimit(PAGE_SIZE);
  };
  function onScroll({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) {
    const end = nativeEvent.contentSize.height - nativeEvent.layoutMeasurement.height - nativeEvent.contentOffset.y;
    if (end < END_DISTANCE && limit < matches.length) setLimit((current) => current + PAGE_SIZE);
  }

  return (
    <SettingsContent onScroll={onScroll}>
      <Stack.Screen options={{ title: t("mobile.agent.runtime.model") }} />
      <SheetFormField
        label={t("mobile.agent.runtime.searchModels")}
        hideLabel
        appearance="soft"
        placeholder={t("mobile.agent.runtime.searchModels")}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        value={search}
        onChangeText={changeSearch}
      />
      {!request ? null : request.models === undefined && models.isError ? (
        <SettingsSection>
          <SettingsRow disclosure={false} onPress={() => void models.refetch()}>
            <Txt>{t("mobile.agent.runtime.retryModels")}</Txt>
          </SettingsRow>
        </SettingsSection>
      ) : request.models === undefined && models.isPending ? (
        <SettingsNote>{t("mobile.agent.runtime.loadingModels")}</SettingsNote>
      ) : options.length === 0 ? (
        <SettingsNote>{t("mobile.agent.runtime.noModels")}</SettingsNote>
      ) : matches.length === 0 ? (
        <SettingsNote>{t("mobile.agent.runtime.noMatches")}</SettingsNote>
      ) : (
        <SettingsSection>
          {matches.slice(0, limit).map((option) => {
            const on = option.id === request.model;
            return (
              <SettingsRow
                key={option.id}
                checked={on}
                disclosure={false}
                supportingText={option.name === option.id ? undefined : option.id}
                trailing={on ? <Check size={18} color={accent} strokeWidth={2} /> : null}
                onPress={() => {
                  void haptics.selection();
                  request.choose(option);
                  router.back();
                }}
              >
                <Txt numberOfLines={2}>{option.name}</Txt>
              </SettingsRow>
            );
          })}
        </SettingsSection>
      )}
    </SettingsContent>
  );
}
