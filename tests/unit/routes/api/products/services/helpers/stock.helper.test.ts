import { describe, expect, it } from '@jest/globals';

import {
  assertWriteOffFits,
  deliverySteps,
  normalizeDeliveryInput,
  normalizeWriteOffInput,
  stockSummaryOf,
  writeOffSteps,
} from '@routes/api/products/services/helpers/stock.helper.js';

import { thrownBy } from '../../../../../../helpers/errors.js';

// a delivery takes in a batch of each item at its cost of a unit; a write-off takes free units of
// a product, from the batch named or from the batches in the order of a sale. The database checks
// it all again (db/05), the server says first what the admin asked that cannot be done

const TODAY = new Date('2026-10-22T23:30:00.000Z');

const delivery = (patch: Record<string, unknown> = {}, item: Record<string, unknown> = {}) => ({
  source: 'supplier' as const,
  items: [{ productId: 4, quantity: 3, unitCost: 2.5, ...item }],
  ...patch,
});

describe('normalizeDeliveryInput', () => {
  it('keeps the cost to the cent and the texts trimmed, an empty text as none', () => {
    const out = normalizeDeliveryInput(
      delivery(
        { supplier: ' Acme ', document: '  ', note: ' Morning truck ' },
        { supplierBatchNumber: '  LOT-1 ', expiresAt: '2026-12-31' },
      ),
      TODAY,
    );

    expect(out).toMatchObject({
      source: 'supplier',
      supplier: 'Acme',
      document: null,
      note: 'Morning truck',
    });
    expect(out.items).toEqual([
      {
        productId: 4,
        quantity: 3,
        unitCost: '2.5',
        expiresAt: '2026-12-31',
        supplierBatchNumber: 'LOT-1',
      },
    ]);
  });

  it('takes an item without an end or a number of the supplier', () => {
    expect(normalizeDeliveryInput(delivery(), TODAY).items[0]).toMatchObject({
      expiresAt: null,
      supplierBatchNumber: null,
    });
  });

  it.each([
    ['1.555', 1.555],
    ['0.001', 0.001],
  ])('refuses a cost finer than a cent, %s', (_case, unitCost) => {
    expect(thrownBy(() => normalizeDeliveryInput(delivery({}, { unitCost }), TODAY))).toMatchObject(
      {
        statusCode: 400,
        errorCode: 'BATCH_UNIT_COST_INVALID',
      },
    );
  });

  it.each([0, 0.1, 19.99, 99999999.99])('takes a cost of %s', (unitCost) => {
    expect(() => normalizeDeliveryInput(delivery({}, { unitCost }), TODAY)).not.toThrow();
  });

  // the last good day by the calendar of the shop: late in the evening of the 22nd by utc it is
  // the 23rd in Madrid already
  it('takes a batch good until today and refuses one whose last day is over', () => {
    expect(() =>
      normalizeDeliveryInput(delivery({}, { expiresAt: '2026-10-23' }), TODAY),
    ).not.toThrow();
    expect(
      thrownBy(() => normalizeDeliveryInput(delivery({}, { expiresAt: '2026-10-22' }), TODAY)),
    ).toMatchObject({ statusCode: 400, errorCode: 'BATCH_EXPIRES_AT_INVALID' });
  });
});

describe('normalizeWriteOffInput', () => {
  it('keeps the note trimmed and the items as they come', () => {
    expect(
      normalizeWriteOffInput({
        reason: 'damaged',
        note: ' Wet box ',
        items: [
          { productId: 4, quantity: 2, batchId: 9 },
          { productId: 5, quantity: 1 },
        ],
      }),
    ).toEqual({
      reason: 'damaged',
      note: 'Wet box',
      items: [
        { productId: 4, quantity: 2, batchId: 9 },
        { productId: 5, quantity: 1, batchId: null },
      ],
    });
  });

  it.each([undefined, '', '   '])('asks the reason other for a note (%s)', (note) => {
    const items = [{ productId: 4, quantity: 1 }];

    expect(
      thrownBy(() =>
        normalizeWriteOffInput({ reason: 'other', ...(note === undefined ? {} : { note }), items }),
      ),
    ).toMatchObject({ statusCode: 400, errorCode: 'WRITE_OFF_NOTE_REQUIRED' });
  });

  it('takes another reason without a note', () => {
    expect(
      normalizeWriteOffInput({ reason: 'shortage', items: [{ productId: 4, quantity: 1 }] }).note,
    ).toBeNull();
  });
});

