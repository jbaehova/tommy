import { appTranslation } from "./app-catalogs";
import type { TranslatedLocale } from "./locale";
import { createTranslate, type MessageParams, type Translate } from "./message";
import { type AppMessages, en } from "./messages/en/index";

export { APP_LANGUAGES, type AppLanguage, DEFAULT_APP_LANGUAGE } from "@tommy/contracts/app-language";
export { resolveLocale, TRANSLATED_LOCALES, type TranslatedLocale } from "./locale";
export {
  createTranslate,
  type Message,
  type MessageCatalog,
  type MessageParams,
  type PartialTranslation,
  type PluralMessage,
  type Translate,
} from "./message";
export type { AppMessages } from "./messages/en/index";
export { localizeSourceText, matchingSourceKeys, type SourceMessages, sourceText } from "./source-text";
export { en };

/** Translates Mini App labels and server messages. */
export type AppTranslate = Translate<AppMessages>;

/** A message key that can be translated without supplying any values. */
export type AppTextKey = {
  [Key in keyof AppMessages]: Record<never, never> extends MessageParams<AppMessages[Key]> ? Key : never;
}[keyof AppMessages];

/** One translator per locale: a screen that reads `t` on every render must not rebuild it. */
const translators = new Map<TranslatedLocale, AppTranslate>();

export function translateFor(locale: TranslatedLocale): AppTranslate {
  const cached = translators.get(locale);
  if (cached) return cached;
  const translation = appTranslation(locale);
  if (!translation) return translateFor("en");
  const translate = createTranslate({ source: en, translation, locale, sourceLocale: "en" });
  translators.set(locale, translate);
  return translate;
}
