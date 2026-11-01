import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import {
  assertWriteOffFits,
  deliverySteps,
  normalizeDeliveryInput,
  normalizeWriteOffInput,
  stockErrorOf,
  stockSummaryOf,
  writeOffSteps,
} from '@routes/api/products/services/helpers/stock.helper.js';

import { thrownBy } from '../../../../../../helpers/errors.js';

import type { ReceiveStockDto, WriteOffStockDto } from 'types/dto/products.dto.js';
import type { UserId } from 'types/ids.js';

// a delivery takes in a batch of each item at its cost of a unit; a write-off takes free units of
// a variant, from the batch named or from the batches in the order of a sale. The database checks
// it all again (db/05), the server says first what the admin asked that cannot be done

const TODAY = new Date('2026-10-22T23:30:00.000Z');

type ItemPatch = Record<string, unknown>;

const delivery = (patch: Record<string, unknown> = {}, item: ItemPatch = {}): ReceiveStockDto =>
  ({
    source: 'supplier',
    actorId: 1 as UserId,
    actorRole: 'ADMIN',
    items: [{ variantId: 4, quantity: 3, unitCost: 2.5, ...item }],
    ...patch,
  }) as ReceiveStockDto;

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
        variantId: 4,
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

  it('keeps how an item names its variant: the id, the article number or the barcode', () => {
    const out = normalizeDeliveryInput(
      delivery({
        items: [
          { variantId: 4, quantity: 1, unitCost: 1 },
          { sku: 'AB-1', quantity: 2, unitCost: 1 },
          { barcode: '4006381333931', quantity: 3, unitCost: 1 },
        ],
      }),
      TODAY,
    );

    expect(
      out.items.map((item) => ({
        variantId: item.variantId,
        sku: item.sku,
        barcode: item.barcode,
      })),
    ).toEqual([
      { variantId: 4, sku: undefined, barcode: undefined },
      { variantId: undefined, sku: 'AB-1', barcode: undefined },
      { variantId: undefined, sku: undefined, barcode: '4006381333931' },
    ]);
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

  describe('the cost and the last day of the delivery', () => {
    const items = (...patches: ItemPatch[]) =>
      patches.map((patch) => ({ variantId: 4, quantity: 1, ...patch }));

    it('stand in for an item that has none of its own, and give way to the ones it has', () => {
      const out = normalizeDeliveryInput(
        delivery({
          unitCost: 3,
          expiresAt: '2026-12-01',
          items: items({}, { unitCost: 1.5 }, { expiresAt: '2027-01-01' }),
        }),
        TODAY,
      );

      expect(out.items.map((item) => [item.unitCost, item.expiresAt])).toEqual([
        ['3', '2026-12-01'],
        ['1.5', '2026-12-01'],
        ['3', '2027-01-01'],
      ]);
    });

    it('take a cost of 0 of an item over the cost of the delivery', () => {
      const out = normalizeDeliveryInput(
        delivery({ unitCost: 3, items: items({ unitCost: 0 }) }),
        TODAY,
      );

      expect(out.items[0]!.unitCost).toBe('0');
    });

    it('are put aside by an item with null: it has no end', () => {
      const out = normalizeDeliveryInput(
        delivery({ unitCost: 1, expiresAt: '2026-12-01', items: items({ expiresAt: null }) }),
        TODAY,
      );

      expect(out.items[0]!.expiresAt).toBeNull();
    });

    it('name every item with a cost neither its own nor of the delivery, by its place and ref', () => {
      const err = thrownBy(() =>
        normalizeDeliveryInput(
          delivery({
            items: [
              { variantId: 4, quantity: 1, unitCost: 1 },
              { sku: 'AB-1', quantity: 1 },
              { variantId: 7, quantity: 1 },
              { barcode: '4006381333931', quantity: 1 },
            ],
          }),
          TODAY,
        ),
      );

      expect(err).toMatchObject({
        statusCode: 400,
        errorCode: 'BATCH_UNIT_COST_REQUIRED',
        details: {
          items: [
            { index: 1, sku: 'AB-1' },
            { index: 2, variantId: 7 },
            { index: 3, barcode: '4006381333931' },
          ],
        },
      });
    });

    it('refuse a cost of the delivery finer than a cent even when every item has its own', () => {
      expect(
        thrownBy(() => normalizeDeliveryInput(delivery({ unitCost: 1.005 }), TODAY)),
      ).toMatchObject({ errorCode: 'BATCH_UNIT_COST_INVALID' });
    });

    it('refuse a last day of the delivery that is over even when every item has its own', () => {
      expect(
        thrownBy(() =>
          normalizeDeliveryInput(
            delivery({ expiresAt: '2026-10-01' }, { expiresAt: '2026-12-01' }),
            TODAY,
          ),
        ),
      ).toMatchObject({ errorCode: 'BATCH_EXPIRES_AT_INVALID' });
    });

    it('ask for the cost before anything else is checked', () => {
      expect(
        thrownBy(() =>
          normalizeDeliveryInput(
            delivery({
              items: [
                { variantId: 4, quantity: 1, unitCost: 1.555 },
                { variantId: 5, quantity: 1 },
              ],
            }),
            TODAY,
          ),
        ),
      ).toMatchObject({ errorCode: 'BATCH_UNIT_COST_REQUIRED' });
    });
  });
});

