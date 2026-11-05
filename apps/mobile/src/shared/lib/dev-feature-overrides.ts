/**
 * Development builds only. Set to `true` and reload the home screen to see the first-run flow again,
 * also for an account that finished it or whose server has agents. A release build ignores it.
 */
const DEV_REPLAY_ONBOARDING = false;

export function devReplayOnboarding(): boolean {
  return __DEV__ && DEV_REPLAY_ONBOARDING;
}
