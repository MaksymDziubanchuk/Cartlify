import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import {
  computeSalePrice,
  normalizeSaleEnd,
} from '@routes/api/products/services/helpers/productSale.helper.js';

import { thrownBy } from '../../../../../../helpers/errors.js';

// a discount is a percent of the price or an amount of money off it; the sale price is rounded to
// cents, a half cent up, and has to stay below the price: the database refuses a sale that is not
// one (products_sale_chk)
const price = (value: string) => new Prisma.Decimal(value);

const saleOf = (from: string, discount: { percent: number } | { amount: number }) => {
  const { salePrice, discount: off } = computeSalePrice(price(from), discount);
  return { salePrice: salePrice.toFixed(2), discount: off.toFixed(2) };
};

describe('computeSalePrice', () => {
  it.each([
    ['a percent of the price', '20.00', { percent: 25 }, '15.00', '5.00'],
    ['a part of a percent', '20.00', { percent: 12.5 }, '17.50', '2.50'],
    ['an amount off the price', '20.00', { amount: 5 }, '15.00', '5.00'],
    ['a percent of 100', '20.00', { percent: 100 }, '0.00', '20.00'],
    ['an amount of the whole price', '20.00', { amount: 20 }, '0.00', '20.00'],
  ])('takes %s off', (_case, from, discount, salePrice, off) => {
    expect(saleOf(from, discount)).toEqual({ salePrice, discount: off });
  });

  it('rounds the sale price to cents, a half cent up', () => {
    expect(saleOf('10.01', { percent: 50 })).toEqual({ salePrice: '5.01', discount: '5.00' });
    expect(saleOf('9.99', { percent: 33 })).toEqual({ salePrice: '6.69', discount: '3.30' });
  });

  // 0.3 - 0.1 is 0.19999999999999998 in floats
  it('counts in decimals, not in floats', () => {
    expect(saleOf('0.30', { amount: 0.1 })).toEqual({ salePrice: '0.20', discount: '0.10' });
    expect(saleOf('0.30', { percent: 10 })).toEqual({ salePrice: '0.27', discount: '0.03' });
  });

  it('refuses an amount above the price, naming the price', () => {
    expect(thrownBy(() => computeSalePrice(price('20.00'), { amount: 20.01 }))).toMatchObject({
      statusCode: 400,
      errorCode: 'PRODUCT_SALE_AMOUNT_TOO_HIGH',
      details: { price: 20 },
    });
  });

  it.each([
    ['a percent of a price of a few cents', '0.05', { percent: 1 }],
    ['an amount below half a cent', '20.00', { amount: 0.004 }],
    ['a percent of a free product', '0.00', { percent: 50 }],
  ])('refuses a discount that comes to nothing: %s', (_case, from, discount) => {
    expect(thrownBy(() => computeSalePrice(price(from), discount))).toMatchObject({
      statusCode: 400,
      errorCode: 'PRODUCT_SALE_TOO_SMALL',
    });
  });
});

describe('normalizeSaleEnd', () => {
  const NOW = Date.parse('2026-10-21T12:00:00.000Z');

  it('takes an end in the future as a date', () => {
    expect(normalizeSaleEnd('2026-10-21T12:00:00.001Z', NOW)).toEqual(
      new Date('2026-10-21T12:00:00.001Z'),
    );
  });

  it.each([
    ['in the past', '2026-10-21T11:59:59.999Z'],
    ['at this moment', '2026-10-21T12:00:00.000Z'],
    ['that is no date', 'next week'],
  ])('refuses an end %s', (_case, endsAt) => {
    expect(thrownBy(() => normalizeSaleEnd(endsAt, NOW))).toMatchObject({
      statusCode: 400,
      errorCode: 'PRODUCT_SALE_ENDS_AT_INVALID',
    });
  });
});
