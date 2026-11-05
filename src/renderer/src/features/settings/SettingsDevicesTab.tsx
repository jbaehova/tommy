import type { HostDevice } from "@tommy/contracts/ipc";
import {
  Badge,
  Button,
  ConfirmDialog,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  QrCode,
  SettingsSection,
  Text,
} from "@tommy/ui";
import { useText } from "@tommy/ui/text";
import { createSignal, For, Show } from "solid-js";
import type { SettingsDevicesStore } from "./settings-devices-store";

/** Settings > Devices: a QR code that connects a new device, and the devices that are connected now. */
export function SettingsDevicesTab(props: { store: SettingsDevicesStore }) {
  const { t, format, errorMessage } = useText();
  const [removing, setRemoving] = createSignal<HostDevice | null>(null);
  const timeLeft = () => {
    const seconds = props.store.state.remainingSeconds;
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  return (
    <Show
      when={props.store.available()}
      fallback={
        <Text variant="caption" tone="muted" role="status">
          {t("settings.devices.unavailable")}
        </Text>
      }
    >
      <SettingsSection data-settings-row="settings.devices.connect.title" title={t("settings.devices.connect.title")}>
        <ItemGroup class="settings-modal-card">
          <Show
            when={props.store.state.pairing}
            fallback={
              <Item class="settings-modal-row">
                <ItemContent>
                  <ItemDescription>{t("settings.devices.connect.description")}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    type="button"
                    size="sm"
                    disabled={props.store.state.busy}
                    onClick={() => void props.store.showCode()}
                  >
                    {props.store.state.expired
                      ? t("settings.devices.connect.again")
                      : t("settings.devices.connect.show")}
                  </Button>
                </ItemActions>
              </Item>
            }
          >
            {(pairing) => (
              <div class="settings-devices-pairing">
                <QrCode value={pairing().link} label={t("settings.devices.connect.qrLabel")} />
                <div class="settings-devices-pairing-text">
                  <Text variant="caption" tone="muted">
                    {t("settings.devices.connect.scan")}
                  </Text>
                  <span class="settings-devices-code">{pairing().code}</span>
                  <Text variant="caption" tone="muted" role="timer">
                    {t("settings.devices.connect.expires", { time: timeLeft() })}
                  </Text>
                  <div>
                    <Button type="button" size="sm" variant="ghost" onClick={props.store.hideCode}>
                      {t("settings.devices.connect.hide")}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </Show>
        </ItemGroup>
        <Show when={props.store.state.expired}>
          <Text variant="caption" tone="muted" role="status">
            {t("settings.devices.connect.expired")}
          </Text>
        </Show>
        <Show when={props.store.state.pairedName}>
          {(name) => (
            <Text variant="caption" tone="muted" role="status">
              {t("settings.devices.connect.paired", { name: name() })}
            </Text>
          )}
        </Show>
      </SettingsSection>

      <SettingsSection
        data-settings-row="settings.devices.list.title"
        title={t("settings.devices.list.title")}
        description={t("settings.devices.list.description")}
      >
        <ItemGroup class="settings-modal-card">
          <For each={props.store.state.devices ?? []} keyed={(device) => device.id}>
            {(device) => (
              <Item class="settings-modal-row">
                <ItemContent>
                  <ItemTitle>
                    {device().name}
                    <Show when={device().current}>
                      {" "}
                      <Badge>{t("settings.devices.list.current")}</Badge>
                    </Show>
                  </ItemTitle>
                  <ItemDescription>
                    {t("settings.devices.list.pairedAt", {
                      date: format.date(new Date(device().pairedAt), { dateStyle: "medium", timeStyle: "short" }),
                    })}
                  </ItemDescription>
                </ItemContent>
                <Show when={!device().current}>
                  <ItemActions>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={t("settings.devices.list.removeLabel", { name: device().name })}
                      onClick={() => setRemoving(device())}
                    >
                      {t("settings.devices.list.remove")}
                    </Button>
                  </ItemActions>
                </Show>
              </Item>
            )}
          </For>
        </ItemGroup>
      </SettingsSection>

      <Show when={props.store.error()}>
        {(failure) => (
          <Text variant="caption" tone="danger" role="alert">
            {errorMessage(failure(), t("settings.devices.unavailable"))}
          </Text>
        )}
      </Show>

      <Show when={removing()}>
        {(device) => (
          <ConfirmDialog
            open
            initialFocus="cancel"
            pending={props.store.state.busy}
            title={t("settings.devices.list.removeTitle", { name: device().name })}
            description={t("settings.devices.list.removeDescription")}
            confirmLabel={t("settings.devices.list.remove")}
            onCancel={() => setRemoving(null)}
            onConfirm={async () => {
              await props.store.revoke(device().id);
              setRemoving(null);
            }}
          />
        )}
      </Show>
    </Show>
  );
}
