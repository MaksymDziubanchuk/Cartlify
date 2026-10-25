import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import {
  assertPopularityOverridePair,
  isPrice,
  isSkuTaken,
  MAX_PRICE,
  normalizeBulkUpdateProductsPriceInput,
  normalizeCreateProductInput,
  normalizeFindProductByIdInput,
  normalizeSku,
  normalizeUpdateProductInput,
} from '@routes/api/products/services/helpers/products.helpers.js';
import { BadRequestError } from '@utils/errors.js';

import { thrownBy } from '../../../../../../helpers/errors.js';

const codeOf = (fn: () => unknown) => {
  const err = thrownBy(fn);

  expect(err).toBeInstanceOf(BadRequestError);
  return (err as BadRequestError).errorCode;
};

const validProduct = { name: 'Desk lamp', price: 25.5, categoryId: 3 };

// a price is whole cents from 0 up to what numeric(10, 2) holds
describe('isPrice', () => {
  it.each([0, 0.01, 10.01, 25.5, 19.99, MAX_PRICE])('takes %p', (value) => {
    expect(isPrice(value)).toBe(true);
  });

  it.each([
    ['a part of a cent', 10.004],
    ['a half of a cent', 0.005],
    ['a cent above the highest price', MAX_PRICE + 0.01],
    ['a price below 0', -0.01],
    ['no number', Number.NaN],
    ['an endless number', Number.POSITIVE_INFINITY],
  ])('refuses %s', (_case, value) => {
    expect(isPrice(value)).toBe(false);
  });
});

// the article number: trimmed, an empty one is none, up to 64 signs (a form is not checked by the
// schema)
describe('normalizeSku', () => {
  it('keeps a number trimmed and takes an empty one as none', () => {
    expect(normalizeSku('  AB-12 ')).toBe('AB-12');
    expect(normalizeSku('   ')).toBeNull();
    expect(normalizeSku(null)).toBeNull();
    expect(normalizeSku(undefined)).toBeUndefined();
  });

  // the signs are code points, as the json schema counts them
  it('takes 64 signs and refuses 65', () => {
    expect(normalizeSku('😀'.repeat(64))).toBe('😀'.repeat(64));
    expect(codeOf(() => normalizeSku('x'.repeat(65)))).toBe('PRODUCT_SKU_TOO_LONG');
  });
});

