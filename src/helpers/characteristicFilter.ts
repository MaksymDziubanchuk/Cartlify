import { Prisma } from '@prisma/client';

import { FILTER_ENTRIES_MAX, FILTER_ENTRY_MAX_LENGTH, FILTER_VALUES_MAX } from '@config/limits.js';
import { MAX_ID } from '@schemas/idPathParam.js';
import { BadRequestError } from '@utils/errors.js';

// The filter of the catalog by characteristics: the parameter `f`, one entry for a characteristic,
// the parameter may repeat (`f=12:45,46&f=15:128..512&f=20:yes`). An entry is
// `<attributeId>:<value>`, the value is
// - for a choice from a list (one value or several, a colour too): the ids of its values separated
//   by commas, `12:45,46`; the values of one characteristic are OR;
// - for a number: a range with both ends included, `128..512`, `128..` (from), `..512` (to),
//   decimals `6.1..6.7`, negative numbers `-5..5`;
// - for yes/no: `yes` or `no`.
// Different characteristics are AND. A variant that has no value of a characteristic fits no value
// of it. The catalog (GET /api/products), the list of an admin and the change of the prices by a
// filter (PATCH /api/products) read the parameter the same way, with this module.
//
// Syntax is checked by parseCharacteristicFilter alone; what a characteristic is (its type, the
// values of its list) the database knows, resolveCharacteristicFilter asks it with one query.
// Every refusal is 400 FILTER_INVALID with `details`: `reason` (a code), `entry` (the text of the
// entry), `index` (its place among the entries), and what else helps (`attributeId`, `optionIds`...)

export type CharacteristicFilterEntry =
  // a value of a list, or several of them: the ids
  | { kind: 'values'; attributeId: number; optionIds: number[]; entry: string }
  // a number between two ends, both included; an end that is null is open. The ends stay texts,
  // as they were written: the database compares them as numbers
  | { kind: 'range'; attributeId: number; from: string | null; to: string | null; entry: string }
  | { kind: 'boolean'; attributeId: number; value: boolean; entry: string };

// an id as a path writes it: a whole number from 1, no leading zero
const ID = /^[1-9][0-9]*$/;
// a number as the filter writes it: an optional minus, digits, and digits after a point
const NUMBER = /^-?[0-9]+(\.[0-9]+)?$/;
// numeric(18, 3) holds 15 digits before the point; a longer text is no bound anyone means
const NUMBER_MAX_LENGTH = 30;

const refuse = (details: Record<string, unknown>) => new BadRequestError('FILTER_INVALID', details);

const isId = (text: string) => ID.test(text) && Number(text) <= MAX_ID;

function parseEntry(item: unknown, index: number): CharacteristicFilterEntry {
  if (typeof item !== 'string') throw refuse({ reason: 'ENTRY_INVALID', index });

  // a long text is not read at all, nor sent back
  if (item.length > FILTER_ENTRY_MAX_LENGTH) {
    throw refuse({
      reason: 'ENTRY_TOO_LONG',
      index,
      max: FILTER_ENTRY_MAX_LENGTH,
      length: item.length,
    });
  }

  const entry = item.trim();
  const colon = entry.indexOf(':');
  const idText = colon > 0 ? entry.slice(0, colon).trim() : '';
  if (!isId(idText)) throw refuse({ reason: 'ENTRY_INVALID', entry, index });

  const attributeId = Number(idText);
  const invalid = (reason: string, more: Record<string, unknown> = {}) =>
    refuse({ reason, entry, index, attributeId, ...more });
  const value = entry.slice(colon + 1).trim();
  if (!value) throw invalid('VALUE_INVALID');

  const word = value.toLowerCase();
  if (word === 'yes' || word === 'no') {
    return { kind: 'boolean', attributeId, value: word === 'yes', entry };
  }

  // a range: the first two points divide it; an end is a number or nothing
  const dots = value.indexOf('..');
  if (dots >= 0) {
    const ends = [value.slice(0, dots).trim(), value.slice(dots + 2).trim()];
    const isEnd = (end: string) =>
      end === '' || (end.length <= NUMBER_MAX_LENGTH && NUMBER.test(end));
    if (!ends.every(isEnd) || (ends[0] === '' && ends[1] === '')) throw invalid('VALUE_INVALID');

    const [from, to] = [ends[0] || null, ends[1] || null];
    if (from !== null && to !== null && new Prisma.Decimal(from).gt(to)) {
      throw invalid('RANGE_ORDER');
    }

    return { kind: 'range', attributeId, from, to, entry };
  }

  const tokens = value.split(',').map((token) => token.trim());
  if (tokens.length > FILTER_VALUES_MAX)
    throw invalid('TOO_MANY_VALUES', { max: FILTER_VALUES_MAX });
  if (!tokens.every(isId)) throw invalid('VALUE_INVALID');

  return { kind: 'values', attributeId, optionIds: [...new Set(tokens.map(Number))], entry };
}

