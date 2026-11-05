import type { TranslatedLocale } from "./locale";
import type { PartialTranslation } from "./message";
import { type AppMessages, en } from "./messages/en/index";
import { ko } from "./messages/ko/index";

const catalogs = { en, ko } as const;

/**
 * The desktop catalog of `locale`, or `undefined` while it is not loaded.
 *
 * This build holds every language. The public web build replaces this module with
 * `lazy-catalogs.ts`, which holds English and loads another language on first use.
 */
export function appTranslation(locale: TranslatedLocale): PartialTranslation<AppMessages> | undefined {
  return catalogs[locale];
}
