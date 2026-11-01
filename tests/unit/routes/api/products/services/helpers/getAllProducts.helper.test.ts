import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import { parseCharacteristicFilter } from '@helpers/characteristicFilter.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import {
  BUYER_SORTS,
  buildProductAggregatesQuery,
  buildProductIdsQuery,
  buildSuggestionsQuery,
  buildTotalQuery,
  listModeOf,
  makeNextCursor,
  normalizeFindAllProductsInput,
  type ListMode,
  type ProductListQuery,
} from '@routes/api/products/services/helpers/getAllProducts.helper.js';

import type { FindAllProductsDto, ProductsSortField } from 'types/dto/products.dto.js';

import { thrownBy } from '../../../../../../helpers/errors.js';

// the catalog list: a buyer (guest, user) and an admin (admin, root) see other rows and sort by other
// fields. A row is a product, or a variant when the query asks something of a variant. Every list
// goes through one raw query of ids (the price a variant sells at and its sale depend on the time),
// Prisma reads the rows of the page (the rows of the page: productList.helper.test.ts)

const dto = (patch: Partial<FindAllProductsDto> = {}): FindAllProductsDto =>
  ({
    actorRole: 'GUEST',
    limit: 20,
    sort: 'popularity',
    order: 'desc',
    ...patch,
  }) as FindAllProductsDto;

// whitespace-free sql text, so checks do not depend on how the query is indented
const sqlText = (sql: Prisma.Sql) => sql.sql.replace(/\s+/g, ' ').trim();

describe('listModeOf', () => {
  const mode = (patch: Partial<Parameters<typeof listModeOf>[0]> = {}): ListMode =>
    listModeOf({ sort: 'popularity', ...patch });

  it('makes the rows products when the query asks nothing of a variant', () => {
    expect(mode()).toBe('product');
    for (const sort of [
      'popularity',
      'createdAt',
      'updatedAt',
      'name',
      'avgRating',
      'reviewsCount',
      'views',
      'sales',
      'relevance',
      'deletedAt',
      'popularityOverride',
      'popularityOverrideUntil',
    ] as ProductsSortField[]) {
      expect(mode({ sort })).toBe('product');
    }
  });

  it.each([
    'price',
    'salePrice',
    'discount',
    'saleEndsAt',
    'stock',
    'totalStock',
    'reservedStock',
    'expiredStock',
  ] as ProductsSortField[])('makes the rows variants for a sort by %s', (sort) => {
    expect(mode({ sort })).toBe('variant');
  });

  it.each([
    ['a minimum price', { minPrice: 5 }],
    ['a maximum price', { maxPrice: 50 }],
    ['a price of zero', { minPrice: 0 }],
    ['the flag of the sale', { onSale: true }],
    ['a number of free units', { maxStock: 0 }],
    ['the flag of the shipping data', { withoutShippingData: true }],
  ])('makes the rows variants for %s', (_case, patch) => {
    expect(mode(patch)).toBe('variant');
  });

  // a product has a sale when a variant of it has one, and the plain list of an admin leaves such a
  // product out: that is a filter of products
  it('keeps the rows products for the sale an admin does not want', () => {
    expect(mode({ onSale: false })).toBe('product');
    expect(mode({ onSale: undefined })).toBe('product');
  });
});

