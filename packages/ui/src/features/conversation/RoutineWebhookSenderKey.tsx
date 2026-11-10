import { Button, Field, Input, Text } from "@tommy/ui";
import { createEffect, createStore, onSettled, Show } from "solid-js";
import { useText } from "../../text";

/** A write-only sender key. It never joins the routine draft or the workflow graph. */
export function RoutineWebhookSenderKey(props: {
  scopeKey: string;
  onSave: (secret: string) => Promise<void>;
  onSaved: () => void;
}) {
  const { t } = useText();
  const [state, setState] = createStore({ editing: false, key: "", saving: false, saved: false, failed: false });
  let generation = 0;
  let disposed = false;

  function clear(): void {
    generation += 1;
    setState((current) => {
      current.editing = false;
      current.key = "";
      current.saving = false;
      current.saved = false;
      current.failed = false;
    });
  }

  createEffect(() => props.scopeKey, clear);
  onSettled(() => () => {
    disposed = true;
    clear();
  });

  async function save(): Promise<void> {
    const key = state.key.trim();
    if (state.saving || !key) return;
    const request = ++generation;
    const scopeKey = props.scopeKey;
    const write = props.onSave;
    // The transport owns the request now. The input stays empty on both success and failure.
    setState((current) => {
      current.key = "";
      current.saving = true;
      current.saved = false;
      current.failed = false;
    });
    try {
      await write(key);
      if (disposed || request !== generation || scopeKey !== props.scopeKey) return;
      props.onSaved();
      setState((current) => {
        current.editing = false;
        current.saving = false;
        current.saved = true;
      });
    } catch {
      if (disposed || request !== generation || scopeKey !== props.scopeKey) return;
      // A provider or native error must never echo an entered key into the view.
      setState((current) => {
        current.saving = false;
        current.failed = true;
      });
    }
  }

  return (
    <div class="routine-webhook-sender-key">
      <Show
        when={state.editing}
        fallback={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              setState((current) => {
                current.editing = true;
                current.key = "";
                current.saved = false;
                current.failed = false;
              });
            }}
          >
            {t("routine.webhook.senderKey.open")}
          </Button>
        }
      >
        <form
          class="routine-webhook-sender-key-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field label={t("routine.webhook.senderKey.label")}>
            <Input
              type="password"
              autocomplete="off"
              spellcheck={false}
              maxlength={1_024}
              value={state.key}
              disabled={state.saving}
              onValueChange={(key) => {
                setState((current) => {
                  current.key = key;
                  current.failed = false;
                });
              }}
            />
          </Field>
          <Text variant="caption" tone="muted">
            {t("routine.webhook.senderKey.hint")}
          </Text>
          <div class="routine-webhook-sender-key-actions">
            <Button
              type="submit"
              size="xs"
              loading={state.saving}
              loadingLabel={t("common.saving")}
              disabled={!state.key.trim()}
            >
              {t("common.save")}
            </Button>
            <Button type="button" variant="ghost" size="xs" disabled={state.saving} onClick={clear}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      </Show>
      <Show when={state.saved}>
        <Text variant="caption" tone="success" role="status">
          {t("routine.webhook.senderKey.saved")}
        </Text>
      </Show>
      <Show when={state.failed}>
        <Text variant="caption" tone="danger" role="alert">
          {t("routine.webhook.senderKey.failed")}
        </Text>
      </Show>
    </div>
  );
}
