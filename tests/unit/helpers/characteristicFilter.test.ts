import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import {
  characteristicFilterSql,
  parseCharacteristicFilter,
  resolveCharacteristicFilter,
  type CharacteristicFilterEntry,
} from '@helpers/characteristicFilter.js';
import { FILTER_ENTRIES_MAX, FILTER_ENTRY_MAX_LENGTH, FILTER_VALUES_MAX } from '@config/limits.js';
import { MAX_ID } from '@schemas/idPathParam.js';

import { rejectedBy, thrownBy } from '../../helpers/errors.js';

// The filter by characteristics of the catalog: `f=<attributeId>:<value>`, one entry for a
// characteristic, the parameter may repeat. A choice from a list is the ids of its values separated
// by commas (`12:45,46`), a number a range with both ends included (`15:128..512`, `128..`, `..512`,
// `6.1..6.7`), yes/no is `yes` or `no` (`20:yes`). Syntax is checked here; the database tells the
// type of a characteristic, which the resolver checks (the part of the tests that needs the
// database: tests/integration/api/products/catalogFilter.test.ts)

const detailsOf = (raw: Parameters<typeof parseCharacteristicFilter>[0]) => {
  const err = thrownBy(() => parseCharacteristicFilter(raw)) as {
    statusCode: number;
    errorCode: string;
    details: Record<string, unknown>;
  };
  expect(err).toMatchObject({ statusCode: 400, errorCode: 'FILTER_INVALID' });

  return err.details;
};

