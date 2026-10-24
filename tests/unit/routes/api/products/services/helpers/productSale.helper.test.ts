import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import {
  computeSalePrice,
  lowestPriceOf,
  normalizeSaleEnd,
  type PriceLogLine,
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

// the lowest price of the 30 days before a sale, replayed from the log of prices: a line with an
// end starts a sale (from the price down to the sale price), a line from the sale price back up
// takes the sale off, any other line changes the price; a price down to the sale price or below
// ends the sale. A sale also ends by its end, with no line
describe('lowestPriceOf', () => {
  const DAY = 86_400_000;
  const to = new Date('2026-06-30T00:00:00.000Z');
  const from = new Date(to.getTime() - 30 * DAY);
  const daysBefore = (days: number) => new Date(to.getTime() - days * DAY);

  const change = (days: number, oldPrice: string, newPrice: string): PriceLogLine => ({
    oldPrice: price(oldPrice),
    newPrice: price(newPrice),
    endsAt: null,
    createdAt: daysBefore(days),
  });
  const saleStart = (
    days: number,
    oldPrice: string,
    salePrice: string,
    endsInDays: number,
  ): PriceLogLine => ({
    oldPrice: price(oldPrice),
    newPrice: price(salePrice),
    endsAt: daysBefore(days - endsInDays),
    createdAt: daysBefore(days),
  });

  const lowest = (lines: PriceLogLine[], current = '20') =>
    lowestPriceOf({ lines, current: price(current), from, to }).toFixed(2);

  it('is the price of now without a line', () => {
    expect(lowest([])).toBe('20.00');
  });

  it('takes a price of the 30 days', () => {
    expect(lowest([change(10, '20', '15'), change(5, '15', '20')])).toBe('15.00');
  });

  // the window is the 30 days before the new sale, the moment of the new sale left out
  it('leaves out a line at the very end of the window', () => {
    expect(lowest([{ ...change(0, '20', '5'), createdAt: to }], '20')).toBe('20.00');
  });

  // the price at the start of the window is the one before a change at that very moment
  it('takes the price the window starts with, before a change at its start', () => {
    expect(lowest([{ ...change(0, '10', '20'), createdAt: from }], '20')).toBe('10.00');
  });

  // a sale that ends at the start of the window has no day in it
  it('leaves out a sale that ends right at the start of the window', () => {
    const sale: PriceLogLine = {
      oldPrice: price('20'),
      newPrice: price('5'),
      endsAt: from,
      createdAt: new Date(from.getTime() - 86_400_000),
    };

    expect(lowest([sale], '20')).toBe('20.00');
  });

  it('leaves out a price that went before the 30 days', () => {
    expect(lowest([change(40, '20', '15'), change(35, '15', '20')])).toBe('20.00');
  });

  // the last change before the 30 days is the price they began with
  it('takes the price the 30 days began with', () => {
    expect(lowest([change(40, '20', '12'), change(10, '12', '20')])).toBe('12.00');
  });

  it('takes the price the product had before its first line, while the 30 days began with it', () => {
    expect(lowest([change(10, '9', '20')])).toBe('9.00');
  });

  it('takes a sale of the 30 days', () => {
    expect(lowest([saleStart(10, '20', '14', 2)])).toBe('14.00');
  });

  it('takes a sale that was on when the 30 days began', () => {
    expect(lowest([saleStart(40, '20', '14', 15)])).toBe('14.00');
  });

  it('leaves out a sale that ended by its end before the 30 days', () => {
    expect(lowest([saleStart(40, '20', '14', 5)])).toBe('20.00');
  });

  it('leaves out a sale taken off before the 30 days', () => {
    expect(lowest([saleStart(40, '20', '14', 20), change(35, '14', '20')])).toBe('20.00');
  });

  // a sale stays on while the price changes above it
  it('keeps a sale on across a change of the price above it', () => {
    expect(lowest([saleStart(40, '20', '14', 20), change(35, '20', '25')], '25')).toBe('14.00');
  });

  it('takes a price down to the sale price, which ends the sale', () => {
    expect(
      lowest([saleStart(40, '20', '14', 60), change(35, '20', '11'), change(5, '11', '20')]),
    ).toBe('11.00');
  });

  it('takes the price of now when it is the lowest', () => {
    expect(lowest([change(10, '20', '30')], '8')).toBe('8.00');
  });
});