// The entries of the parameter `f` (a text, a list of texts when it repeats, undefined when it is
// not there). A characteristic twice, a range that ends before it starts, a text that is no entry,
// more entries or values than the limits let: 400 FILTER_INVALID
export function parseCharacteristicFilter(raw: unknown): CharacteristicFilterEntry[] {
  if (raw === undefined) return [];

  const items: unknown[] = Array.isArray(raw) ? raw : [raw];
  if (items.length > FILTER_ENTRIES_MAX) {
    throw refuse({ reason: 'TOO_MANY_ENTRIES', max: FILTER_ENTRIES_MAX, have: items.length });
  }

  const seen = new Set<number>();

  return items.map((item, index) => {
    const parsed = parseEntry(item, index);
    if (seen.has(parsed.attributeId)) {
      throw refuse({
        reason: 'ATTRIBUTE_REPEATED',
        entry: parsed.entry,
        index,
        attributeId: parsed.attributeId,
      });
    }
    seen.add(parsed.attributeId);

    return parsed;
  });
}

// what the form of an entry has to be for a type of characteristic
const EXPECTED_FORM = {
  option: 'a list of the ids of its values',
  options: 'a list of the ids of its values',
  number: 'a range, from..to',
  boolean: 'yes or no',
} as const;

type FilterableType = keyof typeof EXPECTED_FORM;

const KIND_OF_TYPE: Record<FilterableType, CharacteristicFilterEntry['kind']> = {
  option: 'values',
  options: 'values',
  number: 'range',
  boolean: 'boolean',
};

type AttributeRow = { id: number; type: string; optionIds: number[] | null };

// Checks the entries against the directory, with one query for all of them: the characteristic is
// there (ATTRIBUTE_NOT_FOUND), it is no text (ATTRIBUTE_NOT_FILTERABLE), the entry has the form of
// its type (VALUE_FORM_MISMATCH, `expected`), the values are of its list (OPTION_NOT_FOUND,
// `optionIds`). The first entry that is wrong is named
export async function resolveCharacteristicFilter(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  entries: readonly CharacteristicFilterEntry[],
): Promise<void> {
  if (!entries.length) return;

  const attributeIds = entries.map((entry) => entry.attributeId);
  const optionIds = [
    ...new Set(entries.flatMap((entry) => (entry.kind === 'values' ? entry.optionIds : []))),
  ];

  // of the values asked for, the ones that belong to the characteristic
  const rows = await db.$queryRaw<AttributeRow[]>(Prisma.sql`
    SELECT a."id" AS id,
           a."type"::text AS type,
           COALESCE((
             SELECT array_agg(o."id")
             FROM "attribute_options" o
             WHERE o."attributeId" = a."id" AND o."id" = ANY(${optionIds}::int[])
           ), '{}') AS "optionIds"
    FROM "attributes" a
    WHERE a."id" = ANY(${attributeIds}::int[])
  `);
  const byId = new Map(rows.map((row) => [row.id, row]));

  entries.forEach((entry, index) => {
    const base = { entry: entry.entry, index, attributeId: entry.attributeId };
    const attribute = byId.get(entry.attributeId);
    if (!attribute) throw refuse({ reason: 'ATTRIBUTE_NOT_FOUND', ...base });

    const type = attribute.type;
    if (!(type in EXPECTED_FORM)) {
      throw refuse({ reason: 'ATTRIBUTE_NOT_FILTERABLE', ...base, type });
    }
    if (KIND_OF_TYPE[type as FilterableType] !== entry.kind) {
      throw refuse({
        reason: 'VALUE_FORM_MISMATCH',
        ...base,
        type,
        expected: EXPECTED_FORM[type as FilterableType],
      });
    }

    if (entry.kind === 'values') {
      const own = new Set(attribute.optionIds ?? []);
      const foreign = entry.optionIds.filter((id) => !own.has(id));
      if (foreign.length) throw refuse({ reason: 'OPTION_NOT_FOUND', ...base, optionIds: foreign });
    }
  });
}

// The conditions of the entries for a variant, by the alias of its table (v): one for each entry,
// to join with AND. A variant fits an entry when it has a value of the characteristic that fits.
// The values are parameters; the alias is the code's
export function characteristicFilterSql(
  entries: readonly CharacteristicFilterEntry[],
  alias: string,
): Prisma.Sql[] {
  if (!/^[a-z][a-z0-9]*$/.test(alias)) throw new Error('INVALID_SQL_ALIAS');

  const holds = (attributeId: number, condition: Prisma.Sql) =>
    Prisma.sql`EXISTS (SELECT 1 FROM "variant_attribute_values" fv WHERE fv."variantId" = ${Prisma.raw(alias)}."id" AND fv."attributeId" = ${attributeId} AND ${condition})`;

  return entries.map((entry) => {
    switch (entry.kind) {
      case 'values':
        return holds(
          entry.attributeId,
          Prisma.sql`fv."optionId" IN (${Prisma.join(entry.optionIds)})`,
        );
      case 'boolean':
        return holds(entry.attributeId, Prisma.sql`fv."boolValue" = ${entry.value}`);
      case 'range': {
        const ends: Prisma.Sql[] = [];
        if (entry.from !== null) ends.push(Prisma.sql`fv."numberValue" >= ${entry.from}::numeric`);
        if (entry.to !== null) ends.push(Prisma.sql`fv."numberValue" <= ${entry.to}::numeric`);

        return holds(entry.attributeId, Prisma.join(ends, ' AND '));
      }
      default: {
        const _exhaustive: never = entry;
        return _exhaustive;
      }
    }
  });
}
