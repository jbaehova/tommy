import type { BrowserProfileProxySummary } from "@tommy/contracts/browser-profile-proxy";
import type { AgentSummary, BrowserProfileSummary } from "@tommy/contracts/ipc";
import { BrowserProfileProxyEditor } from "@tommy/ui/features/browser/BrowserProfileProxyEditor";
import { BrowserProfilesPanel } from "@tommy/ui/features/browser/BrowserProfilesPanel";
import { useText } from "@tommy/ui/text";
import { createEffect, createSignal, createStore } from "solid-js";
import { actionToast } from "../../action-toast";
import type { BrowserProfileProxyCalls } from "./browser-profiles-port";
import type { BrowserProfilesStore } from "./stores/browser-profiles-store";

export interface ServerBrowserProfilesOptions {
  proxy?: BrowserProfileProxyCalls | undefined;
  /** The profiles of the server whose settings are open. A new store means another server. */
  store: Omit<BrowserProfilesStore, "assign">;
  /** The agents of the same server, for the names in the delete question. */
  listAgents: () => Promise<readonly Pick<AgentSummary, "id" | "name">[]>;
}

/**
 * The Browser profiles section of the server settings. It lists the profiles each time it opens,
 * and again when the settings change to another server. The list also counts the agents of the
 * shared profile, and each change lists it again, because a delete moves agents. A change made on
 * another device, such as the phone, shows while the section is open.
 */
export function ServerBrowserProfilesPanel(
  props: ServerBrowserProfilesOptions & { menuMount: HTMLElement | undefined },
) {
  const { t, errorMessage } = useText();
  const [agentNames, setAgentNames] = createSignal<ReadonlyMap<string, string>>(new Map());
  let request = 0;
  const [proxy, setProxy] = createStore<{
    profile: BrowserProfileSummary | null;
    summary: BrowserProfileProxySummary | null;
    loading: boolean;
    error: string | null;
  }>({ profile: null, summary: null, loading: false, error: null });
  let proxyRequest = 0;
  const closeProxy = () => {
    proxyRequest += 1;
    setProxy((state) => {
      state.profile = null;
      state.summary = null;
      state.loading = false;
      state.error = null;
    });
  };
  function configureProxy(profile: BrowserProfileSummary): void {
    const calls = props.proxy;
    if (!calls) return;
    const generation = ++proxyRequest;
    setProxy((state) => {
      state.profile = profile;
      state.summary = null;
      state.loading = true;
      state.error = null;
    });
    calls.get(profile.id).then(
      (summary) => {
        if (generation === proxyRequest)
          setProxy((state) => {
            state.summary = summary;
            state.loading = false;
          });
      },
      (error: unknown) => {
        if (generation === proxyRequest)
          setProxy((state) => {
            state.error = errorMessage(error, t("browser.profiles.proxy.failed"));
            state.loading = false;
          });
      },
    );
  }

  createEffect(
    () => props.store,
    (store) => {
      const current = ++request;
      closeProxy();
      setAgentNames(new Map());
      store
        .refresh()
        .catch((error: unknown) => actionToast.error(errorMessage(error, t("browser.profiles.loadFailed"))));
      // A name only makes the delete question clearer, so a failed read leaves it out.
      props.listAgents().then(
        (agents) => {
          if (current === request) setAgentNames(new Map(agents.map((agent) => [agent.id, agent.name])));
        },
        () => undefined,
      );
      return store.follow();
    },
  );
  return (
    <>
      <BrowserProfilesPanel
        profiles={props.store.state.profiles}
        sharedAgentCount={props.store.state.sharedAgentIds?.length}
        agentName={(agentId) => agentNames().get(agentId)}
        onCreate={async (name) => {
          await props.store.create(name);
        }}
        onRename={props.store.rename}
        onRecolor={props.store.recolor}
        onClear={props.store.clear}
        onDelete={props.store.remove}
        onConfigureProxy={props.proxy ? configureProxy : undefined}
        menuMount={props.menuMount}
      />
      <BrowserProfileProxyEditor
        profile={proxy.profile}
        summary={proxy.summary}
        loading={proxy.loading}
        error={proxy.error}
        mount={props.menuMount}
        onClose={closeProxy}
        onSave={async (input) => {
          const calls = props.proxy;
          if (!calls) return;
          await calls.set(input);
        }}
      />
    </>
  );
}