describe('normalizeFindAllProductsInput', () => {
  it('lists 20 products that are not deleted, the most popular first, when the query sets nothing', () => {
    expect(
      normalizeFindAllProductsInput({ actorRole: 'GUEST' } as FindAllProductsDto),
    ).toMatchObject({
      view: 'buyer',
      mode: 'product',
      limit: 20,
      sort: 'popularity',
      order: 'desc',
      deleted: false,
      search: undefined,
      categoryIds: undefined,
      cursor: undefined,
    });
  });

  it('caps the page size at 100 and rejects one below one', () => {
    expect(normalizeFindAllProductsInput(dto({ limit: 1000 })).limit).toBe(100);
    expect(thrownBy(() => normalizeFindAllProductsInput(dto({ limit: -1 })))).toMatchObject({
      errorCode: 'LIMIT_INVALID',
    });
  });

  it('trims the search text and drops a blank one', () => {
    expect(normalizeFindAllProductsInput(dto({ search: '  lamp ' })).search).toBe('lamp');
    expect(normalizeFindAllProductsInput(dto({ search: '   ' })).search).toBeUndefined();
  });

  it('keeps only positive whole category ids', () => {
    expect(
      normalizeFindAllProductsInput(dto({ categoryIds: [2, 0, -1, 1.5, 7] })).categoryIds,
    ).toEqual([2, 7]);
  });

  // a filter that asked for something must not turn into "every product"
  it.each([
    ['empty, as the controller passes ?categoryIds=0', []],
    ['only zero and negative ids', [0, -1]],
  ])('rejects a category filter that is %s', (_case, categoryIds) => {
    expect(thrownBy(() => normalizeFindAllProductsInput(dto({ categoryIds })))).toMatchObject({
      statusCode: 400,
      errorCode: 'CATEGORY_IDS_INVALID',
    });
  });

  it.each([
    ['a negative minimum price', { minPrice: -1 }, 'MIN_PRICE_INVALID'],
    ['a minimum price that is not a number', { minPrice: Number.NaN }, 'MIN_PRICE_INVALID'],
    ['a negative maximum price', { maxPrice: -0.01 }, 'MAX_PRICE_INVALID'],
    ['an infinite maximum price', { maxPrice: Number.POSITIVE_INFINITY }, 'MAX_PRICE_INVALID'],
    ['a minimum above the maximum', { minPrice: 50, maxPrice: 10 }, 'PRICE_RANGE_INVALID'],
  ])('rejects %s', (_case, patch, errorCode) => {
    expect(thrownBy(() => normalizeFindAllProductsInput(dto(patch)))).toMatchObject({
      statusCode: 400,
      errorCode,
    });
  });

  it('accepts a range of one exact price and a free price of zero', () => {
    expect(normalizeFindAllProductsInput(dto({ minPrice: 0, maxPrice: 0 }))).toMatchObject({
      minPrice: 0,
      maxPrice: 0,
    });
  });

  it('keeps the in stock filter only when it is a boolean', () => {
    expect(normalizeFindAllProductsInput(dto({ inStock: true })).inStock).toBe(true);
    expect(
      normalizeFindAllProductsInput(
        dto({ inStock: 'yes' } as unknown as Partial<FindAllProductsDto>),
      ).inStock,
    ).toBeUndefined();
  });

  describe('the kind of the rows', () => {
    it('gives variants for a price in the sort or in the filter, products for the rest', () => {
      expect(normalizeFindAllProductsInput(dto()).mode).toBe('product');
      expect(normalizeFindAllProductsInput(dto({ inStock: true })).mode).toBe('product');
      expect(normalizeFindAllProductsInput(dto({ sort: 'price' })).mode).toBe('variant');
      expect(normalizeFindAllProductsInput(dto({ maxPrice: 9 })).mode).toBe('variant');
      expect(normalizeFindAllProductsInput(dto({ sort: 'saleEndsAt' })).mode).toBe('variant');
      expect(normalizeFindAllProductsInput(dto({ sort: 'sales' })).mode).toBe('product');
    });

    it('gives variants for the flags of an admin that are about a variant', () => {
      const asAdmin = (patch: Partial<FindAllProductsDto>) =>
        normalizeFindAllProductsInput(dto({ actorRole: 'ADMIN', ...patch })).mode;

      expect(asAdmin({})).toBe('product');
      expect(asAdmin({ deleted: true })).toBe('product');
      expect(asAdmin({ popularityOverridden: true })).toBe('product');
      expect(asAdmin({ onSale: true })).toBe('variant');
      expect(asAdmin({ maxStock: 3 })).toBe('variant');
      expect(asAdmin({ withoutShippingData: true })).toBe('variant');
      expect(asAdmin({ sort: 'stock' })).toBe('variant');
    });
  });

  describe('a buyer', () => {
    it.each(['GUEST', 'USER'] as const)('%s sees the catalog of a buyer', (actorRole) => {
      expect(normalizeFindAllProductsInput(dto({ actorRole })).view).toBe('buyer');
    });

    // a buyer sees every variant of the catalog, on sale or not; the flags are the admin's
    it('has no filter by the sale or by the override', () => {
      const q = normalizeFindAllProductsInput(dto());

      expect(q.onSale).toBeUndefined();
      expect(q.popularityOverridden).toBeUndefined();
    });

    it.each(BUYER_SORTS)('sorts by %s', (sort) => {
      expect(normalizeFindAllProductsInput(dto({ sort, search: 'lamp' })).sort).toBe(sort);
    });

    // the best match first: a search sorts by it unless another sort is asked for
    it('sorts a search by relevance and the catalog by popularity without a sort', () => {
      const unsorted = { actorRole: 'GUEST', limit: 20, order: 'desc' } as const;

      expect(normalizeFindAllProductsInput({ ...unsorted, search: 'lamp' }).sort).toBe('relevance');
      expect(normalizeFindAllProductsInput(unsorted).sort).toBe('popularity');
      expect(normalizeFindAllProductsInput(dto({ sort: 'price', search: 'lamp' })).sort).toBe(
        'price',
      );
    });

    it('refuses relevance without a search', () => {
      expect(
        thrownBy(() => normalizeFindAllProductsInput(dto({ sort: 'relevance' }))),
      ).toMatchObject({ statusCode: 400, errorCode: 'SORT_RELEVANCE_REQUIRES_SEARCH' });
    });

    // a parent category shows the products of the categories below it unless branch is false
    it('takes the whole branch of a category unless branch is false', () => {
      expect(normalizeFindAllProductsInput(dto({ categoryIds: [2] })).branch).toBe(true);
      expect(normalizeFindAllProductsInput(dto({ categoryIds: [2], branch: false })).branch).toBe(
        false,
      );
    });

    it.each([
      'views',
      'updatedAt',
      'stock',
      'reviewsCount',
      'salePrice',
      'totalStock',
      'reservedStock',
      'expiredStock',
      'popularityOverride',
      'popularityOverrideUntil',
      'deletedAt',
    ] as ProductsSortField[])('may not sort by %s', (sort) => {
      expect(thrownBy(() => normalizeFindAllProductsInput(dto({ sort })))).toMatchObject({
        statusCode: 403,
        errorCode: 'SORT_FORBIDDEN',
        details: { sort },
      });
    });

    it.each(['GUEST', 'USER'] as const)('%s may not see deleted products', (actorRole) => {
      expect(
        thrownBy(() => normalizeFindAllProductsInput(dto({ actorRole, deleted: true }))),
      ).toMatchObject({ statusCode: 403, errorCode: 'DELETED_PRODUCTS_FORBIDDEN' });
    });

    it.each(['onSale', 'popularityOverridden', 'withoutShippingData'] as const)(
      'may not use the admin flag %s',
      (filter) => {
        expect(
          thrownBy(() => normalizeFindAllProductsInput(dto({ [filter]: true }))),
        ).toMatchObject({ statusCode: 403, errorCode: 'FILTER_FORBIDDEN', details: { filter } });
      },
    );

    it('may not use the free units of an admin', () => {
      expect(thrownBy(() => normalizeFindAllProductsInput(dto({ maxStock: 2 })))).toMatchObject({
        statusCode: 403,
        errorCode: 'FILTER_FORBIDDEN',
        details: { filter: 'maxStock' },
      });
    });

    // false is what no flag means
    it('may send the flags as false', () => {
      const q = normalizeFindAllProductsInput(
        dto({ deleted: false, onSale: false, popularityOverridden: false }),
      );

      expect(q.deleted).toBe(false);
      expect(q.onSale).toBeUndefined();
      expect(q.popularityOverridden).toBeUndefined();
    });
  });

  describe('an admin', () => {
    const asAdmin = (patch: Partial<FindAllProductsDto> = {}) =>
      normalizeFindAllProductsInput(dto({ actorRole: 'ADMIN', ...patch }));

    it.each(['ADMIN', 'ROOT'] as const)('%s sees the catalog of an admin', (actorRole) => {
      expect(normalizeFindAllProductsInput(dto({ actorRole })).view).toBe('admin');
    });

    // without any flag an admin gets the plain products: not deleted, without a sale that is on
    // and without an override that is on
    it('lists the plain products when no flag is sent', () => {
      expect(asAdmin()).toMatchObject({
        deleted: false,
        onSale: false,
        popularityOverridden: false,
      });
    });

    it('treats a flag that is not a boolean as not sent', () => {
      expect(
        asAdmin({ deleted: 'yes', onSale: 1 } as unknown as Partial<FindAllProductsDto>),
      ).toMatchObject({ deleted: false, onSale: false, popularityOverridden: false });
    });

    // with a flag only its condition counts: the other marks do not filter, the deleted products
    // stay out without their flag
    it.each([
      ['deleted', { deleted: true, onSale: undefined, popularityOverridden: undefined }],
      ['onSale', { deleted: false, onSale: true, popularityOverridden: undefined }],
      ['popularityOverridden', { deleted: false, onSale: undefined, popularityOverridden: true }],
      [
        'withoutShippingData',
        { deleted: false, onSale: undefined, popularityOverridden: undefined },
      ],
    ] as const)('lists by the condition of the flag %s only', (flag, expected) => {
      const q = asAdmin({ [flag]: true });

      expect(q.deleted).toBe(expected.deleted);
      expect(q.onSale).toBe(expected.onSale);
      expect(q.popularityOverridden).toBe(expected.popularityOverridden);
    });

    // few free units are a flag too: every variant of the catalog with them, on sale or not
    it('lists by the free units of maxStock only, whatever the sale and the override', () => {
      expect(asAdmin({ maxStock: 3 })).toMatchObject({
        deleted: false,
        onSale: undefined,
        popularityOverridden: undefined,
        maxStock: 3,
      });
      expect(asAdmin({ maxStock: 0, onSale: true })).toMatchObject({ onSale: true, maxStock: 0 });
    });

    it('lists by the conditions of every flag sent', () => {
      expect(asAdmin({ onSale: true, popularityOverridden: true })).toMatchObject({
        deleted: false,
        onSale: true,
        popularityOverridden: true,
      });
    });

    it.each([
      'createdAt',
      'updatedAt',
      'price',
      'popularity',
      'views',
      'avgRating',
      'reviewsCount',
      'stock',
      'totalStock',
      'reservedStock',
      'expiredStock',
      'name',
    ] as ProductsSortField[])('sorts by %s', (sort) => {
      expect(asAdmin({ sort }).sort).toBe(sort);
    });

    // a field that only the products of a flag have is sorted with that flag
    it.each([
      ['deletedAt', { deleted: true }, 'SORT_DELETED_AT_REQUIRES_DELETED'],
      [
        'popularityOverride',
        { popularityOverridden: true },
        'SORT_POPULARITY_OVERRIDE_REQUIRES_OVERRIDDEN',
      ],
      [
        'popularityOverrideUntil',
        { popularityOverridden: true },
        'SORT_POPULARITY_OVERRIDE_REQUIRES_OVERRIDDEN',
      ],
      ['saleEndsAt', { onSale: true }, 'SORT_SALE_ENDS_AT_REQUIRES_ON_SALE'],
      ['salePrice', { onSale: true }, 'SORT_SALE_PRICE_REQUIRES_ON_SALE'],
      ['discount', { onSale: true }, 'SORT_DISCOUNT_REQUIRES_ON_SALE'],
    ] as const)('sorts by %s only with its flag', (sort, flag, errorCode) => {
      expect(asAdmin({ sort, ...flag }).sort).toBe(sort);
      expect(thrownBy(() => asAdmin({ sort }))).toMatchObject({ statusCode: 400, errorCode });
    });
  });
});

// the price a variant sells at now, the expression the raw query sorts and filters by
const CURRENT_PRICE = (a: string) =>
  `cartlify.product_current_price(${a}."price", ${a}."salePrice", ${a}."saleEndsAt")`;
// the free units a list shows and filters by: stock less the reserved units and the units of
// batches that are over, never below 0
const FREE_STOCK = (a: string) =>
  `GREATEST(${a}."stock" - ${a}."reservedStock" - cartlify.variant_expired_units(${a}.id), 0)`;
// a sale that is on: the sale price while the end is ahead, in utc as prisma keeps dates
const SALE_ON = (a: string) =>
  `(${a}."salePrice" IS NOT NULL AND ${a}."saleEndsAt" > (now() AT TIME ZONE 'UTC'))`;
// an override that is on: the database takes it while its end is ahead, an override without an
// end does nothing (recalc_product_popularity, db/05)
// the end is checked for null first: NOT of the condition keeps an override without an end
const OVERRIDE_ON =
  `(p."popularityOverride" IS NOT NULL AND p."popularityOverrideUntil" IS NOT NULL ` +
  `AND p."popularityOverrideUntil" > (now() AT TIME ZONE 'UTC'))`;
// a variant a buyer sees: alive, with a picture
const VISIBLE = (a: string) =>
  `(${a}."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM "variant_images" ${a}img WHERE ${a}img."variantId" = ${a}."id"))`;

const query = (patch: Partial<ProductListQuery> = {}) => buildProductIdsQuery(listQuery(patch));

// a list query the way normalize makes it; the mode follows the query unless the test names it
function listQuery(patch: Partial<ProductListQuery> = {}): ProductListQuery {
  const base = {
    view: 'buyer' as const,
    limit: 20,
    sort: 'popularity' as const,
    order: 'desc' as const,
    deleted: false,
    branch: true,
    ...patch,
  };

  return { ...base, mode: patch.mode ?? listModeOf(base) };
}

// a cursor of the sort, the way makeNextCursor gives it
const cursorOf = (payload: Record<string, unknown>, sort = 'product:popularity:desc') =>
  encodeCursor({ s: sort, ...payload } as never);

