import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import {
  assertPopularityOverridePair,
  normalizeBulkUpdateProductsPriceInput,
  normalizeCreateProductInput,
  normalizeFindProductByIdInput,
  normalizeUpdateProductInput,
} from '@routes/api/products/services/helpers/products.helpers.js';
import { BadRequestError } from '@utils/errors.js';

import { thrownBy } from '../../../../../../helpers/errors.js';

const codeOf = (fn: () => unknown) => {
  const err = thrownBy(fn);

  expect(err).toBeInstanceOf(BadRequestError);
  return (err as BadRequestError).errorCode;
};

const validProduct = { name: 'Desk lamp', price: 25.5, stock: 10, categoryId: 3 };

describe('normalizeFindProductByIdInput', () => {
  it('accepts a positive integer or its string form', () => {
    expect(normalizeFindProductByIdInput({ productId: 7 })).toEqual({ productId: 7 });
    expect(normalizeFindProductByIdInput({ productId: '7' })).toEqual({ productId: 7 });
  });

  it.each([0, -1, 1.5, 'abc', null, undefined])('rejects %p', (productId) => {
    expect(codeOf(() => normalizeFindProductByIdInput({ productId }))).toBe('PRODUCT_ID_INVALID');
  });
});

describe('normalizeCreateProductInput', () => {
  it('trims the name and the description', () => {
    const out = normalizeCreateProductInput({
      ...validProduct,
      name: '  Desk lamp  ',
      description: '  Warm light ',
    });

    expect(out).toEqual({
      nameNorm: 'Desk lamp',
      descriptionNorm: 'Warm light',
      priceRaw: 25.5,
      stockNorm: 10,
      categoryIdRaw: 3,
    });
  });

  it('drops a blank description', () => {
    expect(
      normalizeCreateProductInput({ ...validProduct, description: '   ' }).descriptionNorm,
    ).toBeUndefined();
  });

  it('reads multipart field objects', () => {
    const out = normalizeCreateProductInput({
      name: { value: 'Mug' },
      price: { value: '4.99' },
      stock: { value: '3' },
      categoryId: { value: '2' },
    });

    expect(out).toMatchObject({ nameNorm: 'Mug', priceRaw: 4.99, stockNorm: 3, categoryIdRaw: 2 });
  });

  it('allows a free product and an empty stock', () => {
    expect(normalizeCreateProductInput({ ...validProduct, price: 0, stock: 0 })).toMatchObject({
      priceRaw: 0,
      stockNorm: 0,
    });
  });

  it.each([
    ['the name is blank', { name: '   ' }, 'PRODUCT_NAME_INVALID'],
    ['the name is missing', { name: undefined }, 'PRODUCT_NAME_INVALID'],
    ['the price is negative', { price: -1 }, 'PRODUCT_PRICE_INVALID'],
    ['the price is a word', { price: 'free' }, 'PRODUCT_PRICE_INVALID'],
    // a blank multipart field must not turn into a price of 0
    ['the price is blank', { price: '  ' }, 'PRODUCT_PRICE_INVALID'],
    ['the stock is negative', { stock: -2 }, 'PRODUCT_STOCK_INVALID'],
    ['the stock is a fraction', { stock: 1.5 }, 'PRODUCT_STOCK_INVALID'],
    ['the stock is blank', { stock: ' ' }, 'PRODUCT_STOCK_INVALID'],
    ['the category is zero', { categoryId: 0 }, 'CATEGORY_ID_INVALID'],
    ['the category is missing', { categoryId: undefined }, 'CATEGORY_ID_INVALID'],
  ])('throws when %s', (_case, patch, code) => {
    expect(codeOf(() => normalizeCreateProductInput({ ...validProduct, ...patch }))).toBe(code);
  });
});

