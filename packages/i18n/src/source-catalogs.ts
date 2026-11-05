import type { TranslatedLocale } from "./locale";
import type { PartialTranslation } from "./message";
import { source as en } from "./messages/en/source";
import { source as ko } from "./messages/ko/source";

const catalogs = { en, ko } as const;

/** The source catalog of `locale`, or `undefined` while it is not loaded. See `app-catalogs.ts`. */
export function sourceTranslation(locale: TranslatedLocale): PartialTranslation<typeof en> | undefined {
  return catalogs[locale];
}