describe('buildProductIdsQuery', () => {
  describe('the rows are products', () => {
    it('lists a buyer the products that have a variant he sees, an admin every one', () => {
      const buyer = sqlText(query());
      const admin = sqlText(query({ view: 'admin' }));

      expect(buyer).toContain('FROM "products" p WHERE');
      expect(buyer).not.toContain('JOIN');
      expect(buyer).toContain(
        `EXISTS (SELECT 1 FROM "product_variants" sv WHERE sv."productId" = p."id" AND ${VISIBLE('sv')})`,
      );
      expect(admin).not.toContain('"variant_images"');
      expect(admin).not.toContain('sv."deletedAt"');
    });

    it('selects the id of the product and the value of the sort', () => {
      expect(sqlText(query())).toMatch(/^SELECT p\."id" AS id , p\."popularity" AS v FROM/);
    });

    it('orders by the sort and then by the id of the product in the same direction', () => {
      expect(sqlText(query({ sort: 'name', order: 'asc' }))).toContain(
        'ORDER BY p."name" ASC, p."id" ASC',
      );
    });
  });

  describe('the rows are variants', () => {
    it('joins the variants to their products and selects the id of the variant', () => {
      const text = sqlText(query({ sort: 'price' }));

      expect(text).toContain(
        'FROM "product_variants" v JOIN "products" p ON p."id" = v."productId" WHERE',
      );
      expect(text).toMatch(/^SELECT v\."id" AS id , v\."productId" AS "productId", /);
    });

    it('lists a buyer the variants he sees, an admin the ones that are alive', () => {
      expect(sqlText(query({ sort: 'price' }))).toContain(VISIBLE('v'));
      const admin = sqlText(query({ view: 'admin', sort: 'price' }));

      expect(admin).toContain('p."deletedAt" IS NULL AND v."deletedAt" IS NULL');
      expect(admin).not.toContain('"variant_images"');
    });

    it('lists every variant of a product that was taken out, with the flag of the deleted ones', () => {
      const text = sqlText(query({ view: 'admin', sort: 'price', deleted: true }));

      expect(text).toContain('p."deletedAt" IS NOT NULL');
      expect(text).not.toContain('v."deletedAt"');
    });

    it.each([
      ['name', 'p."name"'],
      ['popularity', 'p."popularity"'],
      ['createdAt', 'p."createdAt"'],
    ] as const)(
      'orders by the %s of the product and then by the id of the variant in the same direction',
      (sort, expression) => {
        expect(sqlText(query({ sort, order: 'asc', minPrice: 1 }))).toContain(
          `ORDER BY ${expression} ASC, v."id" ASC`,
        );
      },
    );
  });

  it('passes the search text as a parameter, never inside the sql text', () => {
    const text = "lamp'; drop table products; --";
    const sql = query({ search: text });

    expect(sql.sql).not.toContain('drop table');
    expect(sql.values).toContain(text);
  });

  it('matches names without accents and case through the indexed expression', () => {
    expect(sqlText(query({ search: 'lamp' }))).toContain(
      `cartlify.immutable_unaccent(p."name") ILIKE '%' || cartlify.immutable_unaccent(?) || '%'`,
    );
  });

  // "50%" is a product name, not "50 and anything"; "_" is not "any one character"
  it.each([
    ['%', '50%', '50\\%'],
    ['_', 'usb_c', 'usb\\_c'],
    ['a backslash', 'a\\b', 'a\\\\b'],
  ])('matches %s in the search text literally', (_case, text, escaped) => {
    const sql = query({ search: text });
    const patterns = sqlText(sql).split('ILIKE').length - 1;

    // every pattern of ILIKE (the name, the name of the category) takes the escaped text; the
    // text as it is goes only to the closeness of the words, which has no wildcards
    expect(patterns).toBe(2);
    expect(sql.values.filter((value) => value === escaped)).toHaveLength(patterns);
  });

  // a typo, another order of the words, the name of the category, the article number of a variant
  describe('the search', () => {
    it('finds a product by a close name and by its category', () => {
      const text = sqlText(query({ search: 'lamp' }));

      expect(text).toContain(
        'cartlify.word_similarity(cartlify.immutable_unaccent(?), cartlify.immutable_unaccent(p."name")) >= ?',
      );
      expect(text).toContain('FROM "categories" c WHERE c."id" = p."categoryId"');
    });

    it('finds a product row by the article number of one of its variants that the list holds', () => {
      const buyer = sqlText(query({ search: 'lamp' }));
      const admin = sqlText(query({ view: 'admin', search: 'lamp' }));

      expect(buyer).toContain(
        `OR EXISTS (SELECT 1 FROM "product_variants" cv WHERE cv."productId" = p."id" AND ${VISIBLE('cv')} AND lower(cv."sku") = lower(?))`,
      );
      // an admin lists the variants that are alive, and finds them by the barcode too
      expect(admin).toContain(
        `OR EXISTS (SELECT 1 FROM "product_variants" cv WHERE cv."productId" = p."id" AND cv."deletedAt" IS NULL AND (lower(cv."sku") = lower(?) OR cv."barcode" = ?))`,
      );
    });

    it('finds a variant row by its own article number', () => {
      const text = sqlText(query({ search: 'lamp', sort: 'price' }));

      expect(text).toContain('OR lower(v."sku") = lower(?)');
      expect(text).not.toContain('cv."sku"');
    });

    it('asks the barcode of an admin only', () => {
      expect(sqlText(query({ search: 'lamp' }))).not.toContain('"barcode"');
      expect(sqlText(query({ view: 'admin', search: 'lamp', sort: 'price' }))).toContain(
        '(lower(v."sku") = lower(?) OR v."barcode" = ?)',
      );
    });

    it('sorts by how well a row matches it, the best first', () => {
      const text = sqlText(query({ search: 'lamp', sort: 'relevance' }));

      expect(text).toMatch(
        /ORDER BY round\(\(GREATEST\(.+\)\)::numeric, 6\) DESC, p\."id" DESC LIMIT \?$/,
      );
    });

    it('ranks the code of a variant as a full match', () => {
      const text = sqlText(query({ search: 'lamp', sort: 'relevance' }));

      expect(text).toContain('CASE WHEN EXISTS (SELECT 1 FROM "product_variants" cv');
    });

    it('orders the rows of variants by relevance and then by the id of the variant', () => {
      const text = sqlText(query({ search: 'lamp', sort: 'relevance', minPrice: 1 }));

      expect(text).toMatch(/DESC, v\."id" DESC LIMIT \?$/);
      expect(text).toContain('CASE WHEN lower(v."sku") = lower(?) THEN 1 ELSE 0 END');
    });

    it('matches no name without a search text', () => {
      expect(sqlText(query())).not.toContain('ILIKE');
    });
  });

  it('fetches one id more than the page size, to know if a next page exists', () => {
    const sql = query({ limit: 5 });

    expect(sqlText(sql)).toMatch(/LIMIT \?$/);
    expect(sql.values.at(-1)).toBe(6);
  });

  it.each([
    [false, 'p."deletedAt" IS NULL'],
    [true, 'p."deletedAt" IS NOT NULL'],
  ])('keeps deleted products %s apart', (deleted, condition) => {
    expect(sqlText(query({ deleted }))).toContain(condition);
  });

  // a variant on sale sells at its sale price, the filter takes the price it sells at now
  it('adds the category and the price filters as parameters', () => {
    const sql = query({ categoryIds: [2, 7], minPrice: 10, maxPrice: 50 });
    const text = sqlText(sql);

    expect(text).toContain(
      'p."categoryId" IN ( WITH RECURSIVE branch AS ( SELECT c."id" FROM "categories" c WHERE c."id" IN (?,?) UNION SELECT c."id" FROM "categories" c JOIN branch b ON c."parentId" = b."id" ) SELECT "id" FROM branch )',
    );
    expect(text).toContain(`${CURRENT_PRICE('v')} >= ?`);
    expect(text).toContain(`${CURRENT_PRICE('v')} <= ?`);
    expect(text).not.toMatch(/v\."price" [<>]=/);
    expect(sql.values).toEqual(expect.arrayContaining([2, 7, 10, 50]));
  });

  it('takes only the products of each category itself with branch false', () => {
    const text = sqlText(query({ categoryIds: [2, 7], branch: false }));

    expect(text).toContain('p."categoryId" IN (?,?)');
    expect(text).not.toContain('RECURSIVE');
  });

  // an admin sorts and filters by the price the field shows, the sale price has its own sort
  it('filters the prices of an admin by the usual price', () => {
    const text = sqlText(query({ view: 'admin', minPrice: 10, maxPrice: 50 }));

    expect(text).toContain('v."price" >= ?');
    expect(text).toContain('v."price" <= ?');
    expect(text).not.toContain(CURRENT_PRICE('v'));
  });

  // the list shows stock minus reserved units and the units of batches that are over, the filter
  // has to use the same number, or "in stock" returns rows the list shows with stock 0
  describe('the free units', () => {
    it.each([
      [true, `${FREE_STOCK('v')} > 0`],
      [false, `${FREE_STOCK('v')} = 0`],
    ])(
      'compares the free units of a variant, when inStock is %s, in a list of variants',
      (inStock, condition) => {
        expect(sqlText(query({ inStock, sort: 'price' }))).toContain(condition);
      },
    );

    it('asks a product row for some variant with free units when inStock is true', () => {
      expect(sqlText(query({ inStock: true }))).toContain(
        `EXISTS (SELECT 1 FROM "product_variants" sv WHERE sv."productId" = p."id" AND ${VISIBLE('sv')} AND ${FREE_STOCK('sv')} > 0)`,
      );
    });

    it('asks a product row for no variant with free units when inStock is false', () => {
      expect(sqlText(query({ inStock: false }))).toContain(
        `AND NOT EXISTS (SELECT 1 FROM "product_variants" sv WHERE sv."productId" = p."id" AND ${VISIBLE('sv')} AND ${FREE_STOCK('sv')} > 0)`,
      );
    });

    it('keeps the variants with free units up to maxStock', () => {
      const text = sqlText(query({ view: 'admin', maxStock: 4 }));

      expect(text).toContain(`${FREE_STOCK('v')} <= ?`);
      expect(text).toContain('FROM "product_variants" v JOIN');
    });
  });

  it('keeps the variants that lack the weight or the sizes', () => {
    expect(sqlText(query({ view: 'admin', withoutShippingData: true }))).toContain(
      '(v."weightGrams" IS NULL OR v."lengthMm" IS NULL)',
    );
  });

  describe('the flags of an admin', () => {
    it('keeps the variants with a sale that is on when onSale is true', () => {
      const text = sqlText(query({ view: 'admin', onSale: true }));

      expect(text).toContain(`AND ${SALE_ON('v')}`);
      expect(text).toContain('FROM "product_variants" v JOIN');
    });

    it('keeps the variants without a sale when onSale is false in a list of variants', () => {
      expect(sqlText(query({ view: 'admin', onSale: false, sort: 'price' }))).toContain(
        `NOT ${SALE_ON('v')}`,
      );
    });

    // a product has a sale when a variant of it has one
    it('keeps the products without a sale on any variant when onSale is false in a list of products', () => {
      expect(sqlText(query({ view: 'admin', onSale: false }))).toContain(
        `NOT EXISTS (SELECT 1 FROM "product_variants" sv WHERE sv."productId" = p."id" AND sv."deletedAt" IS NULL AND ${SALE_ON('sv')})`,
      );
    });

    it.each([
      [true, `AND ${OVERRIDE_ON}`],
      [false, `NOT ${OVERRIDE_ON}`],
    ])(
      'keeps products by an override that is on when popularityOverridden is %s',
      (flag, condition) => {
        expect(sqlText(query({ view: 'admin', popularityOverridden: flag }))).toContain(condition);
      },
    );

    // a flag that is not part of the list filters nothing
    it('filters by neither when no flag is part of the list, as for a buyer', () => {
      const text = sqlText(query({ view: 'admin', deleted: true }));

      expect(text).not.toContain(OVERRIDE_ON);
      expect(text).not.toContain('"salePrice" IS NOT NULL');
    });

    // a buyer sees every variant of the catalog, on sale or not
    it('filters a buyer by neither', () => {
      const text = sqlText(query());

      expect(text).not.toContain('"popularityOverride"');
      expect(text).not.toContain('"salePrice" IS NOT NULL');
    });
  });

  describe('the order of the variants', () => {
    it.each([
      ['reservedStock', 'v."reservedStock"'],
      ['totalStock', 'v."stock"'],
      // the stock a list shows: free units, never below 0
      ['stock', FREE_STOCK('v')],
      ['expiredStock', 'cartlify.variant_expired_units(v.id)'],
      // the usual price, the one the field shows; the sale price is a sort of its own
      ['price', 'v."price"'],
      ['salePrice', 'v."salePrice"'],
      ['discount', 'round((v."price" - v."salePrice") / NULLIF(v."price", 0), 6)::float8'],
      ['saleEndsAt', 'v."saleEndsAt"'],
    ] as const)('orders by %s and then by the id of the variant', (sort, expression) => {
      expect(sqlText(query({ view: 'admin', onSale: true, sort, order: 'asc' }))).toContain(
        `ORDER BY ${expression} ASC, v."id" ASC`,
      );
    });

    it.each([
      ['name', 'p."name"'],
      ['popularity', 'p."popularity"'],
      ['views', 'p."views"'],
      ['avgRating', 'p."avgRating"'],
      ['reviewsCount', 'p."reviewsCount"'],
      ['createdAt', 'p."createdAt"'],
      ['updatedAt', 'p."updatedAt"'],
      ['deletedAt', 'p."deletedAt"'],
      ['popularityOverride', 'p."popularityOverride"'],
      ['popularityOverrideUntil', 'p."popularityOverrideUntil"'],
    ] as const)(
      'orders the products by %s and then by their id in the same direction',
      (sort, expression) => {
        expect(sqlText(query({ view: 'admin', sort, order: 'asc' }))).toContain(
          `ORDER BY ${expression} ASC, p."id" ASC`,
        );
      },
    );

    // a buyer pays the sale price while the sale lasts
    it('orders a price sort of a buyer by the price a variant sells at now', () => {
      expect(sqlText(query({ sort: 'price', order: 'asc' }))).toContain(
        `ORDER BY ${CURRENT_PRICE('v')} ASC, v."id" ASC`,
      );
    });

    // a buyer gets the whole catalog: the variants on sale first by the end of the sale, in the
    // direction asked for, then every other one by the popularity of its product, the most
    // popular first
    it.each(['ASC', 'DESC'] as const)(
      'gives a buyer the variants on sale first going %s, then the rest by popularity',
      (dir) => {
        const sql = query({ sort: 'saleEndsAt', order: dir === 'ASC' ? 'asc' : 'desc' });

        expect(sqlText(sql)).toContain(
          `ORDER BY CASE WHEN ${SALE_ON('v')} THEN 1 ELSE 0 END DESC, ` +
            `CASE WHEN ${SALE_ON('v')} THEN v."saleEndsAt" END ${dir}, ` +
            `CASE WHEN ${SALE_ON('v')} THEN v."id" END ${dir}, ` +
            `p."popularity" DESC, v."id" DESC`,
        );
      },
    );

    it('sorts the sales of a product with a join of the units sold, for the rows of products and of variants', () => {
      const period = {
        sort: 'sales' as const,
        salesFrom: new Date('2026-01-01T00:00:00Z'),
        salesTo: new Date('2026-02-01T00:00:00Z'),
      };

      const products = sqlText(query(period));
      const variants = sqlText(query({ ...period, minPrice: 1 }));

      expect(products).toContain(
        'FROM "products" p LEFT JOIN cartlify.units_sold_in_period(?::timestamp, ?::timestamp) s ON s.product_id = p."id"',
      );
      expect(variants).toContain(
        'JOIN "products" p ON p."id" = v."productId" LEFT JOIN cartlify.units_sold_in_period(',
      );
      expect(products).toContain('ORDER BY COALESCE(s.units, 0)::float8 DESC, p."id" DESC');
      expect(variants).toContain('ORDER BY COALESCE(s.units, 0)::float8 DESC, v."id" DESC');
    });
  });

  describe('cursor', () => {
    const at = '2026-04-08T08:00:00.000Z';

    it('continues a name sort after the last name, passing the name as a parameter', () => {
      const sql = query({
        sort: 'name',
        order: 'desc',
        cursor: cursorOf({ id: 4, v: 'Lamp' }, 'product:name:desc'),
      });

      expect(sqlText(sql)).toContain('AND ( p."name" < ? OR (p."name" = ? AND p."id" < ?) )');
      expect(sql.values).toEqual(expect.arrayContaining(['Lamp', 4]));
    });

    it('continues after the last row: a later value, or the same value and a later id', () => {
      const sql = query({
        sort: 'price',
        order: 'asc',
        cursor: cursorOf({ id: 4, v: 49.99 }, 'variant:price:asc'),
      });

      expect(sqlText(sql)).toContain(
        `AND ( ${CURRENT_PRICE('v')} > ? OR (${CURRENT_PRICE('v')} = ? AND v."id" > ?) )`,
      );
      expect(sql.values).toEqual(expect.arrayContaining([49.99, 4]));
    });

    it('breaks the ties of a sort of the product by the id of the variant', () => {
      const sql = query({
        sort: 'popularity',
        minPrice: 1,
        cursor: cursorOf({ id: 9, v: 3 }, 'variant:popularity:desc'),
      });

      expect(sqlText(sql)).toContain(
        'AND ( p."popularity" < ? OR (p."popularity" = ? AND v."id" < ?) )',
      );
    });

    it('turns a date cursor into a date parameter', () => {
      const sql = query({
        sort: 'createdAt',
        order: 'desc',
        cursor: cursorOf({ id: 4, v: at }, 'product:createdAt:desc'),
      });

      expect(sql.values).toContainEqual(new Date(at));
    });

    // an override that is on always has its end, the list of the flag sorts by it like any date
    it('continues a sort by the end of an override like any date sort', () => {
      const sql = query({
        view: 'admin',
        popularityOverridden: true,
        sort: 'popularityOverrideUntil',
        order: 'asc',
        cursor: cursorOf({ id: 4, v: at }, 'product:popularityOverrideUntil:asc'),
      });

      expect(sqlText(sql)).toContain(
        'AND ( p."popularityOverrideUntil" > ? OR (p."popularityOverrideUntil" = ? AND p."id" > ?) )',
      );
    });

    // the variants on sale go first: after one of them come the later ones and every variant
    // without a sale; after a variant without a sale only the less popular ones
    it('continues the sale sort of a buyer inside the variants on sale', () => {
      const sql = query({
        sort: 'saleEndsAt',
        order: 'asc',
        cursor: cursorOf({ id: 4, g: 1, v: at }, 'variant:saleEndsAt:asc'),
      });

      expect(sqlText(sql)).toContain(
        `AND ( (${SALE_ON('v')} AND (v."saleEndsAt" > ? OR (v."saleEndsAt" = ? AND v."id" > ?))) OR NOT ${SALE_ON('v')} )`,
      );
      expect(sql.values).toContainEqual(new Date(at));
    });

    it('continues the sale sort of a buyer inside the variants without a sale', () => {
      const sql = query({
        sort: 'saleEndsAt',
        order: 'asc',
        cursor: cursorOf({ id: 4, g: 0, v: 12 }, 'variant:saleEndsAt:asc'),
      });

      expect(sqlText(sql)).toContain(
        `AND ( NOT ${SALE_ON('v')} AND (p."popularity" < ? OR (p."popularity" = ? AND v."id" < ?)) )`,
      );
      expect(sql.values).toEqual(expect.arrayContaining([12, 4]));
    });

    // a cursor comes back from the client: a changed one is a bad request, not a server error
    it.each([
      [
        'comes from another sort',
        { sort: 'price' as const },
        { id: 4, v: 10 },
        'product:popularity:desc',
      ],
      ['comes from another direction', {}, { id: 4, v: 10 }, 'product:popularity:asc'],
      ['has no sort', {}, { id: 4, v: 10 }, undefined],
      // the rows of the other kind
      ['comes from a list of variants', {}, { id: 4, v: 10 }, 'variant:popularity:desc'],
      [
        'comes from a list of products',
        { minPrice: 1 },
        { id: 4, v: 10 },
        'product:popularity:desc',
      ],
      [
        'gives a date sort a word',
        { sort: 'createdAt' as const },
        { id: 4, v: 'soon' },
        'product:createdAt:desc',
      ],
      [
        'gives a date sort null',
        { sort: 'updatedAt' as const },
        { id: 4, v: null },
        'product:updatedAt:desc',
      ],
      ['gives a counter sort a word', {}, { id: 4, v: 'many' }, 'product:popularity:desc'],
      ['gives a counter sort null', {}, { id: 4, v: null }, 'product:popularity:desc'],
      [
        'gives the sale sort no part',
        { sort: 'saleEndsAt' as const },
        { id: 4, v: 12 },
        'variant:saleEndsAt:desc',
      ],
      [
        'gives the sale sort a word for a variant without a sale',
        { sort: 'saleEndsAt' as const },
        { id: 4, g: 0, v: 'x' },
        'variant:saleEndsAt:desc',
      ],
    ])('rejects a cursor that %s', (_case, patch, payload, sort) => {
      const cursor = encodeCursor((sort ? { s: sort, ...payload } : payload) as never);

      expect(thrownBy(() => query({ ...patch, cursor }))).toMatchObject({
        statusCode: 400,
        errorCode: 'CURSOR_INVALID',
      });
    });
  });
});

