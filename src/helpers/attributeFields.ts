import { BadRequestError } from '@utils/errors.js';

// the values of the directory of characteristics (src/routes/api/attributes): the names, the unit,
// the colour of a value, the settings of a number. db/06 holds the same values, so a value that
// comes here valid is valid there

export const ATTRIBUTE_TYPES = ['text', 'number', 'boolean', 'option', 'options'] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

// the types that can split the products of a list into rows by their value: a text and a set of
// values cannot
export const MAIN_ATTRIBUTE_TYPES: readonly AttributeType[] = ['number', 'boolean', 'option'];

// the types whose values come from a list
export const CHOICE_ATTRIBUTE_TYPES: readonly AttributeType[] = ['option', 'options'];

export const DIRECTORY_NAME_MAX = 100;
export const UNIT_MAX = 20;
export const DECIMALS_MAX = 3;
// the rows a request that orders a scope names at most (a scope is a directory, not a catalog)
export const ORDER_IDS_MAX = 5000;
// the characteristics one category asks for at most (its own, the parents' are not counted)
export const CATEGORY_ATTRIBUTES_MAX = 100;
// the bounds of a number fit numeric(18, 3): 15 digits before the point and 3 after it
export const NUMBER_BOUND_MAX = 999_999_999_999_999;

export const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

export type DirectoryKind = 'ATTRIBUTE_GROUP' | 'ATTRIBUTE' | 'ATTRIBUTE_OPTION';

const invalid = (kind: DirectoryKind, fields: string[]) =>
  new BadRequestError(`${kind}_FIELDS_INVALID`, { fields });

// a name as it is kept: trimmed, not blank, within DIRECTORY_NAME_MAX signs as a person counts them
export function normalizeDirectoryName(input: unknown, kind: DirectoryKind): string {
  const name = typeof input === 'string' ? input.trim() : '';
  if (!name || [...name].length > DIRECTORY_NAME_MAX) throw invalid(kind, ['name']);

  return name;
}

// the unit of a characteristic: trimmed, blank or null is none, up to UNIT_MAX signs
export function normalizeUnit(input: unknown): string | null {
  if (input === null) return null;

  const unit = typeof input === 'string' ? input.trim() : undefined;
  if (unit === undefined || [...unit].length > UNIT_MAX) throw invalid('ATTRIBUTE', ['unit']);

  return unit || null;
}

// the colour of a value: #RRGGBB, kept in small letters; null is none
export function normalizeColor(input: unknown): string | null {
  if (input === null) return null;

  const color = typeof input === 'string' ? input.trim() : '';
  if (!COLOR_PATTERN.test(color)) throw invalid('ATTRIBUTE_OPTION', ['colorCode']);

  return color.toLowerCase();
}

export type NumberSettings = {
  decimals: number | null;
  minValue: number | null;
  maxValue: number | null;
};

// a bound has at most 3 digits after the point, as the column keeps (numeric(18, 3)): one with more
// would be rounded by the database and never equal what was sent
const isBound = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  Math.abs(value) <= NUMBER_BOUND_MAX &&
  Math.round(value * 1000) / 1000 === value;

// the settings of a characteristic as they are after a request, checked against its type: a number
// has its digits after the point (0 to DECIMALS_MAX, 0 when not said) and may have bounds in order,
// any other type has none of them (400 ATTRIBUTE_FIELDS_INVALID with details.fields). A main
// characteristic is a choice, a number or yes/no (400 ATTRIBUTE_MAIN_NOT_ALLOWED)
export function checkAttributeSettings(input: {
  type: AttributeType;
  isMain: boolean;
  decimals: unknown;
  minValue: unknown;
  maxValue: unknown;
}): NumberSettings {
  const bad: string[] = [];
  const { type } = input;

  if (type !== 'number') {
    if (input.decimals != null) bad.push('decimals');
    if (input.minValue != null) bad.push('minValue');
    if (input.maxValue != null) bad.push('maxValue');
    if (bad.length) throw invalid('ATTRIBUTE', bad);
  }

  if (input.isMain && !MAIN_ATTRIBUTE_TYPES.includes(type)) {
    throw new BadRequestError('ATTRIBUTE_MAIN_NOT_ALLOWED', { type });
  }

  if (type !== 'number') return { decimals: null, minValue: null, maxValue: null };

  const decimals = input.decimals ?? 0;
  if (
    !Number.isInteger(decimals) ||
    (decimals as number) < 0 ||
    (decimals as number) > DECIMALS_MAX
  ) {
    bad.push('decimals');
  }
  if (input.minValue != null && !isBound(input.minValue)) bad.push('minValue');
  if (input.maxValue != null && !isBound(input.maxValue)) bad.push('maxValue');
  if (
    !bad.length &&
    isBound(input.minValue) &&
    isBound(input.maxValue) &&
    input.minValue > input.maxValue
  ) {
    bad.push('minValue', 'maxValue');
  }
  if (bad.length) throw invalid('ATTRIBUTE', bad);

  return {
    decimals: decimals as number,
    minValue: (input.minValue as number | null | undefined) ?? null,
    maxValue: (input.maxValue as number | null | undefined) ?? null,
  };
}

// a new order must name every row of its scope once: what is missing, what is not a row of the
// scope and what comes twice is 400 ORDER_IDS_MISMATCH (details: missing, unknown, repeated)
export function checkOrderIds(current: number[], ids: number[]): void {
  const have = new Set(current);
  const given = new Set(ids);
  const sorted = (list: number[]) => [...new Set(list)].sort((a, b) => a - b);

  const missing = sorted(current.filter((id) => !given.has(id)));
  const unknown = sorted(ids.filter((id) => !have.has(id)));
  const seen = new Set<number>();
  const twice = new Set<number>();
  for (const id of ids) (seen.has(id) ? twice : seen).add(id);
  const repeated = sorted([...twice]);

  if (missing.length || unknown.length || repeated.length) {
    throw new BadRequestError('ORDER_IDS_MISMATCH', { missing, unknown, repeated });
  }
}
