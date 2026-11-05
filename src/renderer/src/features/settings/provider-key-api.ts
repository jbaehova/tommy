import type { ProviderAdminDesktopApi } from "@tommy/contracts/ipc";
import type { ProviderKeyApi } from "@tommy/ui/features/settings/OpenCodeKeyDialog";

/**
 * The four calls the OpenCode key dialog makes, bound once.
 *
 * It is a narrow object rather than `window.tommy` itself so the dialog's props say exactly what
 * it reaches for, and so a test hands it four functions instead of the whole bridge. Settings and
 * onboarding both open the dialog, so it lives here rather than in either.
 */
export const providerKeyApi: ProviderKeyApi = {
  getProviderApiKeyState: (provider) => window.tommy.getProviderApiKeyState(provider),
  setProviderApiKey: (input) => window.tommy.setProviderApiKey(input),
  clearProviderApiKey: (provider) => window.tommy.clearProviderApiKey(provider),
  openExternal: (destination) => window.tommy.openExternal(destination),
};

/**
 * The same four calls for the host of a joined server the account administers. The key goes to that
 * host, and only its state comes back. Links still open on this computer: in the desktop app by
 * default, or through `openExternal` where there is no desktop bridge, as in the browser client.
 */
export function hostProviderKeyApi(
  admin: () => ProviderAdminDesktopApi,
  serverId: string,
  openExternal: ProviderKeyApi["openExternal"] = (destination) => window.tommy.openExternal(destination),
): ProviderKeyApi {
  return {
    getProviderApiKeyState: (provider) => admin().getApiKeyState(provider, serverId),
    setProviderApiKey: (input) => admin().setApiKey(input, serverId),
    clearProviderApiKey: (provider) => admin().clearApiKey(provider, serverId),
    openExternal,
  };
}
