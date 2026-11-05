import type { TranslatedLocale } from "./locale";
import type { PartialTranslation } from "./message";
import { type AppMobileMessages, enMobile } from "./messages/en/mobile";

/**
 * The mobile catalog of `locale`, as in `mobile-catalogs.ts`. Metro puts this module in its place.
 * Each language other than English runs its module only when the app first shows that language, so
 * the app does not build the twelve catalogs before its first screen. Metro needs a literal path in
 * each `require`.
 */
export function mobileCatalog(locale: TranslatedLocale): PartialTranslation<AppMobileMessages> {
  switch (locale) {
    case "en":
      return enMobile;
    case "ko": {
      const catalog: typeof import("./messages/ko/mobile") = require("./messages/ko/mobile");
      return catalog.koMobile;
    }
  }
}
