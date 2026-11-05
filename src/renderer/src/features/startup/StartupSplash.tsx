import { AppLogo, type AppLogoVariant } from "@tommy/brand";
import { useText } from "@tommy/ui/text";
import { createEffect, createSignal, onSettled } from "solid-js";

// The fade takes the overlay duration. If no `animationend` comes, the splash ends this time after the
// app is ready, so it cannot cover the app.
const EXIT_LIMIT_MS = 1500;
const EXIT_ANIMATION = "startup-splash-exit";
// The splash does not fade before the logo has faded in, so a fast start does not flash the logo.
const INTRO_ANIMATION = "startup-splash-in";

interface StartupSplashProps {
  variant: AppLogoVariant;
  /** The app is ready: the splash fades out. Remove it in `onExited`. */
  ready: boolean;
  onExited?: () => void;
}

/**
 * The desktop window's first screen: the logo fades in and stays until the app is ready. The fade
 * out starts when the app is ready and the logo has faded in.
 */
export function StartupSplash(props: StartupSplashProps) {
  const { t } = useText();
  let root: HTMLElement | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let exited = false;
  const [introDone, setIntroDone] = createSignal(false);
  const exiting = () => props.ready && introDone();

  function finishExit(): void {
    if (exited) return;
    exited = true;
    clearTimeout(exitTimer);
    props.onExited?.();
  }

  // Without the stylesheet, or in a test DOM, the logo does not fade in: no wait.
  onSettled(() => {
    const logo = root?.querySelector(".startup-splash-logo");
    if (!logo || !getComputedStyle(logo).animationName.includes(INTRO_ANIMATION)) setIntroDone(true);
  });

  createEffect(
    () => props.ready,
    (ready) => {
      if (!ready) return;
      exitTimer ??= setTimeout(finishExit, EXIT_LIMIT_MS);
      return () => clearTimeout(exitTimer);
    },
  );

  createEffect(exiting, (exit) => {
    // Without the stylesheet, or in a test DOM, the exit does not animate: end the splash now.
    if (exit && root && !getComputedStyle(root).animationName.includes(EXIT_ANIMATION)) queueMicrotask(finishExit);
  });

  function handleAnimationEnd(event: AnimationEvent): void {
    if (event.animationName === INTRO_ANIMATION) setIntroDone(true);
    else if (event.animationName === EXIT_ANIMATION && event.target === event.currentTarget) finishExit();
  }

  return (
    <main
      ref={(element) => {
        root = element;
      }}
      class="startup-splash"
      data-phase={exiting() ? "exit" : "loading"}
      role="status"
      aria-label={t("app.loading")}
      aria-busy={exiting() ? "false" : "true"}
      onAnimationEnd={handleAnimationEnd}
      // A canceled fade ends the wait too, so the splash cannot stay.
      onAnimationCancel={(event) => {
        if (event.animationName === INTRO_ANIMATION) setIntroDone(true);
      }}
    >
      <AppLogo variant={props.variant} class="startup-splash-logo" />
    </main>
  );
}
