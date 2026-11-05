import { useText } from "@tommy/ui/text";
import { createEffect, createSignal, Loading, Show } from "solid-js";
import { useAuth } from "./features/account/account-context";
import { createLanguageStep } from "./features/onboarding/language-step";
import { useSetup } from "./features/onboarding/onboarding-context";
import { StartupSplash } from "./features/startup/StartupSplash";
import { QuitShortcutHint } from "./features/window/QuitShortcutHint";
import { useI18n } from "./i18n-context";
import { DevicePairing, LanguageStep } from "./lazy-views";
import { usePlatform } from "./platform";
import { WorkspaceShell } from "./WorkspaceShell";

/** The one server of this app. The pairing screen starts with it, and the user can change it. */
const DEFAULT_SERVER_ADDRESS = "tommy.example.com";

/** The placeholder every lazy view below falls back to while its code loads. */
function LoadingScreen() {
  const { t } = useText();
  return <div class="initial-setup-screen" role="status" aria-label={t("app.loading")} />;
}

/**
 * Which of four things the window shows: the startup splash until the build and
 * the saved setup are known, the sign-in screen (after the language wheel on a
 * computer that has not passed it), one of the two first-run flows, or the
 * workspace. The splash stays over the next screen until it fades out.
 *
 * The ladder is written as nested `<Show>` rather than pushed into the providers
 * as readiness gates. A gated provider withholds its subtree, and the only
 * subtree here is the whole application, so a gate would replace these
 * placeholders with a blank window and serialize the bootstrap loads that
 * currently run in parallel. See `app-providers.tsx`.
 *
 * `account` is threaded down as an accessor because the innermost `<Show>` is
 * what proves it non-null; the workspace and its overlays need the account, and
 * re-reading `signedInAccount()` below would hand them a nullable value the
 * gate has already ruled out.
 */
export function AppAccessGate() {
  const platform = usePlatform();
  const i18n = useI18n();
  const auth = useAuth();
  const setup = useSetup();
  const started = () => setup.setupLoaded() && platform.appInfo() !== null;
  const [splashShown, setSplashShown] = createSignal(true);
  const languageStep = createLanguageStep();
  // Only a settled sign-out: a code in flight or a retry keeps the sign-in screen it belongs to.
  // The language button reopens the wheel from an error too, so that state does not hide it.
  const languageStepShown = () =>
    !languageStep.done() && (languageStep.reopened() || auth.centralAuth().status === "signed_out");
  // A computer signed in before the wheel existed has its language already, so a later sign-out skips the wheel.
  createEffect(
    () => auth.centralAuth().status === "signed_in",
    (signedIn) => {
      if (signedIn && !languageStep.done()) languageStep.complete();
    },
  );
  // A startup mark for `dev:bench`: the first moment the app can leave the splash.
  createEffect(started, (ready) => {
    if (ready) performance.mark("tommy:app-started");
  });

  return (
    <>
      <Show when={started()}>
        <Show
          when={auth.visibleSignedInAccount()}
          fallback={
            <Loading fallback={<LoadingScreen />}>
              <Show
                when={languageStepShown()}
                fallback={
                  <DevicePairing
                    variant={platform.appInfo()?.variant ?? "production"}
                    state={auth.centralAuth()}
                    defaultAddress={DEFAULT_SERVER_ADDRESS}
                    onPair={auth.pairDevice}
                    language={i18n.locale()}
                    onChangeLanguage={languageStep.reopen}
                  />
                }
              >
                <LanguageStep
                  variant={platform.appInfo()?.variant ?? "production"}
                  reopened={languageStep.reopened()}
                  onDone={languageStep.complete}
                />
              </Show>
            </Loading>
          }
        >
          {(account) => <WorkspaceShell account={account} />}
        </Show>
      </Show>
      <QuitShortcutHint />
      <Show when={splashShown()}>
        {/* Before `appInfo` loads, the build's own mode picks the logo colour. */}
        <StartupSplash
          variant={platform.appInfo()?.variant ?? (import.meta.env.DEV ? "dev" : "production")}
          ready={started()}
          onExited={() => setSplashShown(false)}
        />
      </Show>
    </>
  );
}
