import { isAvailableLocale } from '@config/locales.js';
import { shopSettings } from '@config/shopSettings.js';
import { normalizeLocaleCode } from '@helpers/profileText.js';

// a language a person may be answered in: the shape is right (normalizeLocaleCode), root turned
// it on (shopSettings().enabledLocales) and a dictionary for it still exists (isAvailableLocale,
// defensive: root turning a language on already checks this, src/routes/api/shopSettings)
export function enabledLocaleOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const code = normalizeLocaleCode(raw);
  if (!code) return null;
  return shopSettings().enabledLocales.includes(code) && isAvailableLocale(code) ? code : null;
}

// the language a mail to this person goes in: their own, if it is one the shop answers in;
// otherwise the shop's own language, or "en" if even that one lost its dictionary (a deploy that
// removed a file after root set it; the shop_locale_missing alert tells root and the admins). A
// guest has no locale of their own, so this already gives the shop's language for one
export function mailLocaleOf(userLocale: string | null | undefined): string {
  const own = enabledLocaleOf(userLocale);
  if (own) return own;

  const shop = shopSettings().shopLocale;
  return isAvailableLocale(shop) ? shop : 'en';
}