describe('buildTotalQuery', () => {
  it('counts the rows of the filters, with no page, no order and no cursor', () => {
    const sql = buildTotalQuery(
      listQuery({
        search: 'lamp',
        categoryIds: [3],
        limit: 5,
        cursor: cursorOf({ id: 4, v: 3 }),
      }),
    );
    const text = sqlText(sql);

    expect(text).toMatch(/^SELECT count\(\*\)::int AS total FROM "products" p WHERE /);
    expect(text).toContain('p."categoryId" IN');
    expect(text).toContain('ILIKE');
    expect(text).not.toContain('ORDER BY');
    expect(text).not.toContain('LIMIT');
    expect(text).not.toContain('"popularity" <');
  });

  it('counts the variants when the rows are variants', () => {
    const text = sqlText(buildTotalQuery(listQuery({ minPrice: 5 })));

    expect(text).toContain('FROM "product_variants" v JOIN "products" p ON p."id" = v."productId"');
    expect(text).toContain(`${CURRENT_PRICE('v')} >= ?`);
  });

  it('does not join the sales it does not need', () => {
    const text = sqlText(
      buildTotalQuery(
        listQuery({
          sort: 'sales',
          salesFrom: new Date('2026-01-01T00:00:00Z'),
          salesTo: new Date('2026-02-01T00:00:00Z'),
        }),
      ),
    );

    expect(text).not.toContain('units_sold_in_period');
  });
});

