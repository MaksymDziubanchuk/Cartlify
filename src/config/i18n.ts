import { readFileSync } from 'node:fs';
import path from 'node:path';

import i18next from 'i18next';

import { AVAILABLE_LOCALES, LOCALES_DIR } from './locales.js';

// the phrases of the mails (and, later, the bot and the shop's own pages), one dictionary per
// language of src/locales; i18next only holds them and picks one by locale, the html and the
// text of a mail stay in its own .html/.txt files (renderTemplate.ts). escapeValue is off: a
// phrase goes through renderTemplate's own escaping once it is slotted into the html, i18next
// escaping it too would double it (&amp; -> &amp;amp;). skipOnVariables (the default of i18next,
// named so a change of it is seen): a value slotted into a phrase is not read for {{...}} or
// $t(...) again, a name or an address a customer typed stays the text they typed
const resources = Object.fromEntries(
  AVAILABLE_LOCALES.map((code) => [
    code,
    { translation: JSON.parse(readFileSync(path.join(LOCALES_DIR, `${code}.json`), 'utf8')) },
  ]),
);

await i18next.init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false, skipOnVariables: true },
});

// the phrase of this key, in this language; a key missing from every dictionary (a mistake in
// the mail, not something a customer should see) throws instead of mailing the key itself
export function t(key: string, locale: string, values: Record<string, unknown> = {}): string {
  const result = i18next.t(key, { lng: locale, ...values });
  if (result === key) throw new Error(`EMAIL_DICTIONARY_KEY_MISSING: ${key}`);
  return result;
}
