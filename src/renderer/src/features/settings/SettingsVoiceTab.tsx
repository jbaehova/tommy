import { Button, Input, ItemGroup, SettingsSection, Text } from "@tommy/ui";
import { useText } from "@tommy/ui/text";
import { createEffect, Show } from "solid-js";
import type { SettingsVoiceStore } from "./settings-voice-store";

/** Dictation streams through the server with one OpenAI API key, which stays on the server. */
export function SettingsVoiceTab(props: { store: SettingsVoiceStore; active: boolean }) {
  const { t, errorMessage } = useText();
  createEffect(
    () => props.active,
    (active) => {
      if (active) void props.store.read();
    },
  );
  return (
    <SettingsSection
      data-settings-row="settings.voice.openaiKey.title"
      title={t("settings.voice.openaiKey.title")}
      description={t("settings.voice.openaiKey.description")}
    >
      <ItemGroup class="settings-modal-card">
        <form
          class="settings-modal-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (props.store.draft().trim()) void props.store.save(props.store.draft().trim());
          }}
        >
          <Input
            type="password"
            autocomplete="off"
            spellcheck={false}
            aria-label={t("settings.voice.openaiKey.title")}
            placeholder={t("settings.voice.openaiKey.placeholder")}
            maxlength={512}
            value={props.store.draft()}
            onValueChange={props.store.setDraft}
          />
          <Button type="submit" size="sm" disabled={props.store.busy() || !props.store.draft().trim()}>
            {t("settings.voice.openaiKey.save")}
          </Button>
          <Show when={props.store.keySaved()}>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={props.store.busy()}
              onClick={() => void props.store.save(null)}
            >
              {t("settings.voice.openaiKey.remove")}
            </Button>
          </Show>
        </form>
      </ItemGroup>
      <Show when={props.store.keySaved()}>
        <Text variant="caption" tone="muted" role="status">
          {t("settings.voice.openaiKey.saved")}
        </Text>
      </Show>
      <Show when={props.store.error()}>
        {(failure) => (
          <Text variant="caption" tone="danger" role="alert">
            {errorMessage(failure(), t("settings.voice.openaiKey.failed"))}
          </Text>
        )}
      </Show>
    </SettingsSection>
  );
}
