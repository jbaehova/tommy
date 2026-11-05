import type { TranslatedLocale } from "./locale";
import type { PartialTranslation } from "./message";
import { type AppMobileMessages, enMobile } from "./messages/en/mobile";
import { koMobile } from "./messages/ko/mobile";

const catalogs = { en: enMobile, ko: koMobile } as const;

/**
 * The mobile catalog of `locale`. The main process reads this module. Metro reads
 * `mobile-catalogs.native.ts`, which loads a language only when the app first shows it.
 */
export function mobileCatalog(locale: TranslatedLocale): PartialTranslation<AppMobileMessages> {
  return catalogs[locale];
}
