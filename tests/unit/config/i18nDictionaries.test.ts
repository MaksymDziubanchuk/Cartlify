import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { AVAILABLE_LOCALES, LOCALES_DIR } from '@config/locales.js';

// the dictionaries of src/locales must stay in step with each other: every key the base (en)
// holds, every other language holds too (its own phrase, not an empty one), so a mail or a page
// never falls back to English by a missing key instead of by choice. A locale may hold extra
// plural forms of a key the CLDR count of its language needs and English does not (Ukrainian's
// _few/_many next to English's _one/_other): those are not a mistake, only English's own absence

// i18next picks a plural key by replacing its own suffix (_one, _few, _many, _other, _two, _zero)
// with the count it chose; the base key without any of them is what every language must hold
const PLURAL_SUFFIX = /_(?:zero|one|two|few|many|other)$/;

function flatten(value: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const path_ = prefix ? `${prefix}.${key}` : key;
    if (inner !== null && typeof inner === 'object') Object.assign(out, flatten(inner, path_));
    else out[path_] = String(inner);
  }
  return out;
}

const dictionaryOf = (locale: string) =>
  flatten(JSON.parse(readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8')));

const baseKeyOf = (key: string) => key.replace(PLURAL_SUFFIX, '');

describe('the mail and page dictionaries of src/locales', () => {
  const en = dictionaryOf('en');
  const others = AVAILABLE_LOCALES.filter((locale) => locale !== 'en');

  it('answers in more than just English', () => {
    expect(others.length).toBeGreaterThan(0);
  });

  it.each(others)('holds every key English holds, under its own phrase (%s)', (locale) => {
    const dict = dictionaryOf(locale);

    const missing = Object.keys(en).filter((key) => !(key in dict));
    expect(missing).toEqual([]);
  });

  it.each(others)(
    'adds no key English has no base of, under a plural form or not (%s)',
    (locale) => {
      const dict = dictionaryOf(locale);
      const enBaseKeys = new Set(Object.keys(en).map(baseKeyOf));

      const extra = Object.keys(dict).filter(
        (key) => !(key in en) && !enBaseKeys.has(baseKeyOf(key)),
      );
      expect(extra).toEqual([]);
    },
  );

  it.each(AVAILABLE_LOCALES)('leaves no phrase of the dictionary empty (%s)', (locale) => {
    const dict = dictionaryOf(locale);

    const empty = Object.entries(dict)
      .filter(([, phrase]) => phrase.trim() === '')
      .map(([key]) => key);
    expect(empty).toEqual([]);
  });

  it.each(AVAILABLE_LOCALES)(
    'gives every mark of a phrase the same marks as English (%s)',
    (locale) => {
      const dict = dictionaryOf(locale);
      const markOf = /\{\{(\w+)\}\}/g;
      const marksIn = (phrase: string) => [...phrase.matchAll(markOf)].map((m) => m[1]).sort();

      const mismatched = Object.entries(en)
        .filter(([key]) => key in dict)
        .map(([key, phrase]) => [key, marksIn(phrase), marksIn(dict[key]!)] as const)
        .filter(([, enMarks, theirMarks]) => enMarks.join(',') !== theirMarks.join(','))
        .map(([key]) => key);

      expect(mismatched).toEqual([]);
    },
  );
});
