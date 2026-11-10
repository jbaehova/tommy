import {
  type BrowserProfileProxyInput,
  type BrowserProfileProxySummary,
  parseBrowserProfileProxy,
} from "@tommy/contracts/browser-profile-proxy";
import { Button, Dialog, Input, Switch } from "@tommy/ui";
import { createEffect, createMemo, createStore, createUniqueId, onSettled, Show, untrack } from "solid-js";
import { useText } from "../../text";

/** Credentials are write-only. The host returns an address with no password. */
export function BrowserProfileProxyEditor(props: {
  profile: { id: string; name: string } | null;
  summary: BrowserProfileProxySummary | null;
  loading: boolean;
  error: string | null;
  onSave(input: BrowserProfileProxyInput): Promise<void>;
  onClose(): void;
  mount?: HTMLElement | undefined;
}) {
  const { t, errorMessage } = useText();
  const keepPasswordId = createUniqueId();
  const [draft, setDraft] = createStore({ address: "", keepPassword: false, saving: false, error: "" });
  let generation = 0;
  let disposed = false;
  onSettled(() => () => {
    disposed = true;
    generation += 1;
  });
  const scope = createMemo(() =>
    JSON.stringify([props.profile?.id, props.summary?.profileId, props.summary?.address, props.summary?.hasPassword]),
  );
  createEffect(
    () => ({ identity: scope(), profile: untrack(() => props.profile), summary: untrack(() => props.summary) }),
    ({ profile, summary }) => {
      generation += 1;
      setDraft((state) => {
        state.saving = false;
        state.address = summary?.profileId === profile?.id ? (summary?.address ?? "") : "";
        state.keepPassword = summary?.profileId === profile?.id && summary?.hasPassword === true;
        state.error = "";
      });
    },
  );
  async function save(system = false): Promise<void> {
    const profile = props.profile;
    if (!profile || draft.saving || props.loading) return;
    const address = system ? null : draft.address.trim();
    const proxy = address === null ? null : parseBrowserProfileProxy(address);
    if (address !== null && !proxy) {
      setDraft((state) => {
        state.error = t("browser.profiles.proxy.invalid");
      });
      return;
    }
    const request = ++generation;
    const identity = scope();
    const keepPassword = address !== null && proxy?.password === null && draft.keepPassword;
    setDraft((state) => {
      state.address = "";
      state.saving = true;
      state.error = "";
    });
    try {
      await props.onSave({ profileId: profile.id, address, keepPassword });
      if (!disposed && request === generation && scope() === identity) props.onClose();
    } catch (error) {
      if (disposed || request !== generation || scope() !== identity) return;
      setDraft((state) => {
        state.error = errorMessage(error, t("browser.profiles.proxy.failed"));
      });
    } finally {
      if (!disposed && request === generation && scope() === identity)
        setDraft((state) => {
          state.saving = false;
        });
    }
  }
  return (
    <Dialog.Root
      open={props.profile !== null}
      onOpenChange={(open) => {
        if (!open && !draft.saving) props.onClose();
      }}
    >
      <Dialog.Portal mount={props.mount}>
        <Dialog.Overlay class="ui-confirm-dialog-overlay">
          <Dialog.Content class="ui-confirm-dialog browser-profile-proxy-editor">
            <Dialog.Title>{t("browser.profiles.proxy.title")}</Dialog.Title>
            <Dialog.Description>{t("browser.profiles.proxy.description")}</Dialog.Description>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <Input
                value={draft.address}
                type="password"
                autocomplete="new-password"
                aria-label={t("browser.profiles.proxy.address")}
                placeholder={t("browser.profiles.proxy.placeholder")}
                disabled={props.loading || draft.saving || props.summary === null}
                onValueChange={(address) =>
                  setDraft((state) => {
                    state.address = address;
                  })
                }
              />
              <Show when={props.summary?.hasPassword}>
                <label class="browser-profile-proxy-keep" for={keepPasswordId}>
                  <span>{t("browser.profiles.proxy.keepPassword")}</span>
                  <Switch
                    id={keepPasswordId}
                    checked={draft.keepPassword}
                    disabled={draft.saving}
                    onChange={(keep) =>
                      setDraft((state) => {
                        state.keepPassword = keep;
                      })
                    }
                  />
                </label>
              </Show>
              <Show when={draft.error || props.error}>
                <p class="ui-field-error" role="alert">
                  {draft.error || props.error}
                </p>
              </Show>
              <div class="browser-profile-proxy-actions">
                <Button type="button" variant="ghost" disabled={draft.saving} onClick={props.onClose}>
                  {t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={props.loading || draft.saving || props.summary === null}
                  onClick={() => void save(true)}
                >
                  {t("browser.profiles.proxy.system")}
                </Button>
                <Button
                  type="submit"
                  loading={draft.saving}
                  disabled={props.loading || props.summary === null || !draft.address.trim()}
                >
                  {t("common.save")}
                </Button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
