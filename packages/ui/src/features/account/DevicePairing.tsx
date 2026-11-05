import { AppLogo } from "@tommy/brand";
import { parseDirectPairingLink } from "@tommy/contracts/direct-connection";
import type { AppVariant, CentralAuthState } from "@tommy/contracts/ipc";
import type { TranslatedLocale } from "@tommy/i18n";
import { appLanguageOption } from "@tommy/i18n/languages";
import { Button, Globe2, Input } from "@tommy/ui";
import { createSignal, Show } from "solid-js";
import { useText } from "../../text";

interface DevicePairingProps {
  variant: AppVariant;
  state: CentralAuthState;
  /** The address that the form starts with. */
  defaultAddress: string;
  onPair: (address: string, code: string) => Promise<void>;
  language?: TranslatedLocale;
  onChangeLanguage?: () => void;
}

const PRODUCT_NAME = "Tommy";

/** The first screen of a computer with no server: it spends a code of `tommy pair`. */
export function DevicePairing(props: DevicePairingProps) {
  const { t, errorMessage } = useText();
  const [address, setAddress] = createSignal(props.defaultAddress);
  const [code, setCode] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);
  const loading = () => props.state.status === "loading";

  /** A pasted `tommy://pair` link holds both values. */
  function readInput(value: string, set: (value: string) => void): void {
    setError(null);
    const link = parseDirectPairingLink(value.trim());
    if (!link) {
      set(value);
      return;
    }
    setAddress(link.url);
    setCode(link.code);
  }

  async function submit(): Promise<void> {
    if (pending()) return;
    if (!address().trim()) return void setError(t("account.pairing.addressRequired"));
    if (!code().trim()) return void setError(t("account.pairing.codeRequired"));
    setPending(true);
    setError(null);
    try {
      await props.onPair(address(), code());
    } catch (failure) {
      setError(errorMessage(failure, t("account.pairing.failed")));
    } finally {
      setPending(false);
    }
  }

  return (
    <main class="account-login-screen">
      <div class="account-login-shell">
        <header class="account-login-brand-lockup">
          <AppLogo variant={props.variant} class="account-login-logo" />
          <span class="account-login-wordmark">{PRODUCT_NAME}</span>
        </header>
        <section class="account-login" aria-labelledby="device-pairing-title">
          <h1 id="device-pairing-title" class="account-login-title">
            {t("account.pairing.title")}
          </h1>
          <p class="account-login-description">{t("account.pairing.description")}</p>
          <form
            class="account-login-form"
            aria-busy={pending() ? "true" : "false"}
            novalidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label class="sr-only" for="device-pairing-address">
              {t("account.pairing.address")}
            </label>
            <Input
              id="device-pairing-address"
              type="text"
              autocapitalize="none"
              spellcheck={false}
              placeholder={t("account.pairing.address")}
              maxlength={2_048}
              value={address()}
              onValueChange={(value) => readInput(value, setAddress)}
            />
            <label class="sr-only" for="device-pairing-code">
              {t("account.pairing.code")}
            </label>
            <Input
              id="device-pairing-code"
              type="text"
              autocomplete="one-time-code"
              autocapitalize="characters"
              spellcheck={false}
              placeholder={t("account.pairing.code")}
              maxlength={2_048}
              value={code()}
              autofocus
              onValueChange={(value) => readInput(value, setCode)}
            />
            <Show when={error()}>
              {(message) => (
                <p class="account-login-error" role="alert">
                  {message()}
                </p>
              )}
            </Show>
            <Button variant="default" type="submit" class="account-login-primary" disabled={pending() || loading()}>
              <Show when={pending()} fallback={t("account.pairing.submit")}>
                <span class="account-login-button-spinner" aria-hidden="true" />
                {t("account.pairing.connecting")}
              </Show>
            </Button>
          </form>
        </section>
        <Show when={props.onChangeLanguage && props.language}>
          {(language) => (
            <Button
              type="button"
              class="account-login-language"
              variant="ghost"
              size="sm"
              lang={appLanguageOption(language()).lang}
              title={t("account.language.change")}
              onClick={() => props.onChangeLanguage?.()}
            >
              <Globe2 size={14} aria-hidden="true" />
              {appLanguageOption(language()).label}
            </Button>
          )}
        </Show>
      </div>
    </main>
  );
}
