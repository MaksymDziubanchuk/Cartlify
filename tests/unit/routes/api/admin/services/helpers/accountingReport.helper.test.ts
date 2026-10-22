import { describe, expect, it } from '@jest/globals';

import { Prisma } from '@prisma/client';

import {
  marginPercentOf,
  parseProductIds,
  summarizeWriteOffs,
} from '@routes/api/admin/services/helpers/accountingReport.helper.js';
import { InternalError } from '@utils/errors.js';

import { thrownBy } from '../../../../../../helpers/errors.js';

// the report of the accounting reads only the products asked for, and counts the write-offs from
// the lines of the admin log (STOCK_WRITE_OFF): each line has the reason and the batches with
// their units and costs, as cartlify.write_off_product_stock writes them (db/05)

const dec = (value: string) => new Prisma.Decimal(value);

describe('marginPercentOf', () => {
  it('gives the margin as a part of the revenue, in percent to the hundredth', () => {
    expect(marginPercentOf(dec('54'), dec('70'))).toBe(77.14);
    expect(marginPercentOf(dec('-5'), dec('20'))).toBe(-25);
  });

  // nothing sold has no margin to speak of: no percent, not 0
  it('gives none without a revenue', () => {
    expect(marginPercentOf(dec('0'), dec('0'))).toBeNull();
    expect(marginPercentOf(dec('-3'), dec('0'))).toBeNull();
  });
});

describe('parseProductIds', () => {
  it('reads no filter when none is given', () => {
    expect(parseProductIds(undefined)).toBeUndefined();
  });

  it('takes each id once, in order', () => {
    expect(parseProductIds('7,3,7,12')).toEqual([3, 7, 12]);
  });

  it('refuses an id past the largest int of the database', () => {
    expect(thrownBy(() => parseProductIds('1,2147483648'))).toMatchObject({
      statusCode: 400,
      errorCode: 'PRODUCT_IDS_INVALID',
    });
  });

  it('takes 100 ids and refuses more', () => {
    const ids = (count: number) => Array.from({ length: count }, (_, n) => n + 1).join(',');

    expect(parseProductIds(ids(100))).toHaveLength(100);
    expect(thrownBy(() => parseProductIds(ids(101)))).toMatchObject({
      statusCode: 400,
      errorCode: 'PRODUCT_IDS_INVALID',
    });
  });
});

const line = (reason: string, batches: { quantity: number | string; unitCost: string }[]) => [
  { field: 'stock', old: 10, new: 7 },
  { field: 'reason', old: null, new: reason },
  {
    field: 'batches',
    old: null,
    new: batches.map((batch, n) => ({ batchId: n + 1, ...batch })),
  },
  { field: 'writeOff', old: null, new: '7d1f4f6e-6b1f-4a43-9a1b-0d2a3c4b5e6f' },
];

const NOTHING = { units: 0, value: 0 };

describe('summarizeWriteOffs', () => {
  it('counts every reason, the ones with nothing too', () => {
    expect(summarizeWriteOffs([])).toEqual({
      units: 0,
      value: 0,
      byReason: {
        damaged: NOTHING,
        defective: NOTHING,
        expired: NOTHING,
        shortage: NOTHING,
        returned_to_supplier: NOTHING,
        other: NOTHING,
      },
    });
  });

  // decimals, not floats: 0.1 three times is 0.3
  it('adds up the units and their costs batch by batch, by reason', () => {
    const out = summarizeWriteOffs([
      line('damaged', [
        { quantity: 2, unitCost: '0.1' },
        { quantity: 1, unitCost: '0.1' },
      ]),
      line('shortage', [{ quantity: 3, unitCost: '2.5' }]),
      line('damaged', [{ quantity: 1, unitCost: '5' }]),
    ]);

    expect(out).toMatchObject({
      units: 7,
      value: 12.8,
      byReason: { damaged: { units: 4, value: 5.3 }, shortage: { units: 3, value: 7.5 } },
    });
  });

  it.each([
    ['an unknown reason', line('stolen', [{ quantity: 1, unitCost: '1' }])],
    ['no batches', line('damaged', []).filter((change) => change.field !== 'batches')],
    ['a cost that is not a number', line('damaged', [{ quantity: 1, unitCost: 'cheap' }])],
    ['a part of a unit', line('damaged', [{ quantity: 1.5, unitCost: '1' }])],
    ['a quantity as text', line('damaged', [{ quantity: '1', unitCost: '1' }])],
    ['a meta that is not a list of changes', { reason: 'damaged' }],
  ])('takes a line with %s as a broken state of the log', (_case, meta) => {
    expect(thrownBy(() => summarizeWriteOffs([meta]))).toBeInstanceOf(InternalError);
  });
});
