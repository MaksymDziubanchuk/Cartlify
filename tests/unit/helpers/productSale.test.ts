import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import { currentPrice, isSaleOn, saleFieldsOf } from '@helpers/productSale.js';

// the sale of a product lasts while its end is ahead, the way cartlify.product_current_price
// reads it in the database; past the end its fields stay in the row and mean nothing
const NOW = Date.parse('2026-10-21T12:00:00.000Z');

const row = (
  patch: Partial<{ price: unknown; salePrice: unknown; saleEndsAt: Date | null }> = {},
) => ({
  price: new Prisma.Decimal('20.00') as unknown,
  salePrice: new Prisma.Decimal('15.50') as unknown,
  saleEndsAt: new Date(NOW + 60_000) as Date | null,
  ...patch,
});

describe('isSaleOn', () => {
  it('is true while the end of the sale is ahead', () => {
    expect(isSaleOn(row(), NOW)).toBe(true);
  });

  it.each([
    ['at its end', NOW],
    ['after its end', NOW - 1],
  ])('is false %s', (_case, end) => {
    expect(isSaleOn(row({ saleEndsAt: new Date(end) }), NOW)).toBe(false);
  });

  it('is false without a sale price or without an end', () => {
    expect(isSaleOn(row({ salePrice: null }), NOW)).toBe(false);
    expect(isSaleOn(row({ saleEndsAt: null }), NOW)).toBe(false);
  });

  it('is true for a sale that gives the product away', () => {
    expect(isSaleOn(row({ salePrice: new Prisma.Decimal(0) }), NOW)).toBe(true);
  });

  it('takes the clock of the app when no time is given', () => {
    expect(isSaleOn(row({ saleEndsAt: new Date(Date.now() + 60_000) }))).toBe(true);
    expect(isSaleOn(row({ saleEndsAt: new Date(Date.now() - 1) }))).toBe(false);
  });
});

describe('currentPrice', () => {
  it('is the sale price while the sale lasts', () => {
    expect(currentPrice(row(), NOW)).toBe(15.5);
  });

  it('is the price once the sale is over', () => {
    expect(currentPrice(row({ saleEndsAt: new Date(NOW - 1) }), NOW)).toBe(20);
  });

  it('is the price without a sale', () => {
    expect(currentPrice(row({ salePrice: null, saleEndsAt: null }), NOW)).toBe(20);
  });

  it('is nothing for a product given away', () => {
    expect(currentPrice(row({ salePrice: new Prisma.Decimal(0) }), NOW)).toBe(0);
  });
});

describe('saleFieldsOf', () => {
  it('gives the sale price and the end as an iso date while the sale lasts', () => {
    expect(saleFieldsOf(row(), NOW)).toEqual({
      salePrice: 15.5,
      saleEndsAt: '2026-10-21T12:01:00.000Z',
    });
  });

  it('gives nothing for a sale that is over: the answers leave it out', () => {
    expect(saleFieldsOf(row({ saleEndsAt: new Date(NOW) }), NOW)).toEqual({});
  });

  it('gives nothing without a sale', () => {
    expect(saleFieldsOf(row({ salePrice: null, saleEndsAt: null }), NOW)).toEqual({});
  });

  it('gives a sale price of 0 for a product given away', () => {
    expect(saleFieldsOf(row({ salePrice: new Prisma.Decimal(0) }), NOW)).toMatchObject({
      salePrice: 0,
    });
  });
});