const writeOff = (items: Record<string, unknown>[], patch: Record<string, unknown> = {}) =>
  ({
    reason: 'damaged',
    actorId: 1 as UserId,
    actorRole: 'ADMIN',
    items,
    ...patch,
  }) as WriteOffStockDto;

describe('normalizeWriteOffInput', () => {
  it('keeps the note trimmed and the items as they come, how they name their variants too', () => {
    expect(
      normalizeWriteOffInput(
        writeOff(
          [
            { variantId: 4, quantity: 2, batchId: 9 },
            { sku: 'AB-1', quantity: 1 },
            { barcode: '4006381333931', quantity: 1 },
          ],
          { note: ' Wet box ' },
        ),
      ),
    ).toEqual({
      reason: 'damaged',
      note: 'Wet box',
      items: [
        { variantId: 4, quantity: 2, batchId: 9 },
        { sku: 'AB-1', quantity: 1, batchId: null },
        { barcode: '4006381333931', quantity: 1, batchId: null },
      ],
    });
  });

  it.each([undefined, '', '   '])('asks the reason other for a note (%s)', (note) => {
    const input = writeOff([{ variantId: 4, quantity: 1 }], {
      reason: 'other',
      ...(note === undefined ? {} : { note }),
    });

    expect(thrownBy(() => normalizeWriteOffInput(input))).toMatchObject({
      statusCode: 400,
      errorCode: 'WRITE_OFF_NOTE_REQUIRED',
    });
  });

  it('takes another reason without a note', () => {
    expect(
      normalizeWriteOffInput(writeOff([{ variantId: 4, quantity: 1 }], { reason: 'shortage' }))
        .note,
    ).toBeNull();
  });
});

describe('deliverySteps', () => {
  // the rows of the variants are locked in the order of their ids, the same in every request
  it('goes by the id of the variant, the items of one variant in their order', () => {
    const steps = deliverySteps([
      { variantId: 7, quantity: 1 },
      { variantId: 3, quantity: 2 },
      { variantId: 7, quantity: 3 },
    ]);

    expect(steps.map((step) => [step.index, step.item.quantity])).toEqual([
      [1, 2],
      [0, 1],
      [2, 3],
    ]);
  });
});

const line = (variantId: number, quantity: number, batchId: number | null = null) => ({
  variantId,
  productId: 1,
  quantity,
  batchId,
});

describe('writeOffSteps', () => {
  it('goes by the id of the variant, a batch named before the units without one', () => {
    const steps = writeOffSteps([line(7, 1), line(3, 2), line(7, 3, 11), line(3, 4, 12)]);

    expect(steps.map((step) => step.index)).toEqual([3, 1, 2, 0]);
  });
});

describe('assertWriteOffFits', () => {
  const variants = new Map([
    [4, { stock: 5, reservedStock: 2 }],
    [5, { stock: 1, reservedStock: 0 }],
  ]);
  const batches = new Map([
    [11, { variantId: 4, remaining: 2, expired: false }],
    [12, { variantId: 4, remaining: 3, expired: false }],
    [21, { variantId: 5, remaining: 1, expired: false }],
  ]);

  const fits = (items: ReturnType<typeof line>[]) => () =>
    assertWriteOffFits({ items, variants, batches, expired: new Map() });

  // 10 in stock: 5 of a batch that is over, 5 of a good one; a waiting order holds 5, good ones
  describe('with a batch that is over', () => {
    const stock = new Map([[7, { stock: 10, reservedStock: 5 }]]);
    const twoBatches = new Map([
      [71, { variantId: 7, remaining: 5, expired: true }],
      [72, { variantId: 7, remaining: 5, expired: false }],
    ]);
    const fitsOver = (items: ReturnType<typeof line>[]) => () =>
      assertWriteOffFits({
        items,
        variants: stock,
        batches: twoBatches,
        expired: new Map([[7, 5]]),
      });

    it('refuses the good batch the reserve needs, naming the good units left free', () => {
      expect(thrownBy(fitsOver([line(7, 5, 72)]))).toMatchObject({
        statusCode: 409,
        errorCode: 'INSUFFICIENT_AVAILABLE_STOCK',
        details: { variants: [{ variantId: 7, available: 0, requested: 5 }] },
      });
    });

    it('writes off the batch that is over, and units without a batch, which take it first', () => {
      expect(fitsOver([line(7, 5, 71)])).not.toThrow();
      expect(fitsOver([line(7, 5)])).not.toThrow();
    });
  });

  it('lets through what the free units and the batches hold', () => {
    expect(fits([line(4, 2, 11), line(4, 1), line(5, 1, 21)])).not.toThrow();
  });

  it('names a variant it does not know', () => {
    expect(thrownBy(fits([line(9, 1)]))).toMatchObject({
      statusCode: 404,
      errorCode: 'VARIANT_NOT_FOUND',
      details: { variantIds: [9] },
    });
  });

  it.each([
    ['it does not know', 99],
    ['of another variant', 21],
  ])('names a batch %s', (_case, batchId) => {
    expect(thrownBy(fits([line(4, 1, batchId)]))).toMatchObject({
      statusCode: 404,
      errorCode: 'BATCH_NOT_FOUND',
      details: { batchId },
    });
  });

  // the units the waiting orders hold are not free: 5 in stock, 2 held
  it('names every variant short of free units, the lines of a variant counted together', () => {
    expect(thrownBy(fits([line(5, 2), line(4, 2), line(4, 2, 12)]))).toMatchObject({
      statusCode: 409,
      errorCode: 'INSUFFICIENT_AVAILABLE_STOCK',
      details: {
        variants: [
          { variantId: 4, available: 3, requested: 4 },
          { variantId: 5, available: 1, requested: 2 },
        ],
      },
    });
  });

  it('names every batch short of units, the lines of a batch counted together', () => {
    expect(thrownBy(fits([line(4, 1, 11), line(4, 2, 11)]))).toMatchObject({
      statusCode: 409,
      errorCode: 'BATCH_INSUFFICIENT',
      details: { batches: [{ batchId: 11, remaining: 2, requested: 3 }] },
    });
  });
});

