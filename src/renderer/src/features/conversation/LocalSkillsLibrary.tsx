import type { InstalledSkill, MarketplaceSkillDetail } from "@tommy/contracts/ipc";
import type { RestoreLearnedSkillInput, RestoreLearnedSkillResult } from "@tommy/contracts/ipc-skill-learning";
import {
  Button,
  ConfirmDialog,
  ErrorReference,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@tommy/ui";
import { SkillGlyph } from "@tommy/ui/features/conversation/SkillGlyph";
import { useText } from "@tommy/ui/text";
import { errorReference } from "@tommy/user-errors";
import { createEffect, createMemo, createSignal, createStore, For, onSettled, Show, untrack } from "solid-js";
import { SkillPreview } from "../../components/SkillPreview";
import { type SkillsPort, skillsPort } from "../../skills-port";

/** The library belongs to the host. Each consumer binds these calls to that same host. */
export interface LocalSkillLibraryCalls
  extends Pick<SkillsPort["skills"], "localList" | "localGet" | "localInstall" | "setEnabled"> {
  restore(input: RestoreLearnedSkillInput): Promise<RestoreLearnedSkillResult>;
}

export function LocalSkillsLibrary(props: {
  initialSkillId?: string | undefined;
  agentId: string;
  serverId?: string | undefined;
  calls?: LocalSkillLibraryCalls | undefined;
  menuMount?: HTMLElement | undefined;
  disabled?: boolean;
  installed: InstalledSkill[];
  onInstalled: () => Promise<void>;
  onTry?: ((skill: MarketplaceSkillDetail) => void) | undefined;
}) {
  const { t, errorMessage } = useText();
  function libraryCalls(): LocalSkillLibraryCalls {
    if (props.calls) return props.calls;
    return {
      localList: () => skillsPort().skills.localList(),
      localGet: (input) => skillsPort().skills.localGet(input),
      localInstall: (input) => skillsPort().skills.localInstall(input),
      setEnabled: (input) => skillsPort().skills.setEnabled(input),
      restore: (input) => window.tommy.skillLearning.restore(input),
    };
  }
  const libraryScope = createMemo(() => JSON.stringify([props.serverId ?? "local", props.agentId]));
  const current = (scope: string) => active && scope === libraryScope();

  const [reload, setReload] = createSignal(0);
  const [restore, setRestore] = createSignal<{
    skillId: string;
    revision: number;
    expectedRevision: number;
    requestId: string;
  } | null>(null);
  let active = true;
  onSettled(() => () => {
    active = false;
  });
  const [state, setState] = createStore<{
    skills: MarketplaceSkillDetail[];
    selected: MarketplaceSkillDetail | null;
    previewReady: boolean;
    loading: boolean;
    busy: boolean;
    error: string;
    /** The code of the failure behind `error`. */
    reference: string | null;
  }>({
    skills: [],
    selected: null,
    previewReady: false,
    loading: true,
    busy: false,
    error: "",
    reference: null,
  });
  const listScope = createMemo(
    () => ({ identity: libraryScope(), reload: reload(), initialSkillId: props.initialSkillId }),
    {
      equals: (before, after) =>
        before.identity === after.identity &&
        before.reload === after.reload &&
        before.initialSkillId === after.initialSkillId,
    },
  );
  createEffect(
    () => ({ scope: listScope(), calls: untrack(libraryCalls) }),
    ({ scope, calls }) => {
      let disposed = false;
      previewRequest += 1;
      setState((current) => ({
        ...current,
        loading: true,
        busy: false,
        error: "",
        reference: null,
        selected: null,
        previewReady: false,
      }));
      void calls.localList().then(
        (skills) => {
          if (disposed) return;
          setState((current) => ({ ...current, skills, loading: false }));
          const initial = skills.find((skill) => skill.id === scope.initialSkillId);
          if (initial) void readRevision(initial);
        },
        (error) => {
          if (!disposed)
            setState((current) => ({
              ...current,
              error: t("skill.local.loadFailed"),
              reference: errorReference(error),
              loading: false,
            }));
        },
      );
      return () => {
        disposed = true;
      };
    },
  );
  const installed = () => props.installed.find((skill) => skill.skillId === state.selected?.id);
  const latestRevision = () =>
    state.skills.find((skill) => skill.id === state.selected?.id)?.version ?? state.selected?.version ?? 1;
  let previewRequest = 0;
  createEffect(libraryScope, () => {
    previewRequest += 1;
    setRestore(null);
  });
  async function readRevision(selected: MarketplaceSkillDetail, revision = selected.version): Promise<void> {
    const request = ++previewRequest;
    const scope = libraryScope();
    const calls = libraryCalls();
    setState((draft) => {
      draft.busy = true;
      draft.error = "";
      draft.reference = null;
      draft.selected = selected;
      draft.previewReady = false;
    });
    try {
      const skill = await calls.localGet({ skillId: selected.id, revision });
      if (skill.id !== selected.id || skill.version !== revision) throw new Error(t("skill.local.loadFailed"));
      if (current(scope) && request === previewRequest)
        setState((draft) => {
          draft.selected = skill;
          draft.previewReady = true;
        });
    } catch (error) {
      if (current(scope) && request === previewRequest)
        setState((draft) => {
          draft.error = errorMessage(error, t("skill.local.loadFailed"));
          draft.reference = errorReference(error);
        });
    } finally {
      if (current(scope) && request === previewRequest)
        setState((draft) => {
          draft.busy = false;
        });
    }
  }
  async function previewRevision(revision: number | null): Promise<void> {
    const selected = state.selected;
    if (!selected || revision === null || revision === selected.version || state.busy) return;
    await readRevision(selected, revision);
  }
  async function restoreRevision(): Promise<void> {
    const request = restore();
    if (!request || state.busy || !state.previewReady) return;
    const agentId = props.agentId;
    const scope = libraryScope();
    const calls = libraryCalls();
    setState((draft) => {
      draft.busy = true;
      draft.error = "";
      draft.reference = null;
    });
    try {
      await calls.restore({ ...request, agentId });
      if (!current(scope) || agentId !== props.agentId) return;
      await props.onInstalled();
      if (!current(scope)) return;
      setRestore(null);
      setReload((value) => value + 1);
    } catch (error) {
      if (current(scope) && agentId === props.agentId)
        setState((draft) => {
          draft.error = errorMessage(error, t("skill.local.restoreFailed"));
          draft.reference = errorReference(error);
        });
    } finally {
      if (current(scope) && agentId === props.agentId)
        setState((draft) => {
          draft.busy = false;
        });
    }
  }
  async function toggleSkill(skill: MarketplaceSkillDetail, enabled: boolean) {
    if (state.busy || props.disabled) return;
    const agentId = props.agentId;
    const scope = libraryScope();
    const calls = libraryCalls();
    const assigned = props.installed.find((item) => item.skillId === skill.id);
    setState((current) => ({ ...current, busy: true, error: "", reference: null }));
    try {
      if (!assigned && enabled) {
        await calls.localInstall({ agentId, skillId: skill.id, revision: skill.version });
      } else if (assigned) {
        await calls.setEnabled({ agentId, skillId: skill.id, enabled });
      }
      if (current(scope) && props.agentId === agentId) await props.onInstalled();
    } catch (error) {
      if (current(scope) && props.agentId === agentId)
        setState((current) => ({
          ...current,
          error: errorMessage(error, t("skill.local.toggleFailed")),
          reference: errorReference(error),
        }));
    } finally {
      if (current(scope) && props.agentId === agentId) setState((current) => ({ ...current, busy: false }));
    }
  }
  async function install(skill: MarketplaceSkillDetail) {
    if (
      state.busy ||
      props.disabled ||
      skill.version < (state.skills.find((item) => item.id === skill.id)?.version ?? skill.version)
    )
      return;
    const agentId = props.agentId;
    const scope = libraryScope();
    const calls = libraryCalls();
    setState((current) => ({ ...current, busy: true, error: "", reference: null }));
    try {
      await calls.localInstall({ agentId, skillId: skill.id, revision: skill.version });
      if (!current(scope) || props.agentId !== agentId) return;
      await props.onInstalled();
    } catch (error) {
      if (current(scope))
        setState((current) => ({
          ...current,
          error: errorMessage(error, t("skill.local.addFailed")),
          reference: errorReference(error),
        }));
    } finally {
      if (current(scope)) setState((current) => ({ ...current, busy: false }));
    }
  }
  async function trySkill(skill: MarketplaceSkillDetail) {
    if (state.busy || props.disabled) return;
    const agentId = props.agentId;
    const scope = libraryScope();
    const calls = libraryCalls();
    setState((current) => ({ ...current, busy: true, error: "", reference: null }));
    try {
      if (installed()?.enabled === false) await calls.setEnabled({ agentId, skillId: skill.id, enabled: true });
      if (!current(scope) || props.agentId !== agentId) return;
      await props.onInstalled();
      if (current(scope) && props.agentId === agentId && state.selected?.id === skill.id) props.onTry?.(skill);
    } catch (error) {
      if (current(scope))
        setState((current) => ({ ...current, error: t("skill.enableFailed"), reference: errorReference(error) }));
    } finally {
      if (current(scope)) setState((current) => ({ ...current, busy: false }));
    }
  }
  return (
    <div class={["agent-local-library", state.selected && "agent-skill-detail"]}>
      <Show when={state.selected}>
        <div class="skill-preview-toolbar">
          <Show when={state.selected}>
            <Button
              variant="ghost"
              onClick={() => setState((current) => ({ ...current, selected: null, error: "", reference: null }))}
            >
              {t("skill.local.back")}
            </Button>
          </Show>
          <Show when={state.selected}>
            {(skill) => (
              <>
                <Show when={latestRevision() > 1}>
                  <Select<number>
                    options={Array.from({ length: latestRevision() }, (_, index) => latestRevision() - index)}
                    value={skill().version}
                    disabled={state.busy}
                    onChange={(revision) => void previewRevision(revision)}
                    itemComponent={(item) => (
                      <SelectItem item={item.item}>
                        {t("skill.local.revision", { revision: item.item.rawValue })}
                      </SelectItem>
                    )}
                  >
                    <SelectTrigger size="sm" aria-label={t("skill.local.revisions")}>
                      <SelectValue<number>>
                        {(selection) =>
                          t("skill.local.revision", { revision: selection.selectedOption() ?? skill().version })
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent mount={props.menuMount} />
                  </Select>
                </Show>
                <Show when={skill().version < latestRevision()}>
                  <Button
                    variant="outline"
                    disabled={state.busy || props.disabled || !state.previewReady}
                    onClick={() =>
                      setRestore({
                        skillId: skill().id,
                        revision: skill().version,
                        expectedRevision: latestRevision(),
                        requestId: crypto.randomUUID(),
                      })
                    }
                  >
                    {t("skill.local.restore")}
                  </Button>
                </Show>
                <Button
                  disabled={
                    state.busy ||
                    !state.previewReady ||
                    skill().version < latestRevision() ||
                    (installed()?.installedVersion === skill().version && installed()?.state !== "needs-repair")
                  }
                  onClick={() => void install(skill())}
                >
                  {installed()?.state === "needs-repair"
                    ? t("skill.repair")
                    : installed()?.installedVersion === skill().version
                      ? t("skill.local.added")
                      : installed()
                        ? t("skill.update")
                        : t("skill.local.add")}
                </Button>
              </>
            )}
          </Show>
        </div>
      </Show>
      <Show when={state.error}>
        <p class="agent-memory-error" role="alert">
          {state.error}
          <ErrorReference reference={state.reference} />
        </p>
        <Show when={!state.selected}>
          <Button variant="ghost" onClick={() => setReload((value) => value + 1)}>
            {t("common.retry")}
          </Button>
        </Show>
      </Show>
      <Show
        when={!state.loading}
        fallback={
          <p role="status" class="agent-memory-state">
            {t("skill.local.loading")}
          </p>
        }
      >
        <Show
          when={state.selected}
          fallback={
            <>
              <Show when={state.skills.length === 0 && !state.error}>
                <p class="agent-memory-state">{t("skill.local.empty")}</p>
              </Show>
              <For each={state.skills}>
                {(skill) => (
                  <div
                    class={[
                      "agent-skill-row agent-local-skill-row",
                      !props.installed.some((item) => item.skillId === skill.id && item.enabled !== false) &&
                        "agent-skill-row-disabled",
                    ]}
                  >
                    <Button
                      variant="ghost"
                      class="agent-skill-open"
                      disabled={state.busy}
                      onClick={() => void readRevision(skill)}
                    >
                      <SkillGlyph iconUrl={skill.iconUrl} />
                      <span class="agent-skill-copy">
                        <span class="agent-skill-title">
                          <strong>{skill.name}</strong>
                        </span>
                        <small>{skill.description}</small>
                      </span>
                    </Button>
                    <Show
                      when={props.installed.some(
                        (item) =>
                          item.skillId === skill.id &&
                          item.installedVersion < skill.version &&
                          item.state !== "modified" &&
                          item.state !== "needs-repair",
                      )}
                    >
                      <Button
                        size="sm"
                        variant="ghost"
                        class="agent-skill-update"
                        aria-label={t("skill.updateName", { name: skill.name })}
                        disabled={state.busy || props.disabled}
                        onClick={() => void install(skill)}
                      >
                        {t("skill.update")}
                      </Button>
                    </Show>
                    <Switch
                      aria-label={t("skill.enableName", { name: skill.name })}
                      checked={props.installed.some((item) => item.skillId === skill.id && item.enabled !== false)}
                      disabled={state.busy || props.disabled === true}
                      onChange={(enabled) => void toggleSkill(skill, enabled)}
                    />
                  </div>
                )}
              </For>
            </>
          }
        >
          {(skill) => (
            <SkillPreview
              skill={skill()}
              onTry={
                state.previewReady &&
                installed()?.installedVersion === skill().version &&
                installed()?.state !== "needs-repair" &&
                !state.busy &&
                props.onTry
                  ? () => void trySkill(skill())
                  : undefined
              }
              unavailableReason={
                !installed()
                  ? t("skill.unavailable.add")
                  : installed()?.installedVersion !== skill().version
                    ? t("skill.unavailable.updateRevision")
                    : installed()?.state === "needs-repair"
                      ? t("skill.unavailable.repair")
                      : t("skill.unavailable.composer")
              }
            />
          )}
        </Show>
      </Show>
      <ConfirmDialog
        open={restore() !== null}
        tone="default"
        title={t("skill.local.restoreTitle")}
        description={t("skill.local.restoreDescription", { revision: restore()?.revision ?? 1 })}
        confirmLabel={t("skill.local.restore")}
        pending={state.busy}
        error={state.error || undefined}
        onConfirm={restoreRevision}
        onCancel={() => setRestore(null)}
      />
    </div>
  );
}