describe('buildProductAggregatesQuery', () => {
  const sql = (patch: Partial<Parameters<typeof buildProductAggregatesQuery>[0]> = {}) =>
    buildProductAggregatesQuery({ view: 'buyer', deleted: false, ...patch }, [4, 9]);

  it('reads the variants of the products of the page by their ids', () => {
    const built = sql();

    expect(sqlText(built)).toContain('WHERE v."productId" = ANY(?::int[])');
    expect(built.values).toContainEqual([4, 9]);
  });

  it('counts the variants a buyer sees and the ones an admin has alive', () => {
    expect(sqlText(sql())).toContain(`${VISIBLE('v')} AS listed`);
    expect(sqlText(sql({ view: 'admin' }))).toContain('v."deletedAt" IS NULL AS listed');
    expect(sqlText(sql({ view: 'admin', deleted: true }))).toContain('TRUE AS listed');
  });

  it('gives the lowest and the highest price and the free units of the variants it counts', () => {
    const text = sqlText(sql());

    expect(text).toContain(`${CURRENT_PRICE('v')} AS price`);
    expect(text).toContain('min(w.price) FILTER (WHERE w.listed) AS "minPrice"');
    expect(text).toContain('max(w.price) FILTER (WHERE w.listed) AS "maxPrice"');
    expect(text).toContain('COALESCE(sum(w.free) FILTER (WHERE w.listed), 0)::int AS stock');
  });

  it('picks the main variant: the first by its place with free units, the first of all when none has', () => {
    expect(sqlText(sql())).toContain(
      '(array_agg(w.id ORDER BY (w.listed AND w.named) DESC, w.tier, (w.free > 0) DESC, w.place, w.id))[1] AS "variantId"',
    );
  });

  // a variant without a code compares to null, which DESC would put first
  it('names the variant a search by a code finds, a variant without a code never', () => {
    const buyer = sqlText(sql({ search: 'Abc' }));
    const admin = sqlText(sql({ view: 'admin', search: 'Abc' }));

    expect(buyer).toContain('COALESCE(lower(v."sku") = lower(?), FALSE) AS named');
    expect(admin).toContain(
      'COALESCE((lower(v."sku") = lower(?) OR v."barcode" = ?), FALSE) AS named',
    );
    expect(sqlText(sql())).toContain('FALSE AS named');
  });

  // an admin gets the one a buyer would get first: the variants for sale with a picture, then the
  // ones for sale, then the rest
  it('puts the variants for sale with a picture first for an admin as for the card', () => {
    expect(sqlText(sql({ view: 'admin' }))).toContain(
      'CASE WHEN v."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM "variant_images" wi WHERE wi."variantId" = v."id") THEN 0 WHEN v."deletedAt" IS NULL THEN 1 ELSE 2 END AS tier',
    );
  });
});

describe('buildSuggestionsQuery', () => {
  it('suggests to a buyer only the products that have a variant he sees, to an admin every one', () => {
    expect(sqlText(buildSuggestionsQuery('lamp', 'buyer'))).toContain(
      `EXISTS (SELECT 1 FROM "product_variants" sv WHERE sv."productId" = p."id" AND ${VISIBLE('sv')})`,
    );
    expect(sqlText(buildSuggestionsQuery('lamp', 'admin'))).not.toContain('"product_variants"');
  });

  it('leaves out a product taken out of the catalog and gives at most 8 names, the best match first', () => {
    const text = sqlText(buildSuggestionsQuery('lamp', 'admin'));

    expect(text).toContain('p."deletedAt" IS NULL');
    expect(text).toMatch(/DESC, p\."id" DESC LIMIT 8$/);
  });

  it('matches names only, a code is no name', () => {
    const text = sqlText(buildSuggestionsQuery('lamp', 'buyer'));

    expect(text).not.toContain('"sku"');
    expect(text).toContain('ILIKE');
  });

  it('passes the text as a parameter', () => {
    const sql = buildSuggestionsQuery("x'; drop table products; --", 'buyer');

    expect(sql.sql).not.toContain('drop table');
  });
});

