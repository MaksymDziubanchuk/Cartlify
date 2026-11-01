import { BadRequestError } from '@utils/errors.js';

// the parties a product names: the manufacturer and the person responsible in the EU (GPSR). A
// party is a name, a postal address, an email and a country, kept once in the directory and shared
// by every product that names it. db/06 holds the same values, so a row that comes here valid is
// valid there

export type PartyValues = { name: string; address: string; email: string; country: string };

const FIELDS = ['name', 'address', 'email', 'country'] as const;

// the countries of the EU, by their ISO 3166 codes: a manufacturer outside them names a person
// responsible in the EU
export const EU_COUNTRIES = [
  'AT',
  'BE',
  'BG',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
] as const;

export const isEuCountry = (country: string): boolean =>
  (EU_COUNTRIES as readonly string[]).includes(country);

// the longest values, in signs
export const PARTY_LIMITS = { name: 200, address: 500, email: 254 } as const;
export const WARNINGS_MAX = 2000;

export const PARTY_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PARTY_COUNTRY_PATTERN = /^[A-Z]{2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const pathOf = (path: string, key: string) => (path ? `${path}.${key}` : key);

// the signs a person sees, as the database counts them
const signsOf = (value: string) => [...value].length;

// the values of a party as they are kept: trimmed, the country in capitals.
// required: the four values come whole (a missing or empty one is 400 PARTY_FIELDS_REQUIRED);
// otherwise only the values named are checked and given, and a named one that is empty is refused.
// What is wrong is 400 PARTY_FIELDS_INVALID. Both carry details.fields, the paths of the values
export function normalizeParty(input: unknown, opts: { path: string; required: true }): PartyValues;
export function normalizeParty(
  input: unknown,
  opts: { path: string; required: false },
): Partial<PartyValues>;
export function normalizeParty(
  input: unknown,
  opts: { path: string; required: boolean },
): Partial<PartyValues> {
  const record = isRecord(input) ? input : {};
  const values: Partial<PartyValues> = {};
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const key of FIELDS) {
    const raw = record[key];
    const name = pathOf(opts.path, key);

    if (raw === undefined || raw === null) {
      if (opts.required) missing.push(name);
      continue;
    }
    if (typeof raw !== 'string') {
      invalid.push(name);
      continue;
    }

    const value = raw.trim();
    if (!value) {
      (opts.required ? missing : invalid).push(name);
      continue;
    }

    if (key === 'country') {
      const country = value.toUpperCase();
      if (PARTY_COUNTRY_PATTERN.test(country)) values.country = country;
      else invalid.push(name);
    } else if (signsOf(value) > PARTY_LIMITS[key]) {
      invalid.push(name);
    } else if (key === 'email' && !PARTY_EMAIL_PATTERN.test(value)) {
      invalid.push(name);
    } else {
      values[key] = value;
    }
  }

  if (missing.length) throw new BadRequestError('PARTY_FIELDS_REQUIRED', { fields: missing });
  if (invalid.length) throw new BadRequestError('PARTY_FIELDS_INVALID', { fields: invalid });

  return values;
}

// the warnings of a product: text, trimmed; nothing, an empty text and a text of spaces are none
export function normalizeWarnings(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') throw new BadRequestError('PRODUCT_WARNINGS_INVALID');

  const text = input.trim();
  if (!text) return null;
  if (signsOf(text) > WARNINGS_MAX) {
    throw new BadRequestError('PRODUCT_WARNINGS_TOO_LONG', { max: WARNINGS_MAX });
  }

  return text;
}

// the text fields of a form under a prefix, manufacturer.name and so on, as the object of a json
// body; undefined when the form has none of them
export function partyFromFormFields(
  fields: Map<string, string>,
  prefix: string,
): Record<string, string> | undefined {
  const start = `${prefix}.`;
  const values: Record<string, string> = {};
  let found = false;

  for (const [name, value] of fields) {
    if (!name.startsWith(start)) continue;
    values[name.slice(start.length)] = value;
    found = true;
  }

  return found ? values : undefined;
}
