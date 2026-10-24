import { BadRequestError } from '@utils/errors.js';

// the description of a product keeps its text and its safety and origin data (the EU GPSR) in one
// column: the manufacturer with its postal and electronic address and its country, a person
// responsible in the EU when the manufacturer is outside it, the warnings. With the data it is a
// json document of its own version; a description from before them is the text as it is

export type ProductSafetyPerson = { name: string; address: string; email: string };

export type ProductSafety = {
  manufacturer: ProductSafetyPerson & { country: string };
  responsiblePerson: ProductSafetyPerson | null;
  warnings: string | null;
};

export type ProductDescription = { text: string | null; safety: ProductSafety | null };

const VERSION = 1;

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

// the longest values of the data, in signs
export const SAFETY_LIMITS = { name: 200, address: 500, email: 254, warnings: 2000 } as const;

export const SAFETY_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const SAFETY_COUNTRY_PATTERN = /^[A-Z]{2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// the description of the column: the json of the data, or a text from before them
export function parseProductDescription(raw: string | null | undefined): ProductDescription {
  if (!raw) return { text: null, safety: null };

  if (raw.startsWith('{')) {
    try {
      const doc: unknown = JSON.parse(raw);
      if (isRecord(doc) && doc.v === VERSION) {
        return {
          text: typeof doc.text === 'string' && doc.text ? doc.text : null,
          safety: isRecord(doc.safety) ? (doc.safety as ProductSafety) : null,
        };
      }
    } catch {
      // a text that only starts like json
    }
  }

  return { text: raw, safety: null };
}

// the column of a description: the json with the data, the text alone without them
export function serializeProductDescription(description: ProductDescription): string | null {
  if (!description.safety) return description.text || null;

  return JSON.stringify({ v: VERSION, text: description.text, safety: description.safety });
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

// the data of a request as they are kept, checked whole: the four fields of the manufacturer, all
// three of a responsible person or none, one for a manufacturer outside the EU, the warnings if
// any. What is missing is 400 PRODUCT_SAFETY_REQUIRED, what is wrong PRODUCT_SAFETY_INVALID, both
// with details.fields; a manufacturer outside the EU alone is PRODUCT_EU_RESPONSIBLE_REQUIRED
export function normalizeProductSafety(input: unknown): ProductSafety {
  const safety = isRecord(input) ? input : {};
  const maker = isRecord(safety.manufacturer) ? safety.manufacturer : {};
  const person = isRecord(safety.responsiblePerson) ? safety.responsiblePerson : {};

  const missing: string[] = [];
  const invalid: string[] = [];

  const field = (
    from: Record<string, unknown>,
    path: string,
    key: keyof typeof SAFETY_LIMITS | 'country',
    required: boolean,
  ) => {
    const value = text(from[key]);
    const name = `${path}.${key}`;
    if (!value) {
      if (required) missing.push(name);
      return value;
    }
    if (key === 'country') {
      if (!SAFETY_COUNTRY_PATTERN.test(value)) invalid.push(name);
    } else if ([...value].length > SAFETY_LIMITS[key]) {
      invalid.push(name);
    } else if (key === 'email' && !SAFETY_EMAIL_PATTERN.test(value)) {
      invalid.push(name);
    }
    return value;
  };

  const manufacturer = {
    name: field(maker, 'safety.manufacturer', 'name', true),
    address: field(maker, 'safety.manufacturer', 'address', true),
    email: field(maker, 'safety.manufacturer', 'email', true),
    country: field(maker, 'safety.manufacturer', 'country', true),
  };

  // a responsible person comes whole or not at all
  const named = ['name', 'address', 'email'].some((key) => text(person[key]));
  const responsiblePerson = named
    ? {
        name: field(person, 'safety.responsiblePerson', 'name', true),
        address: field(person, 'safety.responsiblePerson', 'address', true),
        email: field(person, 'safety.responsiblePerson', 'email', true),
      }
    : null;

  const warnings = text(safety.warnings);
  if ([...warnings].length > SAFETY_LIMITS.warnings) invalid.push('safety.warnings');

  if (missing.length) throw new BadRequestError('PRODUCT_SAFETY_REQUIRED', { fields: missing });
  if (invalid.length) throw new BadRequestError('PRODUCT_SAFETY_INVALID', { fields: invalid });

  if (!responsiblePerson && !(EU_COUNTRIES as readonly string[]).includes(manufacturer.country)) {
    throw new BadRequestError('PRODUCT_EU_RESPONSIBLE_REQUIRED');
  }

  return { manufacturer, responsiblePerson, warnings: warnings || null };
}

// the text fields of a form, safety.manufacturer.name and so on, as the object of a json body;
// undefined when the form has none of them
export function safetyFromFormFields(
  fields: Map<string, string>,
): Record<string, unknown> | undefined {
  if (![...fields.keys()].some((name) => name.startsWith('safety.'))) return undefined;

  const group = (prefix: string) => {
    const values: Record<string, string> = {};
    for (const [name, value] of fields) {
      if (name.startsWith(`${prefix}.`)) values[name.slice(prefix.length + 1)] = value;
    }
    return values;
  };

  return {
    manufacturer: group('safety.manufacturer'),
    responsiblePerson: group('safety.responsiblePerson'),
    warnings: fields.get('safety.warnings') ?? null,
  };
}
