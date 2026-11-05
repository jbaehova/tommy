import { useProviders } from "../../providers";
import { useAgents } from "../agents/agents-context";
import type { HostProviderSettings } from "../settings/ProviderSettingsSection";

/**
 * The providers of the joined server's host that this window manages over `providers-v1`, or
 * undefined for any other server. The same gates as the host's Settings tab.
 */
export function useHostProviderSettings(): () => HostProviderSettings | undefined {
  const { agentStatus } = useAgents();
  const providers = useProviders();
  const downloads = () => providers.providerRuntimeDownloadsAvailable();
  const settings: HostProviderSettings = {
    get agentStatus() {
      return agentStatus();
    },
    get providerRuntimeStatuses() {
      return downloads() ? providers.providerRuntimeStatuses() : undefined;
    },
    get providerAvailableVersions() {
      return downloads() ? providers.providerAvailableVersions() : undefined;
    },
    get onDownloadProvider() {
      return downloads() ? providers.downloadProviderRuntime : undefined;
    },
    get onCancelProviderDownload() {
      return downloads() ? providers.cancelProviderRuntimeDownload : undefined;
    },
    get onUpdateProvider() {
      return downloads() ? providers.startProviderUpdate : undefined;
    },
    get providerKeys() {
      return downloads() ? providers.providerKeys() : undefined;
    },
    get connection() {
      return downloads() ? providers.connection : undefined;
    },
  };
  return () => (providers.providerAdminServerId() ? settings : undefined);
}
