import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { t } from '@config/i18n.js';
import { LOCALES_DIR } from '@config/locales.js';
import { greetingOf } from '@services/email/greeting.js';

// t() of @config/i18n.js: the phrase of a key in a language, the values slotted in as they are;
// and every key the code asks for is one the base dictionary holds, since t() throws on a key no
// dictionary has (a mail would fail to go, not show the key)

const SRC_DIR = path.resolve('src');
const PLURAL_SUFFIX = /_(?:zero|one|two|few|many|other)$/;

function flatten(value: unknown, prefix = ''): string[] {
  return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    return inner !== null && typeof inner === 'object' ? flatten(inner, full) : [full];
  });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const enKeys = flatten(JSON.parse(readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8')));
// a plural key is asked for by its base (t('x', { count })), the dictionary holds x_one, x_other
const enBaseKeys = new Set(enKeys.map((key) => key.replace(PLURAL_SUFFIX, '')));

// the calls of t() in the files that import it: a key written out ('a.b' or `a.b`), and the
// fixed start of a key built from a value (`a.${code}`)
const callers = sourceFiles(SRC_DIR).filter((file) =>
  readFileSync(file, 'utf8').includes("from '@config/i18n.js'"),
);
const literalKeys = new Set<string>();
const keyPrefixes = new Set<string>();
for (const file of callers) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\bt\(\s*(['"])([^'"]+)\1/g)) literalKeys.add(match[2]!);
  for (const match of text.matchAll(/\bt\(\s*`([^`$]*)(\$\{)?/g)) {
    if (match[2]) keyPrefixes.add(match[1]!);
    else literalKeys.add(match[1]!);
  }
}

describe('t()', () => {
  it('gives the phrase of the language asked for, the value slotted in', () => {
    expect(t('common.statementLine', 'en', { code: 'R-1' })).toBe('Statement R-1');
  });

  it('throws on a key no dictionary has', () => {
    expect(() => t('common.noSuchKey', 'en')).toThrow('EMAIL_DICTIONARY_KEY_MISSING');
  });

  // a value is what a customer typed (a name, an address, a note): it is not read for the marks
  // of i18next again, a {{...}} or a $t(...) in it stays as it was typed
  it('leaves the marks of i18next inside a value as they are', () => {
    const typed = '{{code}} {{expiresInText}} $t(common.free)';
    expect(t('common.statementLine', 'en', { code: typed })).toBe(`Statement ${typed}`);
  });
});

// a phrase that takes another one in (a period, a way of paying) needs it in the case its
// sentence asks for: Ukrainian "протягом" takes the genitive, "надіслали ... готівкою" the
// instrumental
describe('the phrases slotted into other phrases', () => {
  it.each([
    [1, 'протягом 1 дня після'],
    [3, 'протягом 3 днів після'],
    [14, 'протягом 14 днів після'],
    [21, 'протягом 21 дня після'],
  ])('puts a Ukrainian period of %i days in the genitive', (count, expected) => {
    const period = t('withdrawal.daysCount', 'uk', { count });
    expect(t('withdrawal.periodAfterReceipt', 'uk', { period })).toContain(expected);
  });

  it('puts the period of a contract in the genitive in Ukrainian', () => {
    const period = t('withdrawal.contractPeriod', 'uk');
    expect(t('withdrawal.periodAfterDelivery', 'uk', { period })).toContain(
      'протягом строку вашого договору',
    );
  });

  it.each([
    ['uk', 'bank_transfer', 'Ми надіслали кошти банківським переказом.'],
    ['uk', 'cash', 'Ми надіслали кошти готівкою.'],
    ['uk', 'other', 'Ми надіслали кошти іншим способом.'],
    ['es', 'bank_transfer', 'Lo enviamos por transferencia bancaria.'],
    ['es', 'cash', 'Lo enviamos en efectivo.'],
    ['es', 'other', 'Lo enviamos por otro medio.'],
    ['en', 'cash', 'We sent it by cash.'],
  ])('names the way money went in the words its sentence takes (%s, %s)', (locale, way, text) => {
    expect(
      t('returnRefunded.sentNoDate', locale, { way: t(`returnWayWords.${way}`, locale) }),
    ).toBe(text);
  });
});

describe('greetingOf', () => {
  it.each([
    ['en', 'Anna', 'Hi Anna,'],
    ['en', null, 'Hi,'],
    ['uk', 'Анна', 'Привіт, Анна!'],
    ['uk', '  ', 'Привіт!'],
    ['es', 'Ana', 'Hola, Ana:'],
    ['es', undefined, 'Hola:'],
  ])('greets in %s by the name %p the way the language sets a name off', (locale, name, line) => {
    expect(greetingOf(name, locale)).toBe(line);
  });
});

describe('the keys the code asks t() for', () => {
  it('finds the calls it checks', () => {
    expect(callers.length).toBeGreaterThan(10);
    expect(literalKeys.size).toBeGreaterThan(100);
    expect(keyPrefixes.size).toBeGreaterThan(3);
  });

  it('asks only for keys the base dictionary holds', () => {
    const missing = [...literalKeys].filter((key) => !enBaseKeys.has(key)).sort();
    expect(missing).toEqual([]);
  });

  it('builds a key only from a start some key of the base dictionary has', () => {
    const missing = [...keyPrefixes]
      .filter((prefix) => !enKeys.some((key) => key.startsWith(prefix)))
      .sort();
    expect(missing).toEqual([]);
  });
});