describe('the sorts by the discount and by the sales', () => {
  const asGuest = (extra: Partial<FindAllProductsDto>) =>
    normalizeFindAllProductsInput({ actorRole: 'GUEST', ...extra } as FindAllProductsDto);

  it('lets a buyer sort by the discount and by the sales', () => {
    expect(asGuest({ sort: 'discount' }).sort).toBe('discount');
    expect(asGuest({ sort: 'sales' }).sort).toBe('sales');
  });

  it('asks the days before the end of today (UTC) when no period is given, 30 of them', () => {
    const q = asGuest({ sort: 'sales' });

    const endOfToday = new Date();
    endOfToday.setUTCHours(24, 0, 0, 0);
    expect(q.salesTo).toEqual(endOfToday);
    expect(q.salesTo!.getTime() - q.salesFrom!.getTime()).toBe(30 * 86_400_000);
  });

  it('takes the period that is asked for, and only for the sort by sales', () => {
    const salesFrom = new Date('2026-01-01T00:00:00Z');
    const salesTo = new Date('2026-02-01T00:00:00Z');

    expect(asGuest({ sort: 'sales', salesFrom, salesTo })).toMatchObject({ salesFrom, salesTo });
    expect(asGuest({ sort: 'price', salesFrom, salesTo })).not.toHaveProperty('salesFrom');
  });

  it('takes the 30 days before the end that is asked for, and the end of today after the start', () => {
    const salesTo = new Date('2026-02-01T00:00:00Z');

    expect(asGuest({ sort: 'sales', salesTo }).salesFrom).toEqual(new Date('2026-01-02T00:00:00Z'));
  });

  it.each([
    [
      'ends before it starts',
      { salesFrom: new Date('2026-02-01'), salesTo: new Date('2026-01-01') },
    ],
    ['has no length', { salesFrom: new Date('2026-01-01'), salesTo: new Date('2026-01-01') }],
    ['starts at no date', { salesFrom: new Date('nonsense') }],
    ['ends in a year the database has not', { salesTo: new Date('+012345-01-01T00:00:00Z') }],
  ])('refuses a period that %s', (_case, extra) => {
    expect(thrownBy(() => asGuest({ sort: 'sales', ...extra }))).toMatchObject({
      statusCode: 400,
      errorCode: 'SALES_PERIOD_INVALID',
    });
  });

  it('keeps the discount of the last row of the part on sale in the cursor, the popularity of the rest', () => {
    const q = {
      view: 'buyer',
      mode: 'variant',
      sort: 'discount',
      order: 'desc',
    } as ProductListQuery;

    expect(decodeCursor(makeNextCursor(q, { id: 4, g: 1, discount: 0.35, popularity: 3 }))).toEqual(
      {
        id: 4,
        v: 0.35,
        s: 'variant:discount:desc',
        g: 1,
      },
    );
    expect(decodeCursor(makeNextCursor(q, { id: 4, g: 0, discount: null, popularity: 3 }))).toEqual(
      {
        id: 4,
        v: 3,
        s: 'variant:discount:desc',
        g: 0,
      },
    );
  });
});

describe('makeNextCursor', () => {
  const next = (q: Partial<ProductListQuery>, keys: Record<string, unknown>) =>
    decodeCursor(
      makeNextCursor(
        {
          view: 'buyer',
          mode: 'product',
          sort: 'popularity',
          order: 'desc',
          ...q,
        } as ProductListQuery,
        { id: 4, ...keys },
      ),
    );

  it.each([
    ['name', 'Chair', 'Chair'],
    ['price', new Prisma.Decimal('49.99'), 49.99],
    ['popularity', 7, 7],
    ['createdAt', new Date('2026-04-04T08:00:00.000Z'), '2026-04-04T08:00:00.000Z'],
  ] as const)('puts the %s of the last row next to its id and the sort', (sort, v, shown) => {
    expect(next({ sort, order: 'asc' }, { v })).toEqual({
      id: 4,
      v: shown,
      s: `product:${sort}:asc`,
    });
  });

  // the kind of the rows is in the key: a cursor of a list of variants does not continue a list of
  // products
  it('names the kind of the rows next to the sort', () => {
    expect(next({ mode: 'variant', sort: 'price' }, { v: 12 })).toMatchObject({
      s: 'variant:price:desc',
    });
    expect(next({ mode: 'product', sort: 'name' }, { v: 'x' })).toMatchObject({
      s: 'product:name:desc',
    });
  });

  it.each([
    [
      'on sale, with the end of its sale',
      { g: 1, endsAt: new Date('2026-04-08T08:00:00.000Z'), popularity: 3 },
      { g: 1, v: '2026-04-08T08:00:00.000Z' },
    ],
    ['without a sale, with its popularity', { g: 0, endsAt: null, popularity: 3 }, { g: 0, v: 3 }],
  ])('puts the part and the value of a buyer sale sort for a variant %s', (_case, keys, part) => {
    expect(next({ mode: 'variant', sort: 'saleEndsAt', order: 'asc' }, keys)).toEqual({
      id: 4,
      s: 'variant:saleEndsAt:asc',
      ...part,
    });
  });
});

// ---- the rows that are groups, the filter by characteristics and the flag group (step 8) ----

describe('the filter by characteristics and the flag group in the kind of the rows', () => {
  const entries = parseCharacteristicFilter('12:45,46');
  const mode = (patch: Partial<Parameters<typeof listModeOf>[0]> = {}): ListMode =>
    listModeOf({ sort: 'popularity', ...patch });

  it('makes the rows variants for a filter by characteristics, not for an empty one', () => {
    expect(mode({ characteristics: entries })).toBe('variant');
    expect(mode({ characteristics: [] })).toBe('product');
    expect(mode({ characteristics: undefined })).toBe('product');
  });

  it('makes the rows variants for an admin who sends group=false, not for group=true', () => {
    expect(mode({ group: false })).toBe('variant');
    expect(mode({ group: true })).toBe('product');
    expect(mode({ group: undefined })).toBe('product');
  });

  describe('normalizeFindAllProductsInput', () => {
    const asAdmin = (patch: Partial<FindAllProductsDto> = {}) =>
      normalizeFindAllProductsInput(dto({ actorRole: 'ADMIN', actorId: 1 as never, ...patch }));

    it('reads the filter and makes the rows groups of variants', () => {
      const q = normalizeFindAllProductsInput(dto({ f: ['12:45,46', '20:yes'] }));

      expect(q.characteristics).toHaveLength(2);
      expect(q).toMatchObject({ mode: 'variant', grouped: true });
    });

    it('has no characteristics when there is no filter', () => {
      expect(normalizeFindAllProductsInput(dto()).characteristics).toBeUndefined();
    });

    it('refuses a filter that is wrong, before it reads the rest', () => {
      expect(
        thrownBy(() => normalizeFindAllProductsInput(dto({ f: 'black', cursor: 'abc' }))),
      ).toMatchObject({ statusCode: 400, errorCode: 'FILTER_INVALID' });
    });

    it('makes the rows of a buyer groups whenever they are variants, and not when they are products', () => {
      expect(normalizeFindAllProductsInput(dto({ sort: 'price' }))).toMatchObject({
        mode: 'variant',
        grouped: true,
      });
      expect(normalizeFindAllProductsInput(dto({ minPrice: 1 }))).toMatchObject({
        mode: 'variant',
        grouped: true,
      });
      expect(normalizeFindAllProductsInput(dto())).toMatchObject({
        mode: 'product',
        grouped: false,
      });
    });

    it('makes the rows of an admin groups as a buyer gets them, by default and with group=true', () => {
      expect(asAdmin({ sort: 'price' })).toMatchObject({ mode: 'variant', grouped: true });
      expect(asAdmin({ sort: 'price', group: true })).toMatchObject({
        mode: 'variant',
        grouped: true,
      });
      expect(asAdmin()).toMatchObject({ mode: 'product', grouped: false });
      expect(asAdmin({ group: true })).toMatchObject({ mode: 'product', grouped: false });
    });

    it('gives an admin every variant on a row of its own with group=false, whatever else he asks', () => {
      expect(asAdmin({ group: false })).toMatchObject({
        mode: 'variant',
        grouped: false,
        group: false,
      });
      expect(asAdmin({ group: false, sort: 'price', f: '12:45' })).toMatchObject({
        mode: 'variant',
        grouped: false,
      });
    });

    it('refuses group=false to a buyer, and takes group=true', () => {
      expect(thrownBy(() => normalizeFindAllProductsInput(dto({ group: false })))).toMatchObject({
        statusCode: 403,
        errorCode: 'FILTER_FORBIDDEN',
        details: { filter: 'group' },
      });
      expect(normalizeFindAllProductsInput(dto({ group: true }))).toMatchObject({
        mode: 'product',
        grouped: false,
      });
    });
  });
});