describe('isSkuTaken', () => {
  const unique = (meta: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta,
    });

  it('names the unique index of the article number only', () => {
    expect(
      isSkuTaken(
        unique({
          driverAdapterError: { cause: { constraint: { index: 'products_sku_catalog_uidx' } } },
        }),
      ),
    ).toBe(true);
    expect(isSkuTaken(unique({ target: ['id'] }))).toBe(false);
    expect(isSkuTaken(new Error('products_sku_catalog_uidx'))).toBe(false);
  });

  // a raw query fails with P2010 and the code of postgres inside (getPgCode)
  it('takes the unique error of postgres from a raw query', () => {
    const raw = new Prisma.PrismaClientKnownRequestError('Raw query failed', {
      code: 'P2010',
      clientVersion: 'test',
      meta: {
        driverAdapterError: {
          cause: {
            originalCode: '23505',
            originalMessage: 'duplicate key value violates "products_sku_catalog_uidx"',
          },
        },
      },
    });

    expect(isSkuTaken(raw)).toBe(true);
  });

  it('finds the index named in the text of the error when the details do not name it', () => {
    const named = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the constraint: `products_sku_catalog_uidx`',
      { code: 'P2002', clientVersion: 'test', meta: {} },
    );

    expect(isSkuTaken(named)).toBe(true);
  });

  it('takes no other error of prisma, and no error that only looks like one', () => {
    const other = new Prisma.PrismaClientKnownRequestError('Foreign key failed', {
      code: 'P2003',
      clientVersion: 'test',
      meta: { constraint: 'products_sku_catalog_uidx' },
    });

    expect(isSkuTaken(other)).toBe(false);
    expect(
      isSkuTaken(Object.assign(new Error('products_sku_catalog_uidx'), { code: 'P2002' })),
    ).toBe(false);
  });
});

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
      categoryId: { value: '2' },
    });

    expect(out).toMatchObject({ nameNorm: 'Mug', priceRaw: 4.99, categoryIdRaw: 2 });
  });

  it('allows a free product', () => {
    expect(normalizeCreateProductInput({ ...validProduct, price: 0 })).toMatchObject({
      priceRaw: 0,
    });
  });

  // a new product has no stock: it comes only with a delivery
  it.each([5, 0, ' '])('refuses a stock of %p', (stock) => {
    expect(codeOf(() => normalizeCreateProductInput({ ...validProduct, stock }))).toBe(
      'PRODUCT_STOCK_NOT_ALLOWED',
    );
  });

  it.each([
    ['the name is blank', { name: '   ' }, 'PRODUCT_NAME_INVALID'],
    ['the name is missing', { name: undefined }, 'PRODUCT_NAME_INVALID'],
    ['the price is negative', { price: -1 }, 'PRODUCT_PRICE_INVALID'],
    ['the price is a word', { price: 'free' }, 'PRODUCT_PRICE_INVALID'],
    // a blank multipart field must not turn into a price of 0
    ['the price is blank', { price: '  ' }, 'PRODUCT_PRICE_INVALID'],
    ['the category is zero', { categoryId: 0 }, 'CATEGORY_ID_INVALID'],
    ['the category is missing', { categoryId: undefined }, 'CATEGORY_ID_INVALID'],
    ['the category is a fraction', { categoryId: 1.5 }, 'CATEGORY_ID_INVALID'],
    ['the price has a part of a cent', { price: 10.004 }, 'PRODUCT_PRICE_INVALID'],
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
      categoryIdRaw: undefined,
      popularityOverrideRaw: undefined,
      popularityOverrideUntilDate: undefined,
    });
  });

  // the stock changes only with a delivery or a write-off
  it.each([-3, 5, 0])('refuses a stock of %p', (stock) => {
    expect(codeOf(() => normalizeUpdateProductInput({ stock }))).toBe('PRODUCT_STOCK_NOT_ALLOWED');
  });

  // a form sends every field as text: the numbers come out as numbers, the texts trimmed
  it('gives back each field sent, a number as a number and a text trimmed', () => {
    const until = new Date(Date.now() + 86_400_000).toISOString();

    expect(
      normalizeUpdateProductInput({
        name: '  Floor lamp ',
        description: '  Warm light  ',
        price: '12.50',
        categoryId: '4',
        popularityOverride: '7',
        popularityOverrideUntil: until,
      }),
    ).toEqual({
      nameNorm: 'Floor lamp',
      descriptionNorm: 'Warm light',
      priceRaw: 12.5,
      categoryIdRaw: 4,
      popularityOverrideRaw: 7,
      popularityOverrideUntilDate: new Date(until),
    });
  });

  // an empty description clears the text, the service writes it as none
  it('gives an empty description back as an empty text', () => {
    expect(normalizeUpdateProductInput({ description: '   ' }).descriptionNorm).toBe('');
  });

  it('takes a free product and a popularity override of 0', () => {
    expect(normalizeUpdateProductInput({ price: 0, popularityOverride: 0 })).toMatchObject({
      priceRaw: 0,
      popularityOverrideRaw: 0,
    });
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
    ['the price is a word', { price: 'cheap' }, 'PRODUCT_PRICE_INVALID'],
    ['the price has a part of a cent', { price: '10.004' }, 'PRODUCT_PRICE_INVALID'],
    ['the price is above the highest one', { price: MAX_PRICE + 1 }, 'PRODUCT_PRICE_INVALID'],
    ['the category is negative', { categoryId: -4 }, 'CATEGORY_ID_INVALID'],
    ['the category is zero', { categoryId: 0 }, 'CATEGORY_ID_INVALID'],
    ['the category is a fraction', { categoryId: 2.5 }, 'CATEGORY_ID_INVALID'],
    ['the category is a word', { categoryId: 'shoes' }, 'CATEGORY_ID_INVALID'],
    ['the override is a word', { popularityOverride: 'high' }, 'POPULARITY_OVERRIDE_INVALID'],
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

    // in stock is counted in free units, the stock less the reserve and the units over: the
    // service counts them on the rows, a filter of prisma has no word for it
    expect(out).toEqual({
      mode: 'fixed',
      value: -2,
      dryRun: true,
      reason: 'winter sale',
      inStock: true,
      where: {
        AND: [
          { categoryId: 4 },
          { id: { in: [3, 8] } },
          { price: { gte: new Prisma.Decimal(10), lte: new Prisma.Decimal(50) } },
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

  // a lowering in money below 100 is no percent: only a percent stops at -100
  it('lets a fixed change go below -100', () => {
    expect(normalizeBulkUpdateProductsPriceInput({ mode: 'fixed', value: -150 }).value).toBe(-150);
  });

  it('takes a price of 0 as a bound, and one bound alone', () => {
    expect(
      normalizeBulkUpdateProductsPriceInput({ mode: 'fixed', value: 1, scope: { minPrice: 0 } })
        .where,
    ).toEqual({ AND: [{ price: { gte: new Prisma.Decimal(0) } }, { deletedAt: null }] });
    expect(
      normalizeBulkUpdateProductsPriceInput({ mode: 'fixed', value: 1, scope: { maxPrice: 0 } })
        .where,
    ).toEqual({ AND: [{ price: { lte: new Prisma.Decimal(0) } }, { deletedAt: null }] });
  });

  it('takes the same lowest and highest price', () => {
    expect(
      normalizeBulkUpdateProductsPriceInput({
        mode: 'fixed',
        value: 1,
        scope: { minPrice: 10, maxPrice: 10 },
      }).where,
    ).toEqual({
      AND: [
        { price: { gte: new Prisma.Decimal(10), lte: new Prisma.Decimal(10) } },
        { deletedAt: null },
      ],
    });
  });

  // in stock is a yes or a no, another value is no filter at all
  it('passes in stock on only when it is true or false', () => {
    expect(
      normalizeBulkUpdateProductsPriceInput({ mode: 'fixed', value: 1, scope: { inStock: false } })
        .inStock,
    ).toBe(false);
    expect(
      normalizeBulkUpdateProductsPriceInput({ mode: 'fixed', value: 1, scope: { inStock: 'yes' } }),
    ).not.toHaveProperty('inStock');
    expect(normalizeBulkUpdateProductsPriceInput({ mode: 'fixed', value: 1 })).not.toHaveProperty(
      'inStock',
    );
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
    ['the value is endless', { value: Number.POSITIVE_INFINITY }, 'BULK_PRICE_VALUE_INVALID'],
    ['the category is invalid', { scope: { categoryId: 0 } }, 'CATEGORY_ID_INVALID'],
    ['the category is a fraction', { scope: { categoryId: 1.5 } }, 'CATEGORY_ID_INVALID'],
    ['a product id is invalid', { scope: { productIds: [1, -2] } }, 'PRODUCT_IDS_INVALID'],
    ['a product id is 0', { scope: { productIds: [0] } }, 'PRODUCT_IDS_INVALID'],
    ['a product id is a fraction', { scope: { productIds: [1.5] } }, 'PRODUCT_IDS_INVALID'],
    ['a product id is a word', { scope: { productIds: ['x'] } }, 'PRODUCT_IDS_INVALID'],
    ['the min price is negative', { scope: { minPrice: -1 } }, 'MIN_PRICE_INVALID'],
    ['the min price is a word', { scope: { minPrice: 'low' } }, 'MIN_PRICE_INVALID'],
    ['the max price is negative', { scope: { maxPrice: -1 } }, 'MAX_PRICE_INVALID'],
    ['the max price is a word', { scope: { maxPrice: 'high' } }, 'MAX_PRICE_INVALID'],
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