describe('stockSummaryOf', () => {
  // the units of batches that are over are no free units
  it('gives each variant once by id: the free units, the whole stock, the reserve and what is over', () => {
    expect(
      stockSummaryOf(
        [
          { id: 7, productId: 70, stock: 5, reservedStock: 2 },
          { id: 3, productId: 30, stock: 1, reservedStock: 0 },
          { id: 9, productId: 70, stock: 4, reservedStock: 3 },
        ],
        new Map([
          [7, 1],
          [9, 2],
        ]),
      ),
    ).toEqual([
      {
        variantId: 3,
        productId: 30,
        stock: 1,
        totalStock: 1,
        reservedStock: 0,
        expiredStock: 0,
      },
      {
        variantId: 7,
        productId: 70,
        stock: 2,
        totalStock: 5,
        reservedStock: 2,
        expiredStock: 1,
      },
      {
        variantId: 9,
        productId: 70,
        stock: 0,
        totalStock: 4,
        reservedStock: 3,
        expiredStock: 2,
      },
    ]);
  });
});

describe('the order of the steps and of the shortages', () => {
  it('keeps the items of one variant in the order of the request', () => {
    const steps = deliverySteps([
      { variantId: 5, quantity: 1 },
      { variantId: 5, quantity: 2 },
      { variantId: 5, quantity: 3 },
      { variantId: 5, quantity: 4 },
      { variantId: 5, quantity: 5 },
    ]);

    expect(steps.map((step) => step.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('names the batches that have too few units by their ids', () => {
    const err = thrownBy(() =>
      assertWriteOffFits({
        items: [line(4, 2, 13), line(4, 2, 11), line(4, 2, 12)],
        variants: new Map([[4, { stock: 100, reservedStock: 0 }]]),
        batches: new Map([
          [11, { variantId: 4, remaining: 1, expired: false }],
          [12, { variantId: 4, remaining: 1, expired: false }],
          [13, { variantId: 4, remaining: 1, expired: false }],
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

describe('stockErrorOf', () => {
  // a prisma error the way the pg adapter builds it for a function of the database that raised
  const dbError = (message: string) =>
    new Prisma.PrismaClientKnownRequestError('Raw query failed', {
      code: 'P2010',
      clientVersion: '7.10.1',
      meta: { driverAdapterError: { cause: { originalCode: 'P0001', originalMessage: message } } },
    });

  it('turns the refusal of a variant of the database into the answer for the item', () => {
    expect(stockErrorOf(dbError('VARIANT_NOT_FOUND'), { variantId: 8 })).toMatchObject({
      statusCode: 404,
      errorCode: 'VARIANT_NOT_FOUND',
      details: { variantIds: [8] },
    });
  });

  it.each([
    ['BATCH_UNIT_COST_INVALID', 400],
    ['BATCH_EXPIRES_AT_INVALID', 400],
    ['WRITE_OFF_NOTE_REQUIRED', 400],
    ['INSUFFICIENT_AVAILABLE_STOCK', 409],
    ['BATCH_INSUFFICIENT', 409],
    ['BATCH_NOT_FOUND', 404],
  ])('turns %s into %i', (code, statusCode) => {
    expect(stockErrorOf(dbError(code), { variantId: 8 })).toMatchObject({
      statusCode,
      errorCode: code,
    });
  });

  it('leaves what it does not know to the caller', () => {
    expect(stockErrorOf(dbError('SOMETHING_ELSE'), { variantId: 8 })).toBeNull();
  });
});
