import { AGENT_TASKS_CAPABILITY } from "@tommy/contracts/team-protocol/agent-tasks-v1";
import type { SidebarView } from "@tommy/ui/features/sidebar/sidebar-types";
import { PageRail, type PageRailPage } from "@tommy/ui/features/window/PageRail";
import { useLayout } from "../../layout";
import { usePlatform } from "../../platform";
import { useChannels } from "../channels/channels-context";
import { serverSupportsCapability } from "../servers/server-capabilities";
import { useServers } from "../servers/servers-context";
import { usePlanLimitRows } from "../usage/plan-limit-rows";
import { useWindowPage } from "./window-page-context";

/**
 * The page rail of the desktop window. Agents, Routines, Workflows, Schedule, Usage, Marketplace and
 * Settings change the page in the card.
 */
export function WorkspacePageRail(props: { hidden: boolean }) {
  const windowPage = useWindowPage();
  const layout = useLayout();
  const channels = useChannels();
  const { activeServer } = useServers();
  const platform = usePlatform();
  /** macOS draws the window buttons in the top row of the rail. Windows and Linux show the logo there. */
  const logo = () => {
    const info = platform.appInfo();
    return info && info.platform !== "darwin" ? { variant: info.variant } : undefined;
  };
  /** Agents and Routines show the same page; they set the list of the sidebar. */
  function showSidebarView(view: SidebarView) {
    windowPage.showAgents();
    // An open channel would stay in the middle with no row in the list.
    if (view === "routines") channels.close();
    layout.setSidebarView(view);
  }
  const usageRows = usePlanLimitRows();
  /** The custom agents run on this computer, so a joined server does not show their usage. */
  // An older joined server has no task routes.
  const tasksAvailable = () => {
    const server = activeServer();
    return !server || server.kind === "local" || serverSupportsCapability(server, AGENT_TASKS_CAPABILITY);
  };
  const current = (): PageRailPage | null => {
    const page = windowPage.page();
    if (page === "agents") return layout.sidebarView();
    return page === "server-settings" ? null : page;
  };
  return (
    <PageRail
      hidden={props.hidden}
      current={current()}
      pinned={layout.railPinned()}
      onPinChange={layout.setRailPinned}
      usageRows={usageRows()}
      onAgents={() => showSidebarView("agents")}
      onRoutines={() => showSidebarView("routines")}
      // A joined server without workflows shows its notice on the page.
      onWorkflows={() => windowPage.openWorkflows(null)}
      onSchedule={windowPage.openSchedule}
      onTasks={tasksAvailable() ? windowPage.openTasks : undefined}
      onUsage={windowPage.openUsage}
      onSettings={(button) => windowPage.openSettings(button)}
      logo={logo()}
    />
  );
}
