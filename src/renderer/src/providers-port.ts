import type { TommyDesktopApi } from "@tommy/contracts/ipc";

/**
 * What provider state reaches in main: connecting, signing in and refreshing providers, and the
 * runtimes Tommy installs for them, on this computer or on a host the account administers.
 */
export interface ProvidersPort {
  cancelProviderCodeLogin: TommyDesktopApi["cancelProviderCodeLogin"];
  connectProvider: TommyDesktopApi["connectProvider"];
  cancelProviderSignIn: TommyDesktopApi["cancelProviderSignIn"];
  refreshAgentProviders: TommyDesktopApi["refreshAgentProviders"];
  setProviderOn: TommyDesktopApi["setProviderOn"];
  restartProvider: TommyDesktopApi["restartProvider"];
  cancelProviderRestart: TommyDesktopApi["cancelProviderRestart"];
  startProviderCodeLogin: TommyDesktopApi["startProviderCodeLogin"];
  providerRuntimes: TommyDesktopApi["providerRuntimes"];
  connectProviderAccount: TommyDesktopApi["connectProviderAccount"];
  cancelProviderAccountSignIn: TommyDesktopApi["cancelProviderAccountSignIn"];
  renameProviderAccount: TommyDesktopApi["renameProviderAccount"];
  removeProviderAccount: TommyDesktopApi["removeProviderAccount"];
  signOutProvider: TommyDesktopApi["signOutProvider"];
  providerUsageResets: TommyDesktopApi["providerUsageResets"];
  resetProviderUsage: TommyDesktopApi["resetProviderUsage"];
  /** The same, for the host of a joined server the account administers. */
  providerAdmin: TommyDesktopApi["providerAdmin"];
}

/** Read on each call: tests and stories replace `window.tommy` per case. */
export function providersPort(): ProvidersPort {
  return window.tommy;
}
