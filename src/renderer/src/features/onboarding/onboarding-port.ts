import type { TommyDesktopApi } from "@tommy/contracts/ipc";

/**
 * What onboarding reaches in main: the saved setup, the browser for the Terms of Service and the Privacy Policy, and the first value of the
 *
 */
export interface OnboardingPort {
  getSetupState: TommyDesktopApi["getSetupState"];
  saveSetup: TommyDesktopApi["saveSetup"];
  onSetupState: TommyDesktopApi["onSetupState"];
  openUrl: TommyDesktopApi["openUrl"];
}

/** Read on each call: tests and stories replace `window.tommy` per case. */
export function onboardingPort(): OnboardingPort {
  return window.tommy;
}
