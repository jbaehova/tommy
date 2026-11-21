import type { TranslatedLocale } from "./locale";
import type { PartialTranslation } from "./message";
import { type AppMessages, en } from "./messages/en/index";
import { ko } from "./messages/ko/index";

const catalogs = { en, ko } as const;

export function appTranslation(locale: TranslatedLocale): PartialTranslation<AppMessages> | undefined {
  return catalogs[locale];
}