describe('normalizeUpdateProductInput', () => {
  it('returns nothing to change for an empty patch', () => {
    expect(normalizeUpdateProductInput({})).toEqual({
      nameNorm: undefined,
      descriptionNorm: undefined,
      priceRaw: undefined,
      stockRaw: undefined,
      categoryIdRaw: undefined,
      popularityOverrideRaw: undefined,
      popularityOverrideUntilDate: undefined,
    });
  });

  it('takes the stock as a delta that can be negative', () => {
    expect(normalizeUpdateProductInput({ stock: -3 }).stockRaw).toBe(-3);
    expect(normalizeUpdateProductInput({ stock: 5 }).stockRaw).toBe(5);
  });

  it('clears the popularity override with null', () => {
    const out = normalizeUpdateProductInput({
      popularityOverride: null,
      popularityOverrideUntil: null,
    });

    expect(out.popularityOverrideRaw).toBeNull();
    expect(out.popularityOverrideUntilDate).toBeNull();
  });

  it('parses the override end date', () => {
    const until = new Date(Date.now() + 86_400_000).toISOString();

    const out = normalizeUpdateProductInput({ popularityOverrideUntil: until });

    expect(out.popularityOverrideUntilDate?.toISOString()).toBe(until);
  });

  // an override overrides while its end is ahead (recalc_product_popularity, db/05)
  it.each([
    ['in the past', -60_000],
    ['at this moment', 0],
  ])('refuses an override end %s', (_case, ms) => {
    const now = Date.parse('2026-10-22T12:00:00.000Z');
    const until = new Date(now + ms).toISOString();

    expect(codeOf(() => normalizeUpdateProductInput({ popularityOverrideUntil: until }, now))).toBe(
      'POPULARITY_OVERRIDE_UNTIL_INVALID',
    );
  });

  it.each([
    ['the name is blank', { name: ' ' }, 'PRODUCT_NAME_INVALID'],
    ['the price is negative', { price: -0.01 }, 'PRODUCT_PRICE_INVALID'],
    ['the stock delta is a fraction', { stock: 0.5 }, 'PRODUCT_STOCK_INVALID'],
    ['the category is negative', { categoryId: -4 }, 'CATEGORY_ID_INVALID'],
    ['the override is negative', { popularityOverride: -1 }, 'POPULARITY_OVERRIDE_INVALID'],
    ['the override is a fraction', { popularityOverride: 1.5 }, 'POPULARITY_OVERRIDE_INVALID'],
    [
      'the override date is not a date',
      { popularityOverrideUntil: 'soon' },
      'POPULARITY_OVERRIDE_UNTIL_INVALID',
    ],
  ])('throws when %s', (_case, patch, code) => {
    expect(codeOf(() => normalizeUpdateProductInput(patch))).toBe(code);
  });
});

// an override overrides only with its end, and an end is the end of an override: the product has
// both after a change, or neither
describe('assertPopularityOverridePair', () => {
  const until = new Date('2026-12-01T00:00:00.000Z');

  it.each([
    ['an override with its end', { popularityOverride: 500, popularityOverrideUntil: until }],
    ['neither', { popularityOverride: null, popularityOverrideUntil: null }],
    ['an override of 0 with its end', { popularityOverride: 0, popularityOverrideUntil: until }],
  ])('lets a product have %s', (_case, next) => {
    expect(() => assertPopularityOverridePair(next)).not.toThrow();
  });

  it.each([
    [
      'an override without an end',
      { popularityOverride: 500, popularityOverrideUntil: null },
      'POPULARITY_OVERRIDE_UNTIL_REQUIRED',
    ],
    [
      'an end without an override',
      { popularityOverride: null, popularityOverrideUntil: until },
      'POPULARITY_OVERRIDE_REQUIRED',
    ],
  ])('refuses %s', (_case, next, code) => {
    expect(codeOf(() => assertPopularityOverridePair(next))).toBe(code);
  });
});

