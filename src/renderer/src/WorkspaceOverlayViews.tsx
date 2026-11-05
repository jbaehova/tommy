import type { ComponentProps } from "@solidjs/web";
import type { McpServerConfig } from "@tommy/contracts/ipc";
import { MCP_SERVERS_CAPABILITY } from "@tommy/contracts/ipc";
import { Loading, omit, Show } from "solid-js";
import { ChannelCreateDialog } from "./features/channels/ChannelCreateDialog";
import { useChannels } from "./features/channels/channels-context";
import type { ServerStorageOptions } from "./features/files/ServerStoragePanel";
import { canManageStorage, serverHasStorage } from "./features/files/storage-usage";
import type { ServerSettingsModalProps } from "./features/servers/ServerSettingsModal";
import { serverCanAdminister } from "./features/servers/server-capabilities";
import { GlobalSearch, ServerSettingsModal } from "./lazy-views";

/**
 * The overlays that the desktop shell and the web client both raise over the workspace, as views that
 * take props. `WorkspaceOverlays` fills them from the desktop contexts; the web client fills them from
 * its host connection. What an overlay decides from its server - which host installs, which sections
 * show - is decided here once, so the two clients cannot drift apart.
 *
 * They read only the contexts that both clients provide: the conversation controller and channels.
 */

/**
 * Settings for one server. The MCP and Storage sections are gated on the server here: a remote host
 * answers 403 to a `member` and 400 without the capability, so neither ever sees the MCP section,
 * and a host without `storage-v1` has no Storage section at all.
 */
export function ServerSettingsOverlay(
  props: Omit<ServerSettingsModalProps, "mcpServers" | "storage"> & {
    mcpServers: McpServerConfig[];
    storage: Omit<ServerStorageOptions, "canManage">;
  },
) {
  const modal = omit(props, "mcpServers", "storage");
  return (
    <Loading>
      <ServerSettingsModal
        {...modal}
        mcpServers={serverCanAdminister(props.server, MCP_SERVERS_CAPABILITY) ? props.mcpServers : undefined}
        storage={
          serverHasStorage(props.server) ? { ...props.storage, canManage: canManageStorage(props.server) } : undefined
        }
      />
    </Loading>
  );
}

/** Search across every conversation on the active server. */
export function GlobalSearchOverlay(props: ComponentProps<typeof GlobalSearch>) {
  const search = omit(props, "open");
  return (
    <Show when={props.open}>
      <Loading>
        <GlobalSearch open={true} {...search} />
      </Loading>
    </Show>
  );
}

/** A new channel. Channels is the one domain both clients provide as a context. */
export function ChannelCreateOverlay() {
  const channels = useChannels();
  return (
    <Show when={channels.state.editing === "create"}>
      <ChannelCreateDialog />
    </Show>
  );
}