describe('deliverySteps', () => {
  // the rows of the products are locked in the order of their ids, the same in every request
  it('goes by the id of the product, the items of one product in their order', () => {
    const steps = deliverySteps([
      { productId: 7, quantity: 1 },
      { productId: 3, quantity: 2 },
      { productId: 7, quantity: 3 },
    ]);

    expect(steps.map((step) => [step.index, step.item.quantity])).toEqual([
      [1, 2],
      [0, 1],
      [2, 3],
    ]);
  });
});

describe('writeOffSteps', () => {
  it('goes by the id of the product, a batch named before the units without one', () => {
    const steps = writeOffSteps([
      { productId: 7, quantity: 1, batchId: null },
      { productId: 3, quantity: 2, batchId: null },
      { productId: 7, quantity: 3, batchId: 11 },
      { productId: 3, quantity: 4, batchId: 12 },
    ]);

    expect(steps.map((step) => step.index)).toEqual([3, 1, 2, 0]);
  });
});

describe('assertWriteOffFits', () => {
  const products = new Map([
    [4, { stock: 5, reservedStock: 2 }],
    [5, { stock: 1, reservedStock: 0 }],
  ]);
  const batches = new Map([
    [11, { productId: 4, remaining: 2, expired: false }],
    [12, { productId: 4, remaining: 3, expired: false }],
    [21, { productId: 5, remaining: 1, expired: false }],
  ]);

  const fits = (items: { productId: number; quantity: number; batchId: number | null }[]) => () =>
    assertWriteOffFits({ items, products, batches, expired: new Map() });

  // 10 in stock: 5 of a batch that is over, 5 of a good one; a waiting order holds 5, good ones
  describe('with a batch that is over', () => {
    const stock = new Map([[7, { stock: 10, reservedStock: 5 }]]);
    const twoBatches = new Map([
      [71, { productId: 7, remaining: 5, expired: true }],
      [72, { productId: 7, remaining: 5, expired: false }],
    ]);
    const fitsOver =
      (items: { productId: number; quantity: number; batchId: number | null }[]) => () =>
        assertWriteOffFits({
          items,
          products: stock,
          batches: twoBatches,
          expired: new Map([[7, 5]]),
        });

    it('refuses the good batch the reserve needs, naming the good units left free', () => {
      expect(thrownBy(fitsOver([{ productId: 7, quantity: 5, batchId: 72 }]))).toMatchObject({
        statusCode: 409,
        errorCode: 'INSUFFICIENT_AVAILABLE_STOCK',
        details: { products: [{ productId: 7, available: 0, requested: 5 }] },
      });
    });

    it('writes off the batch that is over, and units without a batch, which take it first', () => {
      expect(fitsOver([{ productId: 7, quantity: 5, batchId: 71 }])).not.toThrow();
      expect(fitsOver([{ productId: 7, quantity: 5, batchId: null }])).not.toThrow();
    });
  });

  it('lets through what the free units and the batches hold', () => {
    expect(
      fits([
        { productId: 4, quantity: 2, batchId: 11 },
        { productId: 4, quantity: 1, batchId: null },
        { productId: 5, quantity: 1, batchId: 21 },
      ]),
    ).not.toThrow();
  });

  it('names a product it does not know', () => {
    expect(thrownBy(fits([{ productId: 9, quantity: 1, batchId: null }]))).toMatchObject({
      statusCode: 404,
      errorCode: 'PRODUCT_NOT_FOUND',
      details: { productId: 9 },
    });
  });

  it.each([
    ['it does not know', 99],
    ['of another product', 21],
  ])('names a batch %s', (_case, batchId) => {
    expect(thrownBy(fits([{ productId: 4, quantity: 1, batchId }]))).toMatchObject({
      statusCode: 404,
      errorCode: 'BATCH_NOT_FOUND',
      details: { batchId },
    });
  });

  // the units the waiting orders hold are not free: 5 in stock, 2 held
  it('names every product short of free units, the lines of a product counted together', () => {
    expect(
      thrownBy(
        fits([
          { productId: 5, quantity: 2, batchId: null },
          { productId: 4, quantity: 2, batchId: null },
          { productId: 4, quantity: 2, batchId: 12 },
        ]),
      ),
    ).toMatchObject({
      statusCode: 409,
      errorCode: 'INSUFFICIENT_AVAILABLE_STOCK',
      details: {
        products: [
          { productId: 4, available: 3, requested: 4 },
          { productId: 5, available: 1, requested: 2 },
        ],
      },
    });
  });

  it('names every batch short of units, the lines of a batch counted together', () => {
    expect(
      thrownBy(
        fits([
          { productId: 4, quantity: 1, batchId: 11 },
          { productId: 4, quantity: 2, batchId: 11 },
        ]),
      ),
    ).toMatchObject({
      statusCode: 409,
      errorCode: 'BATCH_INSUFFICIENT',
      details: { batches: [{ batchId: 11, remaining: 2, requested: 3 }] },
    });
  });
});