describe('parseCharacteristicFilter', () => {
  describe('what is valid', () => {
    it('gives no entries when there is no filter', () => {
      expect(parseCharacteristicFilter(undefined)).toEqual([]);
      expect(parseCharacteristicFilter([])).toEqual([]);
    });

    it('takes one value of a list', () => {
      expect(parseCharacteristicFilter('12:45')).toEqual([
        { kind: 'values', attributeId: 12, optionIds: [45], entry: '12:45' },
      ]);
    });

    it('takes many values of a list, in the order they come', () => {
      expect(parseCharacteristicFilter('12:46,45,47')).toEqual([
        { kind: 'values', attributeId: 12, optionIds: [46, 45, 47], entry: '12:46,45,47' },
      ]);
    });

    it('keeps a value that is named twice once', () => {
      expect(parseCharacteristicFilter('12:45,46,45')).toEqual([
        { kind: 'values', attributeId: 12, optionIds: [45, 46], entry: '12:45,46,45' },
      ]);
    });

    it('takes the biggest id of a row', () => {
      expect(parseCharacteristicFilter(`${MAX_ID}:${MAX_ID}`)).toMatchObject([
        { attributeId: MAX_ID, optionIds: [MAX_ID] },
      ]);
    });

    it.each([
      ['a closed range', '15:128..512', '128', '512'],
      ['a range that starts', '15:128..', '128', null],
      ['a range that ends', '15:..512', null, '512'],
      ['a range of decimals', '15:6.1..6.7', '6.1', '6.7'],
      ['a range of one number', '15:5..5', '5', '5'],
      ['a range of negative numbers', '15:-20..-5', '-20', '-5'],
      ['a range across zero', '15:-2.5..2.5', '-2.5', '2.5'],
      ['a range that ends below zero', '15:..-1', null, '-1'],
      ['a decimal that ends the range', '15:0.001..', '0.001', null],
    ])('takes %s', (_case, raw, from, to) => {
      expect(parseCharacteristicFilter(raw)).toEqual([
        { kind: 'range', attributeId: 15, from, to, entry: raw },
      ]);
    });

    it.each([
      ['yes', true],
      ['no', false],
      ['YES', true],
      ['No', false],
    ])('takes %s of a yes/no characteristic', (word, value) => {
      expect(parseCharacteristicFilter(`20:${word}`)).toEqual([
        { kind: 'boolean', attributeId: 20, value, entry: `20:${word}` },
      ]);
    });

    it('takes the parameter once, as a text, or many times, as a list', () => {
      const entries = parseCharacteristicFilter(['12:45,46', '15:128..512', '20:yes']);

      expect(entries.map((entry) => [entry.kind, entry.attributeId])).toEqual([
        ['values', 12],
        ['range', 15],
        ['boolean', 20],
      ]);
      expect(parseCharacteristicFilter('12:45,46')).toEqual([entries[0]]);
    });

    it('ignores the spaces around the parts', () => {
      expect(parseCharacteristicFilter('  12 : 45 , 46  ')).toEqual([
        { kind: 'values', attributeId: 12, optionIds: [45, 46], entry: '12 : 45 , 46' },
      ]);
      expect(parseCharacteristicFilter(' 15 : 128 .. 512 ')).toMatchObject([
        { kind: 'range', from: '128', to: '512' },
      ]);
      expect(parseCharacteristicFilter(' 20 :  yes ')).toMatchObject([
        { kind: 'boolean', value: true },
      ]);
    });

    it('takes as many entries as the limit lets', () => {
      const raw = Array.from({ length: FILTER_ENTRIES_MAX }, (_, index) => `${index + 1}:yes`);

      expect(parseCharacteristicFilter(raw)).toHaveLength(FILTER_ENTRIES_MAX);
    });

    it('takes as many values of a list as the limit lets', () => {
      const ids = Array.from({ length: FILTER_VALUES_MAX }, (_, index) => index + 1);

      const [entry] = parseCharacteristicFilter(`7:${ids.join(',')}`) as [
        Extract<CharacteristicFilterEntry, { kind: 'values' }>,
      ];

      expect(entry.optionIds).toEqual(ids);
    });
  });

  describe('what is refused', () => {
    it.each([
      ['no colon', '12'],
      ['no characteristic', ':45'],
      ['a characteristic that is no number', 'colour:45'],
      ['a characteristic of zero', '0:45'],
      ['a characteristic with a leading zero', '012:45'],
      ['a negative characteristic', '-12:45'],
      ['a characteristic over the biggest id', `${MAX_ID + 1}:45`],
      ['an empty text', ''],
      ['spaces only', '   '],
      ['a text with a space inside an id', '1 2:45'],
    ])('refuses %s as an entry that is no entry', (_case, raw) => {
      expect(detailsOf(raw)).toMatchObject({ reason: 'ENTRY_INVALID' });
    });

    it('names the entry that is wrong', () => {
      expect(detailsOf(['12:45', 'colour:45'])).toEqual({
        reason: 'ENTRY_INVALID',
        entry: 'colour:45',
        index: 1,
      });
    });

    it.each([
      ['no value', '12:'],
      ['only spaces for a value', '12:   '],
      ['a value that is no id', '12:black'],
      ['an id of zero', '12:0'],
      ['an id with a leading zero', '12:045'],
      ['a negative id', '12:-45'],
      ['an id over the biggest id', `12:${MAX_ID + 1}`],
      ['an id in the exponent form', '12:1e3'],
      ['a decimal where ids stand', '12:4.5'],
      ['an empty value in the middle', '12:45,,46'],
      ['a comma at the end', '12:45,'],
      ['a comma at the start', '12:,45'],
      ['a semicolon for a comma', '12:45;46'],
      ['a range without ends', '15:..'],
      ['a number without its integer part', '15:.5..9'],
      ['a number without its decimals', '15:5...9'],
      ['a number in the exponent form', '15:1e3..2e3'],
      ['a plus sign', '15:+5..9'],
      ['a range of three numbers', '15:1..2..3'],
      ['a range with a word', '15:a..b'],
      ['a comma in a range', '15:1,5..9'],
      ['true for yes', '20:true'],
      ['a word that is no answer', '20:maybe'],
      ['two answers', '20:yes,no'],
    ])('refuses %s as a value that is wrong', (_case, raw) => {
      expect(detailsOf(raw)).toMatchObject({ reason: 'VALUE_INVALID', entry: raw.trim() });
    });

    it('refuses a range that ends before it starts', () => {
      expect(detailsOf('15:512..128')).toEqual({
        reason: 'RANGE_ORDER',
        entry: '15:512..128',
        index: 0,
        attributeId: 15,
      });
      expect(detailsOf('15:6.7..6.1')).toMatchObject({ reason: 'RANGE_ORDER' });
      expect(detailsOf('15:-5..-20')).toMatchObject({ reason: 'RANGE_ORDER' });
    });

    it('compares the ends of a range as numbers, not as texts', () => {
      // as texts "9" is above "10"
      expect(parseCharacteristicFilter('15:9..10')).toMatchObject([{ from: '9', to: '10' }]);
      expect(detailsOf('15:10..9')).toMatchObject({ reason: 'RANGE_ORDER' });
      expect(parseCharacteristicFilter('15:5.0..5')).toMatchObject([{ from: '5.0', to: '5' }]);
    });

    it('refuses two entries for one characteristic, whatever their form', () => {
      expect(detailsOf(['12:45', '12:46'])).toEqual({
        reason: 'ATTRIBUTE_REPEATED',
        entry: '12:46',
        index: 1,
        attributeId: 12,
      });
      expect(detailsOf(['12:45', '15:1..2', '12:yes'])).toMatchObject({
        reason: 'ATTRIBUTE_REPEATED',
        index: 2,
        attributeId: 12,
      });
      expect(detailsOf(['12:45', '12:45'])).toMatchObject({ reason: 'ATTRIBUTE_REPEATED' });
    });

    it('refuses more entries than the limit lets, before it reads them', () => {
      const raw = Array.from({ length: FILTER_ENTRIES_MAX + 1 }, (_, index) => `${index + 1}:yes`);

      expect(detailsOf(raw)).toEqual({
        reason: 'TOO_MANY_ENTRIES',
        max: FILTER_ENTRIES_MAX,
        have: FILTER_ENTRIES_MAX + 1,
      });
      // a huge list of entries that are all wrong is refused for its number
      expect(detailsOf(Array.from({ length: 10_000 }, () => 'x'))).toMatchObject({
        reason: 'TOO_MANY_ENTRIES',
        have: 10_000,
      });
    });

    it('refuses more values of a list than the limit lets', () => {
      const ids = Array.from({ length: FILTER_VALUES_MAX + 1 }, (_, index) => index + 1);

      expect(detailsOf(`7:${ids.join(',')}`)).toMatchObject({
        reason: 'TOO_MANY_VALUES',
        attributeId: 7,
        max: FILTER_VALUES_MAX,
        index: 0,
      });
    });

    it('refuses an entry that is too long without reading it', () => {
      const long = `7:${'1,'.repeat(FILTER_ENTRY_MAX_LENGTH)}1`;

      const details = detailsOf(long);

      expect(details).toEqual({
        reason: 'ENTRY_TOO_LONG',
        index: 0,
        max: FILTER_ENTRY_MAX_LENGTH,
        length: long.length,
      });
      // the text of the entry is not sent back
      expect(JSON.stringify(details)).not.toContain('1,1,1');
    });

    it('refuses a huge text at once', () => {
      const started = Date.now();

      expect(detailsOf('1:' + '9'.repeat(2_000_000))).toMatchObject({ reason: 'ENTRY_TOO_LONG' });
      expect(detailsOf('x'.repeat(5_000_000))).toMatchObject({ reason: 'ENTRY_TOO_LONG' });
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('refuses a number that is too long for the database to hold a bound', () => {
      expect(detailsOf(`15:${'9'.repeat(40)}..`)).toMatchObject({ reason: 'VALUE_INVALID' });
    });

    it('refuses what the query could hold that is no text', () => {
      expect(detailsOf([5 as unknown as string])).toMatchObject({
        reason: 'ENTRY_INVALID',
        index: 0,
      });
      expect(detailsOf({ a: 1 } as unknown as string)).toMatchObject({ reason: 'ENTRY_INVALID' });
    });
  });
});

describe('characteristicFilterSql', () => {
  const sqlText = (sql: Prisma.Sql) => sql.sql.replace(/\s+/g, ' ').trim();

  it('gives a condition for each entry, on the variant alias it is given', () => {
    const entries = parseCharacteristicFilter(['12:45,46', '15:128..512', '20:yes']);

    const conditions = characteristicFilterSql(entries, 'v');

    expect(conditions).toHaveLength(3);
    for (const condition of conditions) {
      expect(sqlText(condition)).toContain('FROM "variant_attribute_values" fv');
      expect(sqlText(condition)).toContain('fv."variantId" = v."id"');
      expect(sqlText(condition)).toMatch(/^EXISTS \(SELECT 1 /);
    }
  });

  it('uses another alias of the variant when it is given', () => {
    const [condition] = characteristicFilterSql(parseCharacteristicFilter('12:45'), 'sv');

    expect(sqlText(condition!)).toContain('fv."variantId" = sv."id"');
  });

  it('matches any of the values of a list, by their ids', () => {
    const [condition] = characteristicFilterSql(parseCharacteristicFilter('12:45,46'), 'v');

    expect(sqlText(condition!)).toContain('fv."attributeId" = ? AND fv."optionId" IN (?,?)');
    expect(condition!.values).toEqual([12, 45, 46]);
  });

  it('holds a number between its ends, both included, an open end left out', () => {
    const [closed] = characteristicFilterSql(parseCharacteristicFilter('15:128..512'), 'v');
    const [from] = characteristicFilterSql(parseCharacteristicFilter('15:128..'), 'v');
    const [to] = characteristicFilterSql(parseCharacteristicFilter('15:..512'), 'v');

    expect(sqlText(closed!)).toContain('fv."numberValue" >= ?::numeric');
    expect(sqlText(closed!)).toContain('fv."numberValue" <= ?::numeric');
    expect(closed!.values).toEqual([15, '128', '512']);
    expect(sqlText(from!)).toContain('>= ?::numeric');
    expect(sqlText(from!)).not.toContain('<=');
    expect(from!.values).toEqual([15, '128']);
    expect(sqlText(to!)).toContain('<= ?::numeric');
    expect(sqlText(to!)).not.toContain('>=');
    expect(to!.values).toEqual([15, '512']);
  });

  it('matches yes or no', () => {
    const [yes] = characteristicFilterSql(parseCharacteristicFilter('20:yes'), 'v');
    const [no] = characteristicFilterSql(parseCharacteristicFilter('20:no'), 'v');

    expect(sqlText(yes!)).toContain('fv."boolValue" = ?');
    expect(yes!.values).toEqual([20, true]);
    expect(no!.values).toEqual([20, false]);
  });

  it('passes every value as a parameter, never inside the text of the query', () => {
    const entries = parseCharacteristicFilter(['12:45,46', '15:128..512', '20:yes']);

    const text = characteristicFilterSql(entries, 'v')
      .map((condition) => sqlText(condition))
      .join(' ');

    expect(text).not.toMatch(/45|46|128|512/);
  });

  it('gives nothing for no entries', () => {
    expect(characteristicFilterSql([], 'v')).toEqual([]);
  });
});

describe('resolveCharacteristicFilter', () => {
  it('asks the database nothing when there is no entry', async () => {
    const db = {
      $queryRaw: () => {
        throw new Error('the database must not be asked');
      },
    };

    await expect(resolveCharacteristicFilter(db as never, [])).resolves.toBeUndefined();
  });

  // the types of the characteristics and the ownership of the values come in one query
  it('reads the characteristics and the values of the entries with one query', async () => {
    const calls: unknown[] = [];
    const db = {
      $queryRaw: async (...args: unknown[]) => {
        calls.push(args);
        return [
          { id: 12, type: 'option', optionIds: [45, 46] },
          { id: 15, type: 'number', optionIds: [] },
          { id: 20, type: 'boolean', optionIds: [] },
        ];
      },
    };
    const entries = parseCharacteristicFilter(['12:45,46', '15:1..2', '20:no']);

    await resolveCharacteristicFilter(db as never, entries);

    expect(calls).toHaveLength(1);
  });

  const resolveWith = (
    rows: { id: number; type: string; optionIds: number[] }[],
    raw: string | string[],
  ) =>
    rejectedBy(() =>
      resolveCharacteristicFilter(
        { $queryRaw: async () => rows } as never,
        parseCharacteristicFilter(raw),
      ),
    );

  it('refuses a characteristic that is not there', async () => {
    const err = (await resolveWith([], '12:45')) as { details: unknown; errorCode: string };

    expect(err).toMatchObject({ statusCode: 400, errorCode: 'FILTER_INVALID' });
    expect(err.details).toEqual({
      reason: 'ATTRIBUTE_NOT_FOUND',
      entry: '12:45',
      index: 0,
      attributeId: 12,
    });
  });

  it('refuses a text, which cannot be filtered', async () => {
    const err = (await resolveWith([{ id: 12, type: 'text', optionIds: [] }], '12:45')) as {
      details: unknown;
    };

    expect(err.details).toEqual({
      reason: 'ATTRIBUTE_NOT_FILTERABLE',
      entry: '12:45',
      index: 0,
      attributeId: 12,
      type: 'text',
    });
  });

  it.each([
    ['option', '12:1..2', 'a list of the ids of its values'],
    ['options', '12:yes', 'a list of the ids of its values'],
    ['number', '12:5', 'a range, from..to'],
    ['number', '12:yes', 'a range, from..to'],
    ['boolean', '12:5', 'yes or no'],
    ['boolean', '12:1..2', 'yes or no'],
  ])('refuses the form of an entry that does not fit a %s (%s)', async (type, raw, expected) => {
    const err = (await resolveWith([{ id: 12, type, optionIds: [] }], raw)) as { details: unknown };

    expect(err.details).toEqual({
      reason: 'VALUE_FORM_MISMATCH',
      entry: raw,
      index: 0,
      attributeId: 12,
      type,
      expected,
    });
  });

  it('refuses the values that are not the values of the characteristic', async () => {
    const err = (await resolveWith(
      [{ id: 12, type: 'option', optionIds: [45] }],
      '12:45,46,47',
    )) as {
      details: unknown;
    };

    expect(err.details).toEqual({
      reason: 'OPTION_NOT_FOUND',
      entry: '12:45,46,47',
      index: 0,
      attributeId: 12,
      optionIds: [46, 47],
    });
  });

  it('accepts entries that all fit', async () => {
    const rows = [
      { id: 12, type: 'option', optionIds: [45, 46] },
      { id: 13, type: 'options', optionIds: [50] },
      { id: 15, type: 'number', optionIds: [] },
      { id: 20, type: 'boolean', optionIds: [] },
    ];
    const entries = parseCharacteristicFilter(['12:45,46', '13:50', '15:1..2', '20:no']);

    await expect(
      resolveCharacteristicFilter({ $queryRaw: async () => rows } as never, entries),
    ).resolves.toBeUndefined();
  });

  it('names the first entry that is wrong, by its place', async () => {
    const err = (await resolveWith(
      [
        { id: 12, type: 'option', optionIds: [45] },
        { id: 15, type: 'number', optionIds: [] },
      ],
      ['12:45', '15:5'],
    )) as { details: unknown };

    expect(err.details).toMatchObject({ reason: 'VALUE_FORM_MISMATCH', index: 1 });
  });
});
