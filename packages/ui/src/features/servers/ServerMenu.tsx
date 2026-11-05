import type { ServerSummary } from "@tommy/contracts/ipc";
import { buttonVariants, ChevronsUpDown, DropdownMenu, LogOut, Settings } from "@tommy/ui";
import { createSignal, Show } from "solid-js";
import { useText } from "../../text";
import { ServerMark } from "./ServerMark";

export interface ServerMenuProps {
  server: ServerSummary | undefined;
  serverName: string;
  onOpenSettings: (serverId: string, trigger: HTMLElement | null) => void;
  /** Forgets the server on this computer, and the pairing screen shows again. */
  onDisconnect: () => void;
  /** The compact sidebar hides the server name. */
  compact?: boolean;
}

/** The name of the one server on the sidebar title. Its menu opens the settings of the server. */
export function ServerMenu(props: ServerMenuProps) {
  const { t } = useText();
  const [menuOpen, setMenuOpen] = createSignal(false);
  let trigger: HTMLElement | undefined;
  return (
    <DropdownMenu.Root open={menuOpen()} onOpenChange={setMenuOpen} placement="bottom-start" gutter={6}>
      <DropdownMenu.Trigger
        ref={(element) => (trigger = element)}
        class={buttonVariants({ variant: "ghost", size: "sm", class: "sidebar-server-name no-drag" })}
        aria-label={t("server.menu.open", { name: props.serverName })}
        aria-hidden={props.compact ? "true" : undefined}
        tabindex={props.compact ? -1 : 0}
        title={props.serverName}
      >
        <Show when={props.server}>
          {(server) => (
            <span class="server-menu-mark sidebar-server-name-mark" aria-hidden="true">
              <ServerMark server={server()} />
            </span>
          )}
        </Show>
        <span class="sidebar-server-name-label">{props.serverName}</span>
        <ChevronsUpDown class="sidebar-server-name-chevron" aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="agent-context-menu server-menu" aria-label={t("server.menu.label")}>
          <Show when={props.server}>
            {(server) => (
              <DropdownMenu.Item onSelect={() => props.onOpenSettings(server().id, trigger ?? null)}>
                <Settings class="agent-context-icon size-4" aria-hidden="true" />
                <span>{t("server.menu.settings")}</span>
              </DropdownMenu.Item>
            )}
          </Show>
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={() => props.onDisconnect()}>
            <LogOut class="agent-context-icon size-4" aria-hidden="true" />
            <span>{t("server.menu.disconnect")}</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
