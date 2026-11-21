import { type AppLanguagePreference, DEFAULT_APP_LANGUAGE } from "@tommy/contracts/ipc";
import { type AppTranslate, resolveLocale, type TranslatedLocale, translateFor } from "@tommy/i18n";
import { Effect } from "effect";
import { readLanguagePreference } from "./language-preference-store";
import type { PreferenceFileFailure } from "./preference-file";

/** Translate server responses using the saved language and the host locale. */
export class LanguageService {
  readonly #path: string;
  readonly #systemLocale: string;
  #preference: AppLanguagePreference = { language: DEFAULT_APP_LANGUAGE };
  #translate: AppTranslate;

  constructor(input: { path: string; systemLocale: string }) {
    this.#path = input.path;
    this.#systemLocale = input.systemLocale;
    this.#translate = translateFor(this.locale);
  }

  /**
   * One indirection so a caller can hold `translate` for the life of the process and still read the
   * current language. A module that captured the translator itself would keep drawing the language
   * that was set when it started.
   */
  readonly translate: AppTranslate = (key, ...params) => this.#translate(key, ...params);

  get preference(): AppLanguagePreference {
    return { ...this.#preference };
  }

  get locale(): TranslatedLocale {
    return resolveLocale(this.#preference.language, this.#systemLocale);
  }

  /** Read the saved preference. Called once at startup, before services start. */
  load(): Effect.Effect<AppLanguagePreference, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      this.#apply(yield* readLanguagePreference(this.#path));
      return this.preference;
    });
  }

  #apply(preference: AppLanguagePreference): void {
    this.#preference = preference;
    this.#translate = translateFor(this.locale);
  }
}