describe('the query of ids for groups', () => {
  const grouped = (patch: Partial<ProductListQuery> = {}) =>
    listQuery({ sort: 'price', grouped: true, ...patch });
  const text = (patch: Partial<ProductListQuery> = {}) =>
    sqlText(buildProductIdsQuery(grouped(patch)));

  it('takes the variants that fit into the groups of their product and main characteristics', () => {
    const sql = text();

    expect(sql).toMatch(/^WITH base AS \( SELECT v\."id" AS id, v\."productId" AS "productId"/);
    expect(sql).toContain('FROM "product_variants" v JOIN "products" p ON p."id" = v."productId"');
    expect(sql).toContain('GROUP BY m."productId", m.sig');
    // the first variant of the group by its place stands for it
    expect(sql).toContain('(array_agg(m.id ORDER BY m.place, m.id))[1] AS id');
    expect(sql).toContain('min(m.price) AS "minPrice", max(m.price) AS "maxPrice"');
    expect(sql).toContain('sum(m.free)::int AS stock');
  });

  it('tells a variant by the main characteristics it has a value of, the other kinds left out', () => {
    const sql = text();

    // the values are joined to the variants, not asked for variant by variant
    expect(sql).toContain(
      'FROM base b LEFT JOIN "variant_attribute_values" mv ON mv."variantId" = b.id AND mv."attributeId" IN (SELECT ma."id" FROM "attributes" ma WHERE ma."isMain")',
    );
    expect(sql).toContain(
      `COALESCE(mv."optionId"::text, mv."numberValue"::text, mv."boolValue"::text)`,
    );
    expect(sql).toContain(
      'GROUP BY b.id, b."productId", b.place, b.price, b.free, b.sk ), grp AS (',
    );
    expect(sql).toContain('ORDER BY mv."attributeId", mv."optionId"), \'\') AS sig');
  });

  it('puts the filters inside the groups and the cursor after them', () => {
    const cursor = encodeCursor({ id: 4, v: 12, s: 'group:price:asc' } as never);
    const sql = text({ minPrice: 5, order: 'asc', cursor });

    const [inside, outside] = sql.split('), grp AS (');
    expect(inside).toContain(`${CURRENT_PRICE('v')} >= ?`);
    expect(inside).not.toContain('grp.');
    expect(outside).toContain('WHERE TRUE AND ( grp.v > ? OR (grp.v = ? AND grp.id > ?) )');
    expect(outside).toContain('ORDER BY grp.v ASC, grp.id ASC LIMIT ?');
  });

  it('stands a group at the lowest value of its variants going up and the highest going down', () => {
    expect(text({ order: 'asc' })).toContain('min(m.sk) AS v');
    expect(text({ order: 'desc' })).toContain('max(m.sk) AS v');
    expect(text({ order: 'desc' })).toContain('ORDER BY grp.v DESC, grp.id DESC');
  });

  it('sorts a group by the sort of the variant, the same way for every sort', () => {
    expect(text({ sort: 'price' })).toContain(`${CURRENT_PRICE('v')} AS sk`);
    expect(text({ sort: 'popularity', minPrice: 0 })).toContain('p."popularity" AS sk');
    expect(text({ sort: 'name', minPrice: 0 })).toContain('p."name" AS sk');
    expect(text({ view: 'admin', sort: 'stock' })).toContain(`${FREE_STOCK('v')} AS sk`);
  });

  it('takes the characteristics inside the groups, one condition each', () => {
    const characteristics = parseCharacteristicFilter(['12:45,46', '20:no']);

    const sql = text({ characteristics });

    expect(
      sql.match(/FROM "variant_attribute_values" fv WHERE fv\."variantId" = v\."id"/g),
    ).toHaveLength(2);
    expect(sql).toContain('fv."optionId" IN (?,?)');
    expect(sql).toContain('fv."boolValue" = ?');
  });

  it('ranks the groups of the sale sorts of a buyer by the variants on sale, then the popularity', () => {
    const sql = text({ sort: 'discount' });

    expect(sql).toContain('max(m.on_sale) AS g');
    expect(sql).toContain('max(m.sale_key) FILTER (WHERE m.on_sale = 1) AS discount');
    expect(sql).toContain('max(m.popularity) AS popularity');
    expect(sql).toContain(
      'ORDER BY grp.g DESC, CASE WHEN grp.g = 1 THEN grp.discount END DESC, CASE WHEN grp.g = 1 THEN grp.id END DESC, grp.popularity DESC, grp.id DESC',
    );
    // going up it is the soonest end of a group
    const asc = text({ sort: 'saleEndsAt', order: 'asc' });
    expect(asc).toContain('min(m.sale_key) FILTER (WHERE m.on_sale = 1) AS "endsAt"');
  });

  it('continues the sale sorts on the columns of the groups', () => {
    const onSale = encodeCursor({
      id: 4,
      v: '2026-04-08T08:00:00.000Z',
      g: 1,
      s: 'group:saleEndsAt:asc',
    } as never);
    const rest = encodeCursor({ id: 4, v: 3, g: 0, s: 'group:saleEndsAt:asc' } as never);

    const first = text({ sort: 'saleEndsAt', order: 'asc', cursor: onSale });
    const second = text({ sort: 'saleEndsAt', order: 'asc', cursor: rest });

    expect(first).toContain(
      'WHERE TRUE AND ( ((grp.g = 1) AND (grp."endsAt" > ? OR (grp."endsAt" = ? AND grp.id > ?))) OR NOT (grp.g = 1) )',
    );
    expect(second).toContain(
      'AND ( NOT (grp.g = 1) AND (grp.popularity < ? OR (grp.popularity = ? AND grp.id < ?)) )',
    );
  });

  it('refuses the cursor of another kind of rows', () => {
    const variants = encodeCursor({ id: 4, v: 12, s: 'variant:price:desc' } as never);
    const products = encodeCursor({ id: 4, v: 12, s: 'product:price:desc' } as never);

    for (const cursor of [variants, products]) {
      expect(thrownBy(() => buildProductIdsQuery(grouped({ cursor })))).toMatchObject({
        statusCode: 400,
        errorCode: 'CURSOR_INVALID',
      });
    }
    // and a cursor of groups is no cursor of single variants
    const groups = encodeCursor({ id: 4, v: 12, s: 'group:price:desc' } as never);
    expect(
      thrownBy(() => buildProductIdsQuery(listQuery({ sort: 'price', cursor: groups }))),
    ).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });

  it('keeps the query of single variants as it was when the rows are not grouped', () => {
    const sql = sqlText(buildProductIdsQuery(listQuery({ sort: 'price' })));

    expect(sql).not.toContain('WITH m AS');
    expect(sql).toMatch(/^SELECT v\."id" AS id , v\."productId" AS "productId", /);
  });
});

describe('the number of the groups', () => {
  it('counts the products with the main characteristics of their variants that fit', () => {
    const sql = sqlText(buildTotalQuery(listQuery({ sort: 'price', grouped: true })));

    expect(sql).toMatch(
      /^WITH base AS \( SELECT v\."id" AS id, v\."productId" AS "productId" FROM/,
    );
    expect(sql).toContain(
      'FROM "product_variants" v JOIN "products" p ON p."id" = v."productId" WHERE',
    );
    expect(sql).toContain(
      'SELECT count(*)::int AS total FROM (SELECT DISTINCT m."productId", m.sig FROM m) g',
    );
    // no page: no order of the rows (the one inside the signature is the order of its parts), no limit
    expect(sql).not.toContain('ORDER BY grp');
    expect(sql).not.toContain('LIMIT');
  });

  it('counts the single variants as before when the rows are not grouped', () => {
    const sql = sqlText(buildTotalQuery(listQuery({ sort: 'price' })));

    expect(sql).not.toContain('DISTINCT');
  });
});

describe('the cursor of a group', () => {
  const next = (q: Partial<ProductListQuery>, keys: Record<string, unknown>) =>
    decodeCursor(
      makeNextCursor(
        {
          view: 'buyer',
          mode: 'variant',
          grouped: true,
          sort: 'price',
          order: 'asc',
          ...q,
        } as never,
        { id: 4, ...keys },
      ),
    );

  it('names the groups in the key and keeps the id of the first variant and the value of the group', () => {
    expect(next({}, { v: new Prisma.Decimal('12.50') })).toEqual({
      id: 4,
      v: 12.5,
      s: 'group:price:asc',
    });
  });

  it('keeps the part of a sale sort the group is in', () => {
    expect(
      next(
        { sort: 'discount', order: 'desc' },
        { g: 1, discount: 0.4, endsAt: null, popularity: 3 },
      ),
    ).toEqual({ id: 4, v: 0.4, g: 1, s: 'group:discount:desc' });
  });

  it('names single variants as before when the rows are not grouped', () => {
    expect(next({ grouped: false }, { v: 12 })).toMatchObject({ s: 'variant:price:asc' });
  });
});

// the filters of an admin that find the gaps of the catalog: by a property of a variant they make
// the rows variants, by a property of a product they leave the rows products; all are flags, so a
// list that holds one lists what its condition says
describe('the filters of the gaps of the catalog', () => {
  const VARIANT_FLAGS = [
    'missingRequired',
    'withoutWeight',
    'withoutDimensions',
    'withoutBarcode',
    'withoutImages',
  ] as const;
  const PRODUCT_FLAGS = ['hiddenFromBuyers', 'hasDeletedVariants'] as const;
  const PARTY_FILTERS = ['manufacturerId', 'euResponsibleId', 'documentId'] as const;

  const asAdmin = (patch: Partial<FindAllProductsDto> = {}) =>
    normalizeFindAllProductsInput(dto({ actorRole: 'ADMIN', ...patch }));

  describe('the kind of the rows', () => {
    it.each(VARIANT_FLAGS)('makes the rows variants for %s', (flag) => {
      expect(listModeOf({ sort: 'popularity', [flag]: true })).toBe('variant');
      expect(asAdmin({ [flag]: true }).mode).toBe('variant');
    });

    it.each(PRODUCT_FLAGS)('keeps the rows products for %s', (flag) => {
      expect(asAdmin({ [flag]: true }).mode).toBe('product');
    });

    it.each(PARTY_FILTERS)('keeps the rows products for %s', (filter) => {
      expect(asAdmin({ [filter]: 4 }).mode).toBe('product');
    });

    it('keeps the rows products for a flag that is false', () => {
      expect(listModeOf({ sort: 'popularity', missingRequired: false, withoutWeight: false })).toBe(
        'product',
      );
    });

    it('makes the rows variants for a product filter with group=false', () => {
      expect(asAdmin({ hiddenFromBuyers: true, group: false }).mode).toBe('variant');
    });
  });

  describe('a buyer', () => {
    it.each([...VARIANT_FLAGS, ...PRODUCT_FLAGS])('may not use %s', (filter) => {
      expect(thrownBy(() => normalizeFindAllProductsInput(dto({ [filter]: true })))).toMatchObject({
        statusCode: 403,
        errorCode: 'FILTER_FORBIDDEN',
        details: { filter },
      });
    });

    it.each(PARTY_FILTERS)('may not use %s', (filter) => {
      expect(thrownBy(() => normalizeFindAllProductsInput(dto({ [filter]: 3 })))).toMatchObject({
        statusCode: 403,
        errorCode: 'FILTER_FORBIDDEN',
        details: { filter },
      });
    });

    // false is what no flag means, and for hiddenFromBuyers what a buyer sees anyway
    it.each([...VARIANT_FLAGS, ...PRODUCT_FLAGS])('may send %s as false', (filter) => {
      const q = normalizeFindAllProductsInput(dto({ [filter]: false }));

      expect(q[filter]).toBeUndefined();
      expect(q.mode).toBe('product');
    });
  });

  describe('an admin', () => {
    it.each([...VARIANT_FLAGS, 'hasDeletedVariants'] as const)(
      'keeps %s only when it is true',
      (flag) => {
        expect(asAdmin({ [flag]: true })[flag]).toBe(true);
        expect(asAdmin({ [flag]: false })[flag]).toBeUndefined();
        expect(
          asAdmin({ [flag]: 'yes' } as unknown as Partial<FindAllProductsDto>)[flag],
        ).toBeUndefined();
      },
    );

    // both answers are a filter: the products a buyer does not see, and the ones he sees
    it('keeps hiddenFromBuyers as it is asked for, true and false', () => {
      expect(asAdmin({ hiddenFromBuyers: true }).hiddenFromBuyers).toBe(true);
      expect(asAdmin({ hiddenFromBuyers: false }).hiddenFromBuyers).toBe(false);
      expect(asAdmin().hiddenFromBuyers).toBeUndefined();
    });

    it.each(PARTY_FILTERS)('keeps %s', (filter) => {
      expect(asAdmin({ [filter]: 7 })[filter]).toBe(7);
      expect(asAdmin()[filter]).toBeUndefined();
    });

    // with a flag only its condition counts: the sale and the override do not filter
    it.each([
      ...VARIANT_FLAGS.map((flag) => [flag, { [flag]: true }] as const),
      ['hiddenFromBuyers', { hiddenFromBuyers: true }] as const,
      ['hiddenFromBuyers (false)', { hiddenFromBuyers: false }] as const,
      ['hasDeletedVariants', { hasDeletedVariants: true }] as const,
      ['manufacturerId', { manufacturerId: 2 }] as const,
      ['euResponsibleId', { euResponsibleId: 2 }] as const,
      ['documentId', { documentId: 2 }] as const,
    ])('lists by the condition of %s only, whatever the sale and the override', (_flag, patch) => {
      expect(asAdmin(patch)).toMatchObject({
        deleted: false,
        onSale: undefined,
        popularityOverridden: undefined,
      });
    });

    it('lists the plain products when none of them is sent', () => {
      expect(asAdmin({ missingRequired: false, hasDeletedVariants: false })).toMatchObject({
        onSale: false,
        popularityOverridden: false,
      });
    });

    it('keeps the sale an admin asks for next to a new filter', () => {
      expect(asAdmin({ withoutBarcode: true, onSale: true })).toMatchObject({
        onSale: true,
        withoutBarcode: true,
      });
    });
  });

  describe('the sql', () => {
    const admin = (patch: Partial<ProductListQuery>) => sqlText(query({ view: 'admin', ...patch }));

    it('keeps the variants that lack a required characteristic through the view, one place for the rule', () => {
      expect(admin({ missingRequired: true })).toContain(
        'EXISTS (SELECT 1 FROM "variants_missing_required" mr WHERE mr."variant_id" = v."id")',
      );
      expect(admin({ missingRequired: true })).toContain('FROM "product_variants" v JOIN');
    });

    it('keeps the variants with no weight', () => {
      expect(admin({ withoutWeight: true })).toContain('v."weightGrams" IS NULL');
    });

    it('keeps the variants that lack any of the three sizes', () => {
      expect(admin({ withoutDimensions: true })).toContain(
        '(v."lengthMm" IS NULL OR v."widthMm" IS NULL OR v."heightMm" IS NULL)',
      );
    });

    it('keeps the variants with no barcode', () => {
      expect(admin({ withoutBarcode: true })).toContain('v."barcode" IS NULL');
    });

    it('keeps the variants with no picture bound', () => {
      expect(admin({ withoutImages: true })).toContain(
        'NOT EXISTS (SELECT 1 FROM "variant_images" wi WHERE wi."variantId" = v."id")',
      );
    });

    // the rule of a variant a buyer sees is the one of the buyer's own list
    it('keeps the products a buyer does not see: removed, or with no variant he sees', () => {
      const hidden = `(p."deletedAt" IS NOT NULL OR NOT EXISTS (SELECT 1 FROM "product_variants" hv WHERE hv."productId" = p."id" AND ${VISIBLE('hv')}))`;

      expect(admin({ hiddenFromBuyers: true })).toContain(`AND ${hidden}`);
      expect(admin({ hiddenFromBuyers: false })).toContain(`AND NOT ${hidden}`);
    });

    it('keeps the products that have a variant taken out of sale', () => {
      expect(admin({ hasDeletedVariants: true })).toContain(
        'EXISTS (SELECT 1 FROM "product_variants" dv WHERE dv."productId" = p."id" AND dv."deletedAt" IS NOT NULL)',
      );
    });

    it('keeps the products of a manufacturer and of a person responsible in the EU as parameters', () => {
      const built = query({ view: 'admin', manufacturerId: 8, euResponsibleId: 9 });

      expect(sqlText(built)).toContain('p."manufacturerId" = ?');
      expect(sqlText(built)).toContain('p."euResponsibleId" = ?');
      expect(built.values).toEqual(expect.arrayContaining([8, 9]));
    });

    it('keeps the products that hold a document as a parameter', () => {
      const built = query({ view: 'admin', documentId: 5 });

      expect(sqlText(built)).toContain(
        'EXISTS (SELECT 1 FROM "product_documents" pd WHERE pd."productId" = p."id" AND pd."documentId" = ?)',
      );
      expect(built.values).toContain(5);
    });

    it('filters the count of the rows by the same conditions', () => {
      const text = sqlText(
        buildTotalQuery(listQuery({ view: 'admin', missingRequired: true, manufacturerId: 4 })),
      );

      expect(text).toContain('"variants_missing_required"');
      expect(text).toContain('p."manufacturerId" = ?');
    });

    it('adds none of them to a list that did not ask', () => {
      const text = admin({});

      for (const name of [
        'variants_missing_required',
        'dv."deletedAt"',
        'product_documents',
        '"manufacturerId"',
        'hv."productId"',
      ]) {
        expect(text).not.toContain(name);
      }
    });
  });
});
