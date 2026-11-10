import {
  type HostSkillLearning,
  isSkillLearningMode,
  type SkillLearningPreference,
} from "@tommy/contracts/ipc-skill-learning";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@tommy/ui";
import { useText } from "@tommy/ui/text";
import { createEffect, createStore, Show, untrack } from "solid-js";

export interface SkillLearningSettingsCalls {
  get(serverId?: string): Promise<HostSkillLearning>;
  set(input: SkillLearningPreference, serverId?: string): Promise<HostSkillLearning>;
}

export interface ServerSkillLearningOptions {
  calls?: SkillLearningSettingsCalls;
}

/** This preference belongs to the selected host. Its default is Ask first. */
export function ServerSkillLearningSetting(
  props: ServerSkillLearningOptions & {
    serverId: string;
    disabled: boolean;
    menuMount: HTMLElement | undefined;
    run: (key: string, action: () => Promise<void>) => Promise<boolean>;
  },
) {
  const { t, errorMessage } = useText();
  const calls = (): SkillLearningSettingsCalls => props.calls ?? window.tommy.skillLearning;
  const [state, setState] = createStore<{ settings: HostSkillLearning | null; error: string | null }>({
    settings: null,
    error: null,
  });
  let generation = 0;
  createEffect(
    () => ({ serverId: props.serverId, calls: calls() }),
    ({ serverId, calls }) => {
      const request = ++generation;
      setState((draft) => {
        draft.settings = null;
        draft.error = null;
      });
      calls.get(serverId).then(
        (settings) => {
          if (request === generation)
            setState((draft) => {
              draft.settings = settings;
            });
        },
        (error: unknown) => {
          if (request === generation)
            setState((draft) => {
              draft.error = errorMessage(error, t("server.settings.skillLearningLoadFailed"));
            });
        },
      );
      return () => {
        generation += 1;
      };
    },
  );
  const label = (mode: string | null) => {
    if (mode === "ask") return t("server.settings.skillLearningAsk");
    if (mode === "automatic") return t("server.settings.skillLearningAutomatic");
    if (mode === "off") return t("server.settings.skillLearningOff");
    return mode ?? "";
  };
  function choose(mode: string | null): void {
    if (!isSkillLearningMode(mode) || mode === state.settings?.mode) return;
    const request = generation;
    const serverId = props.serverId;
    const api = untrack(calls);
    void props.run("skillLearning", async () => {
      const settings = await api.set({ mode }, serverId);
      if (request === generation)
        setState((draft) => {
          draft.settings = settings;
        });
    });
  }
  return (
    <Item>
      <ItemContent>
        <ItemTitle id="server-settings-skill-learning-label">{t("server.settings.skillLearning")}</ItemTitle>
        <ItemDescription>{state.error ?? t("server.settings.skillLearningDescription")}</ItemDescription>
      </ItemContent>
      <Show when={state.settings}>
        {(settings) => (
          <ItemActions>
            <Select<string>
              options={
                settings().choices.includes(settings().mode)
                  ? settings().choices
                  : [settings().mode, ...settings().choices]
              }
              value={settings().mode}
              disabled={props.disabled}
              placement="bottom-end"
              onChange={choose}
              itemComponent={(item) => <SelectItem item={item.item}>{label(item.item.rawValue)}</SelectItem>}
            >
              <SelectTrigger size="sm" aria-labelledby="server-settings-skill-learning-label">
                <SelectValue<string>>{(select) => label(select.selectedOption() ?? null)}</SelectValue>
              </SelectTrigger>
              <SelectContent mount={props.menuMount} />
            </Select>
          </ItemActions>
        )}
      </Show>
    </Item>
  );
}