describe('normalizeBulkUpdateProductsPriceInput', () => {
  // the server always sets deleted to false unless the request says otherwise
  it('changes every product that is not deleted when no scope is given', () => {
    const out = normalizeBulkUpdateProductsPriceInput({ mode: 'percent', value: 10 });

    expect(out).toEqual({
      mode: 'percent',
      value: 10,
      where: { AND: [{ deletedAt: null }] },
      dryRun: false,
    });
  });

  // the same word on the sales for every product: keep them or take them off
  it.each(['keep', 'remove'] as const)('passes the word %s on the sales', (sale) => {
    expect(normalizeBulkUpdateProductsPriceInput({ mode: 'fixed', value: 1, sale }).sale).toBe(
      sale,
    );
  });

  it('passes no word on the sales when none is sent', () => {
    expect(normalizeBulkUpdateProductsPriceInput({ mode: 'fixed', value: 1 })).not.toHaveProperty(
      'sale',
    );
  });

  it('changes every product that is not deleted when the scope is empty', () => {
    const out = normalizeBulkUpdateProductsPriceInput({ mode: 'percent', value: 10, scope: {} });

    expect(out.where).toEqual({ AND: [{ deletedAt: null }] });
  });

  it('skips deleted products when the scope does not mention them', () => {
    const out = normalizeBulkUpdateProductsPriceInput({
      mode: 'fixed',
      value: 1,
      scope: { categoryId: 3 },
    });

    expect(out.where).toEqual({ AND: [{ categoryId: 3 }, { deletedAt: null }] });
  });

  it('changes only deleted products when the scope asks for them', () => {
    const out = normalizeBulkUpdateProductsPriceInput({
      mode: 'fixed',
      value: 1,
      scope: { deleted: true },
    });

    expect(out.where).toEqual({ AND: [{ deletedAt: { not: null } }] });
  });

  it('builds the filter from the scope', () => {
    const out = normalizeBulkUpdateProductsPriceInput({
      mode: 'fixed',
      value: -2,
      dryRun: true,
      reason: '  winter sale ',
      scope: {
        categoryId: 4,
        productIds: [3, '3', 8],
        minPrice: 10,
        maxPrice: 50,
        inStock: true,
        deleted: false,
      },
    });

    expect(out).toEqual({
      mode: 'fixed',
      value: -2,
      dryRun: true,
      reason: 'winter sale',
      where: {
        AND: [
          { categoryId: 4 },
          { id: { in: [3, 8] } },
          { price: { gte: new Prisma.Decimal(10), lte: new Prisma.Decimal(50) } },
          { stock: { gt: 0 } },
          { deletedAt: null },
        ],
      },
    });
  });

  it('allows a 100 percent discount but nothing below it', () => {
    expect(
      normalizeBulkUpdateProductsPriceInput({ mode: 'percent', value: -100, scope: {} }).value,
    ).toBe(-100);
    expect(
      codeOf(() =>
        normalizeBulkUpdateProductsPriceInput({ mode: 'percent', value: -101, scope: {} }),
      ),
    ).toBe('BULK_PRICE_PERCENT_TOO_LOW');
  });

  it('treats only a real true as a dry run', () => {
    expect(
      normalizeBulkUpdateProductsPriceInput({ mode: 'fixed', value: 1, dryRun: 'true', scope: {} })
        .dryRun,
    ).toBe(false);
  });

  it.each([
    ['the mode is unknown', { mode: 'double' }, 'BULK_PRICE_MODE_INVALID'],
    ['the value is not a number', { value: 'ten' }, 'BULK_PRICE_VALUE_INVALID'],
    ['the category is invalid', { scope: { categoryId: 0 } }, 'CATEGORY_ID_INVALID'],
    ['a product id is invalid', { scope: { productIds: [1, -2] } }, 'PRODUCT_IDS_INVALID'],
    ['the min price is negative', { scope: { minPrice: -1 } }, 'MIN_PRICE_INVALID'],
    ['the max price is negative', { scope: { maxPrice: -1 } }, 'MAX_PRICE_INVALID'],
    [
      'the price range is reversed',
      { scope: { minPrice: 20, maxPrice: 10 } },
      'PRICE_RANGE_INVALID',
    ],
  ])('throws when %s', (_case, patch, code) => {
    expect(
      codeOf(() => normalizeBulkUpdateProductsPriceInput({ mode: 'fixed', value: 1, ...patch })),
    ).toBe(code);
  });
});
