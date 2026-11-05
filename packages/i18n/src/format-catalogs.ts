import type { TranslatedLocale } from "./locale";
import type { PartialTranslation } from "./message";
import { messages as en } from "./messages/en/format";
import { messages as ko } from "./messages/ko/format";

const catalogs = { en, ko } as const;

/** The format catalog of `locale`, or `undefined` while it is not loaded. See `app-catalogs.ts`. */
export function formatTranslation(locale: TranslatedLocale): PartialTranslation<typeof en> | undefined {
  return catalogs[locale];
}
