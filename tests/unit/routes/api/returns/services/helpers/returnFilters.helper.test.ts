import { describe, expect, it } from '@jest/globals';

import {
  andOf,
  returnConditions,
  type ReturnFilters,
} from '@routes/api/returns/services/helpers/returnFilters.helper.js';

// the filters of the list of the statements of return as sql: what each one asks of the statement
// under an alias, that every value is a bound parameter and not text of the sql, and that the
// alerts and the list take their cases from the same conditions

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const DAY = 86_400_000;

const conditions = (filters: ReturnFilters, alias = 'r') => returnConditions(filters, alias, NOW);

const textOf = (filters: ReturnFilters, alias = 'r') =>
  andOf(conditions(filters, alias)).sql.replace(/\s+/g, ' ');

const valuesOf = (filters: ReturnFilters) => andOf(conditions(filters)).values;

describe('returnConditions', () => {
  it('has no condition for no filter, and andOf makes true of it', () => {
    expect(conditions({})).toEqual([]);
    expect(andOf([]).sql).toBe('true');
  });

  it('puts the alias in front of the columns of the statement', () => {
    expect(textOf({ state: 'open' }, 't')).toContain('t."closedAt" is null');
    expect(textOf({ state: 'closed' }, 'r')).toContain('r."closedAt" is not null');
    expect(textOf({ state: 'open' }, 't')).not.toContain('r."closedAt"');
  });

  it.each([
    [{ orderId: 42 }, [42]],
    [{ userId: 7 }, [7]],
    [{ productId: 9 }, [9]],
    [{ variantId: 11 }, [11]],
    [{ source: 'form_manual' as const }, ['form_manual']],
    [{ basis: 'withdrawal' as const }, ['withdrawal']],
    [{ reason: 'defect' as const }, ['defect']],
    [{ money: 'pending' as const }, ['pending']],
  ])('binds the value of %j as a parameter', (filters, values) => {
    expect(valuesOf(filters)).toEqual(values);
    // and writes none of it into the text of the sql
    for (const value of values) expect(textOf(filters)).not.toContain(`'${String(value)}'`);
  });

  it('makes a condition for the goods: waiting, no proof of any kind, proof told, received', () => {
    expect(conditions({ goods: 'waiting' })).toHaveLength(1);
    expect(textOf({ goods: 'waiting_no_proof' })).toContain('"proofProvidedAt" is null');
    // the shop confirming a proof is a proof as well
    expect(textOf({ goods: 'waiting_no_proof' })).toContain('"proofConfirmedAt" is null');
    expect(textOf({ goods: 'proof_provided' })).toContain(
      '"proofProvidedAt" is not null and r."proofConfirmedAt" is null',
    );
    expect(textOf({ goods: 'received' })).toMatch(/^not exists/);
  });

  it('reads failed as a row not refunded whose transfer failed, and any other money as the state of a row', () => {
    expect(textOf({ money: 'failed' })).toContain('i."refundFailure" is not null');
    expect(textOf({ money: 'failed' })).toContain(`i.money = 'not_refunded'`);
    expect(textOf({ money: 'refunded' })).toContain('i.money = ?::cartlify."ReturnMoney"');
    expect(textOf({ money: 'refunded' })).not.toContain('refundFailure');
  });

  it('counts the days from the clock given: the time that many days before it', () => {
    const cutoff = (days: number) => new Date(NOW - days * DAY);

    for (const [filters, days] of [
      [{ olderThanDays: 21 }, 21],
      [{ proofOlderThanDays: 2 }, 2],
      [{ moneyDueForDays: 10 }, 10],
      [{ paidAheadForDays: 14 }, 14],
    ] as const) {
      // the time as the columns keep it: utc, given to the database as an iso text
      expect(valuesOf(filters)).toContain(cutoff(days).toISOString());
    }
  });

  it('is due money: not back, pending, with goods in or the proof confirmed by the shop, after the days', () => {
    const text = textOf({ moneyDueForDays: 10 });

    expect(text).toContain(`'not_refunded'`);
    expect(text).toContain(`'pending'`);
    expect(text).toContain(`'to_stock'`);
    expect(text).toContain('"proofConfirmedAt" is not null');
    expect(text).toContain('"statedAt" <');
  });

  it('is accepted or not: a statement of the form without the code by the check of an admin', () => {
    const waiting = textOf({ accepted: false });
    const accepted = textOf({ accepted: true });

    expect(waiting).toContain(`r.source = 'form_manual'`);
    expect(waiting).toContain('r."acceptedAt" is null');
    expect(accepted).toContain(`r.source = 'form_manual'`);
    expect(accepted).toContain('r."acceptedAt" is not null');
    expect(conditions({})).toEqual([]);
  });

  it('searches a whole number as an order or a name or an email, any other text as a name or an email', () => {
    const byNumber = andOf(conditions({ q: '42' }));
    const byText = andOf(conditions({ q: 'anna' }));

    expect(byNumber.sql).toContain('"orderId" =');
    expect(byNumber.values).toEqual([42, '%42%', '%42%']);
    expect(byText.sql).not.toContain('"orderId" =');
    expect(byText.values).toEqual(['%anna%', '%anna%']);
  });

  it('keeps %, _ and \\ in a text as plain characters', () => {
    const text = 'a%b_c\\d';
    const pattern = '%a\\%b\\_c\\\\d%';

    expect(valuesOf({ q: text })).toEqual([pattern, pattern]);
  });

  it('does not read a number past the int of the database, or one with a zero in front, as an order', () => {
    for (const q of ['2147483648', '007', '0', '12345678901']) {
      expect(andOf(conditions({ q })).sql).not.toContain('"orderId" =');
    }
    expect(andOf(conditions({ q: '2147483647' })).sql).toContain('"orderId" =');
  });

  it('takes a period from its start and to before its end', () => {
    const from = new Date('2026-10-01T00:00:00.000Z');
    const to = new Date('2026-11-01T00:00:00.000Z');

    expect(textOf({ statedFrom: from, statedTo: to })).toMatch(
      /"statedAt" >= .* and .*"statedAt" </,
    );
    expect(textOf({ closedFrom: from })).toContain('"closedAt" >=');
    expect(textOf({ refundedTo: to })).toContain('i."refundedAt" <');
    expect(textOf({ refundedFrom: from })).not.toContain('i."refundedAt" <');
  });

  it('joins the conditions of several filters with and', () => {
    const all = andOf(conditions({ state: 'open', source: 'form_manual', orderId: 3 }));

    expect(all.sql.match(/ and /g)).toHaveLength(2);
    expect(all.values).toEqual(['form_manual', 3]);
  });
});