describe('stockSummaryOf', () => {
  // the units of batches that are over are no free units
  it('gives each product once by id: the free units, the whole stock, the reserve and what is over', () => {
    expect(
      stockSummaryOf(
        [
          { id: 7, stock: 5, reservedStock: 2 },
          { id: 3, stock: 1, reservedStock: 0 },
          { id: 9, stock: 4, reservedStock: 3 },
        ],
        new Map([
          [7, 1],
          [9, 2],
        ]),
      ),
    ).toEqual([
      { id: 3, stock: 1, totalStock: 1, reservedStock: 0, expiredStock: 0 },
      { id: 7, stock: 2, totalStock: 5, reservedStock: 2, expiredStock: 1 },
      { id: 9, stock: 0, totalStock: 4, reservedStock: 3, expiredStock: 2 },
    ]);
  });
});

describe('the order of the steps and of the shortages', () => {
  it('keeps the items of one product in the order of the request', () => {
    const steps = deliverySteps([
      { productId: 5, quantity: 1 },
      { productId: 5, quantity: 2 },
      { productId: 5, quantity: 3 },
      { productId: 5, quantity: 4 },
      { productId: 5, quantity: 5 },
    ]);

    expect(steps.map((step) => step.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('names the batches that have too few units by their ids', () => {
    const err = thrownBy(() =>
      assertWriteOffFits({
        items: [
          { productId: 4, quantity: 2, batchId: 13 },
          { productId: 4, quantity: 2, batchId: 11 },
          { productId: 4, quantity: 2, batchId: 12 },
        ],
        products: new Map([[4, { stock: 100, reservedStock: 0 }]]),
        batches: new Map([
          [11, { productId: 4, remaining: 1, expired: false }],
          [12, { productId: 4, remaining: 1, expired: false }],
          [13, { productId: 4, remaining: 1, expired: false }],
        ]),
        expired: new Map(),
      }),
    );

    expect(err).toMatchObject({ errorCode: 'BATCH_INSUFFICIENT' });
    expect(
      (err as { details: { batches: { batchId: number }[] } }).details.batches.map(
        (b) => b.batchId,
      ),
    ).toEqual([11, 12, 13]);
  });
});
