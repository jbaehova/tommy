import { DESKTOP_FOCUS_INTERVAL_MS } from "@tommy/contracts/team-protocol/desktop-focus-v1";

/**
 * Tells the selected server whether a window of this app has focus (`desktop-focus-v1`): at once when
 * focus comes or goes, and again each interval while it stays. The caller sets the server only while
 * a window has focus and the server can hear it. `send` drops its own errors.
 */
export function createDesktopFocusReport(send: (serverId: string, focused: boolean) => void) {
  let target: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  function setTarget(serverId: string | null): void {
    if (serverId === target) return;
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (target !== null) send(target, false);
    target = serverId;
    if (serverId === null) return;
    send(serverId, true);
    timer = setInterval(() => send(serverId, true), DESKTOP_FOCUS_INTERVAL_MS);
    timer.unref?.();
  }

  return { setTarget, dispose: () => setTarget(null) };
}
