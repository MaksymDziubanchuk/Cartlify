import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import {
  assertSalesFit,
  isSameSale,
  nothingChanged,
  type PlannedSale,
  type VariantSaleState,
} from '@routes/api/products/services/helpers/productSaleSteps.helper.js';
import type { VariantSaleResultDto } from 'types/dto/products.dto.js';

import { thrownBy } from '../../../../../../helpers/errors.js';

// the pure parts of the steps of a sale: whether a sale fits the price of each variant it goes on
// (a request of many names every variant it does not fit), and whether a sale is the one that is on

const DAY = 86_400_000;
const dec = (value: number) => new Prisma.Decimal(value);
const endsAt = new Date(Date.now() + DAY);

const rows = (...prices: number[]) =>
  new Map(prices.map((price, index) => [index + 1, { price: dec(price) }]));

const planned = (variantId: number, sale: PlannedSale['sale']): PlannedSale => ({
  variantId,
  sale,
  endsAt: sale ? endsAt : null,
});

describe('assertSalesFit', () => {
  const amount = (value: number) => ({ amount: value, endsAt: endsAt.toISOString() });
  const percent = (value: number) => ({ percent: value, endsAt: endsAt.toISOString() });

  it('lets sales that fit their prices through, a free variant too', () => {
    expect(() =>
      assertSalesFit(
        [planned(1, amount(5)), planned(2, percent(50)), planned(3, amount(4))],
        rows(20, 10, 4),
      ),
    ).not.toThrow();
  });

  it('does not look at a variant whose sale is taken off', () => {
    expect(() => assertSalesFit([planned(1, null)], rows(0))).not.toThrow();
  });

  it('names every variant an amount is above, with its price', () => {
    expect(
      thrownBy(() =>
        assertSalesFit(
          [planned(1, amount(5)), planned(2, amount(5)), planned(3, amount(5))],
          rows(20, 3, 4.99),
        ),
      ),
    ).toMatchObject({
      statusCode: 400,
      errorCode: 'PRODUCT_SALE_AMOUNT_TOO_HIGH',
      details: {
        variants: [
          { variantId: 2, price: 3 },
          { variantId: 3, price: 4.99 },
        ],
      },
    });
  });

  it('names every variant a discount comes to nothing for', () => {
    expect(
      thrownBy(() =>
        assertSalesFit([planned(1, percent(1)), planned(2, percent(1))], rows(0.05, 0)),
      ),
    ).toMatchObject({
      statusCode: 400,
      errorCode: 'PRODUCT_SALE_TOO_SMALL',
      details: { variants: [{ variantId: 1 }, { variantId: 2 }] },
    });
  });

  // the first code names the request, the other refusals show once it is fixed
  it('names the request with the code of an amount above a price before one that comes to nothing', () => {
    expect(
      thrownBy(() =>
        assertSalesFit([planned(1, percent(1)), planned(2, amount(50))], rows(0.05, 20)),
      ),
    ).toMatchObject({
      errorCode: 'PRODUCT_SALE_AMOUNT_TOO_HIGH',
      details: { variants: [{ variantId: 2, price: 20 }] },
    });
  });
});

describe('isSameSale', () => {
  const state = (over: Partial<VariantSaleState> = {}): VariantSaleState => ({
    id: 1,
    productId: 1,
    price: dec(20),
    salePrice: dec(15),
    saleEndsAt: endsAt,
    ...over,
  });
  const given = (over: Record<string, unknown> = {}) =>
    ({ percent: 25, endsAt: endsAt.toISOString(), ...over }) as never;

  it('is the sale that is on, the same sale price and the same end', () => {
    expect(isSameSale(state(), given(), endsAt)).toBe(true);
  });

  it('counts a percent and an amount that come to the same price as the same sale', () => {
    expect(isSameSale(state(), { amount: 5, endsAt: endsAt.toISOString() }, endsAt)).toBe(true);
  });

  it('is another sale for another price or another end', () => {
    expect(isSameSale(state(), given({ percent: 20 }), endsAt)).toBe(false);
    expect(isSameSale(state(), given(), new Date(endsAt.getTime() + 1000))).toBe(false);
  });

  it('is no sale that is over, nor a variant without one', () => {
    const over = new Date(Date.now() - DAY);

    expect(isSameSale(state({ saleEndsAt: over }), given(), over)).toBe(false);
    expect(isSameSale(state({ salePrice: null, saleEndsAt: null }), given(), endsAt)).toBe(false);
  });
});

describe('nothingChanged', () => {
  const result = (status: VariantSaleResultDto['status']) => ({ status }) as VariantSaleResultDto;

  it('is true when every variant stayed as it was', () => {
    expect(nothingChanged([result('unchanged'), result('unchanged')])).toBe(true);
  });

  it.each(['set', 'removed'] as const)('is false when a variant was %s', (status) => {
    expect(nothingChanged([result('unchanged'), result(status)])).toBe(false);
  });
});
