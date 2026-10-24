import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import {
  BUYER_SORTS,
  buildProductIdsQuery,
  buildSuggestionsQuery,
  makeNextCursor,
  mapProductListRowToResponse,
  normalizeFindAllProductsInput,
  type ProductListQuery,
} from '@routes/api/products/services/helpers/getAllProducts.helper.js';

import type { FindAllProductsDto, ProductsSortField } from 'types/dto/products.dto.js';

import { thrownBy } from '../../../../../../helpers/errors.js';

// the catalog list: a buyer (guest, user) and an admin (admin, root) see other fields and sort by
// other ones. Every list goes through one raw query of ids (the price a product sells at and its
// sale depend on the time), Prisma reads the rows of the page

const imageUrl = 'https://res.cloudinary.com/demo/image/upload/v1/products/1/0.jpg';

const row = {
  id: 1,
  name: 'Desk lamp',
  description: 'Warm light' as string | null,
  sku: 'DL-1' as string | null,
  price: new Prisma.Decimal('25.50') as unknown,
  salePrice: null as unknown,
  saleEndsAt: null as Date | null,
  salePriorPrice: null as unknown,
  stock: 10,
  reservedStock: 3,
  expiredStock: 0,
  category: { id: 2, name: 'Lamps', slug: 'lamps' },
  views: 40,
  popularity: 7,
  popularityOverride: null as number | null,
  popularityOverrideUntil: null as Date | null,
  avgRating: new Prisma.Decimal('4.25') as unknown,
  reviewsCount: 4,
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  updatedAt: new Date('2026-01-05T10:00:00.000Z'),
  deletedAt: null as Date | null,
  images: [{ url: imageUrl, position: 0, isPrimary: true }],
};

const map = (patch: Partial<typeof row> = {}, view: 'buyer' | 'admin' = 'buyer') =>
  mapProductListRowToResponse({ ...row, ...patch }, view);

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

describe('mapProductListRowToResponse', () => {
  it('turns decimals into numbers and dates into iso strings', () => {
    expect(map()).toMatchObject({
      id: 1,
      name: 'Desk lamp',
      price: 25.5,
      avgRating: 4.25,
      createdAt: '2026-01-01T10:00:00.000Z',
    });
  });

  it('shows only the units that are not reserved by orders', () => {
    expect(map().stock).toBe(7);
  });

  // the product card shows the same, a list and a card must not disagree
  it('never shows a negative stock, even if reservations exceed it', () => {
    expect(map({ stock: 2, reservedStock: 5 }).stock).toBe(0);
  });

  it('names the category of the product', () => {
    expect(map().category).toEqual({ id: 2, name: 'Lamps', slug: 'lamps' });
    expect(map()).not.toHaveProperty('categoryId');
  });

  it('leaves out an empty description', () => {
    expect(map({ description: null })).not.toHaveProperty('description');
  });

  it('builds the image urls from the primary image', () => {
    expect(map().images?.url200).toContain('/upload/c_fit,w_200');
  });

  // a buyer lists only the products with an image, an admin lists the others with no images
  it('gives a product without an image no images', () => {
    expect(map({ images: [] }, 'admin').images).toBeNull();
  });

  // the card of the product page does the same
  it('shows the sale next to the price while it lasts, and leaves it out past its end', () => {
    const salePrice = new Prisma.Decimal('19.90');
    const saleEndsAt = new Date(Date.now() + 60_000);

    expect(map({ salePrice, saleEndsAt })).toMatchObject({
      price: 25.5,
      salePrice: 19.9,
      saleEndsAt: saleEndsAt.toISOString(),
    });
    expect(map({ salePrice, saleEndsAt: new Date(Date.now() - 1) })).not.toHaveProperty(
      'salePrice',
    );
  });

  // a buyer sorts by popularity and the list shows it; the rest is for admins
  it('shows a buyer the popularity and nothing of the admin', () => {
    const out = map({ deletedAt: new Date('2026-02-01T00:00:00.000Z') });

    expect(out.popularity).toBe(7);
    for (const field of [
      'views',
      'updatedAt',
      'totalStock',
      'reservedStock',
      'popularityOverride',
      'popularityOverrideUntil',
      'deletedAt',
    ]) {
      expect(out).not.toHaveProperty(field);
    }
  });

  it('shows an admin the counters, the whole stock, the override and the delete date', () => {
    const out = map(
      {
        popularityOverride: 500,
        popularityOverrideUntil: new Date('2026-03-01T00:00:00.000Z'),
        deletedAt: new Date('2026-02-01T00:00:00.000Z'),
      },
      'admin',
    );

    expect(out).toMatchObject({
      stock: 7,
      totalStock: 10,
      reservedStock: 3,
      popularity: 7,
      views: 40,
      updatedAt: '2026-01-05T10:00:00.000Z',
      popularityOverride: 500,
      popularityOverrideUntil: '2026-03-01T00:00:00.000Z',
      deletedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  // an empty field of an admin is null, so every field is there
  it('shows an admin an empty override, sale and delete date as null', () => {
    expect(map({}, 'admin')).toMatchObject({
      popularityOverride: null,
      popularityOverrideUntil: null,
      salePrice: null,
      saleEndsAt: null,
      deletedAt: null,
    });
  });

  it('shows an admin a sale past its end, the way the row keeps it', () => {
    const saleEndsAt = new Date(Date.now() - 1);

    expect(map({ salePrice: new Prisma.Decimal('19.90'), saleEndsAt }, 'admin')).toMatchObject({
      salePrice: 19.9,
      saleEndsAt: saleEndsAt.toISOString(),
    });
  });
});

describe('normalizeFindAllProductsInput', () => {
  it('lists 20 products that are not deleted, the most popular first, when the query sets nothing', () => {
    expect(
      normalizeFindAllProductsInput({ actorRole: 'GUEST' } as FindAllProductsDto),
    ).toMatchObject({
      view: 'buyer',
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

  describe('a buyer', () => {
    it.each(['GUEST', 'USER'] as const)('%s sees the catalog of a buyer', (actorRole) => {
      expect(normalizeFindAllProductsInput(dto({ actorRole })).view).toBe('buyer');
    });

    // a buyer sees every product of the catalog, on sale or not; the flags are the admin's
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

    it.each(['onSale', 'popularityOverridden'] as const)(
      'may not use the admin flag %s',
      (filter) => {
        expect(
          thrownBy(() => normalizeFindAllProductsInput(dto({ [filter]: true }))),
        ).toMatchObject({ statusCode: 403, errorCode: 'FILTER_FORBIDDEN', details: { filter } });
      },
    );

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
    ] as const)('lists by the condition of the flag %s only', (flag, expected) => {
      const q = asAdmin({ [flag]: true });

      expect(q.deleted).toBe(expected.deleted);
      expect(q.onSale).toBe(expected.onSale);
      expect(q.popularityOverridden).toBe(expected.popularityOverridden);
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
    ] as const)('sorts by %s only with its flag', (sort, flag, errorCode) => {
      expect(asAdmin({ sort, ...flag }).sort).toBe(sort);
      expect(thrownBy(() => asAdmin({ sort }))).toMatchObject({ statusCode: 400, errorCode });
    });
  });
});

// the price a product sells at now, the expression the raw query sorts and filters by
const CURRENT_PRICE = 'cartlify.product_current_price(p."price", p."salePrice", p."saleEndsAt")';
// the free units a list shows and filters by: stock less the reserved units and the units of
// batches that are over, never below 0
const FREE_STOCK =
  'GREATEST(p."stock" - p."reservedStock" - cartlify.product_expired_units(p.id), 0)';
// a sale that is on: the sale price while the end is ahead, in utc as prisma keeps dates
const SALE_ON = `(p."salePrice" IS NOT NULL AND p."saleEndsAt" > (now() AT TIME ZONE 'UTC'))`;
// an override that is on: the database takes it while its end is ahead, an override without an
// end does nothing (recalc_product_popularity, db/05)
// the end is checked for null first: NOT of the condition keeps an override without an end
const OVERRIDE_ON =
  `(p."popularityOverride" IS NOT NULL AND p."popularityOverrideUntil" IS NOT NULL ` +
  `AND p."popularityOverrideUntil" > (now() AT TIME ZONE 'UTC'))`;

const query = (patch: Partial<ProductListQuery> = {}) =>
  buildProductIdsQuery({
    view: 'buyer',
    limit: 20,
    sort: 'popularity',
    order: 'desc',
    deleted: false,
    branch: true,
    ...patch,
  });

// a cursor of the sort, the way makeNextCursor gives it
const cursorOf = (payload: Record<string, unknown>, sort = 'popularity:desc') =>
  encodeCursor({ s: sort, ...payload } as never);

const HAS_PRIMARY_IMAGE = `EXISTS (SELECT 1 FROM "product_images" i WHERE i."productId" = p."id" AND i."isPrimary")`;

describe('buildProductIdsQuery', () => {
  it('lists to a buyer only the products with an image, to an admin every one', () => {
    expect(sqlText(query())).toContain(HAS_PRIMARY_IMAGE);
    expect(sqlText(query({ view: 'admin' }))).not.toContain(HAS_PRIMARY_IMAGE);
  });

  it('suggests to a buyer only the products with an image, to an admin every one', () => {
    expect(sqlText(buildSuggestionsQuery('lamp', 'buyer'))).toContain(HAS_PRIMARY_IMAGE);
    expect(sqlText(buildSuggestionsQuery('lamp', 'admin'))).not.toContain(HAS_PRIMARY_IMAGE);
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

  // a typo, another order of the words, the name of the category, the article number
  it('finds a product by a close name, by its category and by its article number', () => {
    const sql = query({ search: 'lamp' });
    const text = sqlText(sql);

    expect(text).toContain(
      'cartlify.word_similarity(cartlify.immutable_unaccent(?), cartlify.immutable_unaccent(p."name")) >= ?',
    );
    expect(text).toContain('FROM "categories" c WHERE c."id" = p."categoryId"');
    expect(text).toContain('lower(p."sku") = lower(?)');
  });

  it('sorts a search by how well a product matches it, the best first', () => {
    const text = sqlText(query({ search: 'lamp', sort: 'relevance' }));

    expect(text).toMatch(
      /ORDER BY round\(\(GREATEST\(.+\)\)::numeric, 6\) DESC, p\."id" DESC LIMIT \?$/,
    );
  });

  it('matches no name without a search text', () => {
    expect(sqlText(query())).not.toContain('ILIKE');
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

  // a product on sale sells at its sale price, the filter takes the price it sells at now
  it('adds the category and the price filters as parameters', () => {
    const sql = query({ categoryIds: [2, 7], minPrice: 10, maxPrice: 50 });
    const text = sqlText(sql);

    expect(text).toContain(
      'p."categoryId" IN ( WITH RECURSIVE branch AS ( SELECT c."id" FROM "categories" c WHERE c."id" IN (?,?) UNION SELECT c."id" FROM "categories" c JOIN branch b ON c."parentId" = b."id" ) SELECT "id" FROM branch )',
    );
    expect(text).toContain(`${CURRENT_PRICE} >= ?`);
    expect(text).toContain(`${CURRENT_PRICE} <= ?`);
    expect(text).not.toMatch(/p\."price" [<>]=/);
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

    expect(text).toContain('p."price" >= ?');
    expect(text).toContain('p."price" <= ?');
    expect(text).not.toContain(CURRENT_PRICE);
  });

  // the list shows stock minus reserved units and the units of batches that are over, the
  // filter has to use the same number, or "in stock" returns products the list shows with stock 0
  it.each([
    [true, `${FREE_STOCK} > 0`],
    [false, `${FREE_STOCK} = 0`],
  ])('compares free units, not the raw stock, when inStock is %s', (inStock, condition) => {
    expect(sqlText(query({ inStock }))).toContain(condition);
  });

  describe('the flags of an admin', () => {
    it.each([
      [true, `AND ${SALE_ON}`],
      [false, `NOT ${SALE_ON}`],
    ])('keeps products by an active sale when onSale is %s', (onSale, condition) => {
      expect(sqlText(query({ view: 'admin', onSale }))).toContain(condition);
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
      expect(text).not.toContain(SALE_ON);
    });

    // a buyer sees every product of the catalog, on sale or not
    it('filters a buyer by neither', () => {
      const text = sqlText(query());

      expect(text).not.toContain('"popularityOverride"');
      expect(text).not.toContain(SALE_ON);
    });
  });

  describe('the order', () => {
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
      ['reservedStock', 'p."reservedStock"'],
      ['totalStock', 'p."stock"'],
      // the stock a list shows: free units, never below 0
      ['stock', FREE_STOCK],
      ['expiredStock', 'cartlify.product_expired_units(p.id)'],
      // the usual price, the one the field shows; the sale price is a sort of its own
      ['price', 'p."price"'],
      ['salePrice', 'p."salePrice"'],
    ] as const)('orders by %s and then by id in the same direction', (sort, expression) => {
      expect(sqlText(query({ view: 'admin', sort, order: 'asc' }))).toContain(
        `ORDER BY ${expression} ASC, p."id" ASC`,
      );
    });

    // a buyer pays the sale price while the sale lasts
    it('orders a price sort of a buyer by the price a product sells at now', () => {
      expect(sqlText(query({ sort: 'price', order: 'asc' }))).toContain(
        `ORDER BY ${CURRENT_PRICE} ASC, p."id" ASC`,
      );
    });

    it('orders the sales of an admin by their end', () => {
      expect(
        sqlText(query({ view: 'admin', onSale: true, sort: 'saleEndsAt', order: 'asc' })),
      ).toContain('ORDER BY p."saleEndsAt" ASC, p."id" ASC');
    });

    // a buyer gets the whole catalog: the products on sale first by the end of the sale, in the
    // direction asked for, then every other one by popularity, the most popular first
    it.each(['ASC', 'DESC'] as const)(
      'gives a buyer the products on sale first going %s, then the rest by popularity',
      (dir) => {
        const sql = query({ sort: 'saleEndsAt', order: dir === 'ASC' ? 'asc' : 'desc' });

        expect(sqlText(sql)).toContain(
          `ORDER BY CASE WHEN ${SALE_ON} THEN 1 ELSE 0 END DESC, ` +
            `CASE WHEN ${SALE_ON} THEN p."saleEndsAt" END ${dir}, ` +
            `CASE WHEN ${SALE_ON} THEN p."id" END ${dir}, ` +
            `p."popularity" DESC, p."id" DESC`,
        );
      },
    );
  });

  describe('cursor', () => {
    const at = '2026-04-08T08:00:00.000Z';

    it('continues a name sort after the last name, passing the name as a parameter', () => {
      const sql = query({
        sort: 'name',
        order: 'desc',
        cursor: cursorOf({ id: 4, v: 'Lamp' }, 'name:desc'),
      });

      expect(sqlText(sql)).toContain('AND ( p."name" < ? OR (p."name" = ? AND p."id" < ?) )');
      expect(sql.values).toEqual(expect.arrayContaining(['Lamp', 4]));
    });

    it('continues after the last row: a later value, or the same value and a later id', () => {
      const sql = query({
        sort: 'price',
        order: 'asc',
        cursor: cursorOf({ id: 4, v: 49.99 }, 'price:asc'),
      });

      expect(sqlText(sql)).toContain(
        `AND ( ${CURRENT_PRICE} > ? OR (${CURRENT_PRICE} = ? AND p."id" > ?) )`,
      );
      expect(sql.values).toEqual(expect.arrayContaining([49.99, 4]));
    });

    it('turns a date cursor into a date parameter', () => {
      const sql = query({
        sort: 'createdAt',
        order: 'desc',
        cursor: cursorOf({ id: 4, v: at }, 'createdAt:desc'),
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
        cursor: cursorOf({ id: 4, v: at }, 'popularityOverrideUntil:asc'),
      });

      expect(sqlText(sql)).toContain(
        'AND ( p."popularityOverrideUntil" > ? OR (p."popularityOverrideUntil" = ? AND p."id" > ?) )',
      );
    });

    // the products on sale go first: after one of them come the later ones and every product
    // without a sale; after a product without a sale only the less popular ones
    it('continues the sale sort of a buyer inside the products on sale', () => {
      const sql = query({
        sort: 'saleEndsAt',
        order: 'asc',
        cursor: cursorOf({ id: 4, g: 1, v: at }, 'saleEndsAt:asc'),
      });

      expect(sqlText(sql)).toContain(
        `AND ( (${SALE_ON} AND (p."saleEndsAt" > ? OR (p."saleEndsAt" = ? AND p."id" > ?))) OR NOT ${SALE_ON} )`,
      );
      expect(sql.values).toContainEqual(new Date(at));
    });

    it('continues the sale sort of a buyer inside the products without a sale', () => {
      const sql = query({
        sort: 'saleEndsAt',
        order: 'asc',
        cursor: cursorOf({ id: 4, g: 0, v: 12 }, 'saleEndsAt:asc'),
      });

      expect(sqlText(sql)).toContain(
        `AND ( NOT ${SALE_ON} AND (p."popularity" < ? OR (p."popularity" = ? AND p."id" < ?)) )`,
      );
      expect(sql.values).toEqual(expect.arrayContaining([12, 4]));
    });

    // a cursor comes back from the client: a changed one is a bad request, not a server error
    it.each([
      ['comes from another sort', { sort: 'price' as const }, { id: 4, v: 10 }, 'popularity:desc'],
      ['comes from another direction', {}, { id: 4, v: 10 }, 'popularity:asc'],
      ['has no sort', {}, { id: 4, v: 10 }, undefined],
      [
        'gives a date sort a word',
        { sort: 'createdAt' as const },
        { id: 4, v: 'soon' },
        'createdAt:desc',
      ],
      [
        'gives a date sort null',
        { sort: 'updatedAt' as const },
        { id: 4, v: null },
        'updatedAt:desc',
      ],
      ['gives a counter sort a word', {}, { id: 4, v: 'many' }, 'popularity:desc'],
      ['gives a counter sort null', {}, { id: 4, v: null }, 'popularity:desc'],
      [
        'gives the sale sort no part',
        { sort: 'saleEndsAt' as const },
        { id: 4, v: 12 },
        'saleEndsAt:desc',
      ],
      [
        'gives the sale sort a word for a product without a sale',
        { sort: 'saleEndsAt' as const },
        { id: 4, g: 0, v: 'x' },
        'saleEndsAt:desc',
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

describe('makeNextCursor', () => {
  const next = (q: Partial<ProductListQuery>, keys: Record<string, unknown>) =>
    decodeCursor(
      makeNextCursor(
        { view: 'buyer', sort: 'popularity', order: 'desc', ...q } as ProductListQuery,
        { id: 4, ...keys },
      ),
    );

  it.each([
    ['name', 'Chair', 'Chair'],
    ['price', new Prisma.Decimal('49.99'), 49.99],
    ['popularity', 7, 7],
    ['createdAt', new Date('2026-04-04T08:00:00.000Z'), '2026-04-04T08:00:00.000Z'],
  ] as const)('puts the %s of the last row next to its id and the sort', (sort, v, shown) => {
    expect(next({ sort, order: 'asc' }, { v })).toEqual({ id: 4, v: shown, s: `${sort}:asc` });
  });

  it.each([
    [
      'on sale, with the end of its sale',
      { g: 1, endsAt: new Date('2026-04-08T08:00:00.000Z'), popularity: 3 },
      { g: 1, v: '2026-04-08T08:00:00.000Z' },
    ],
    ['without a sale, with its popularity', { g: 0, endsAt: null, popularity: 3 }, { g: 0, v: 3 }],
  ])('puts the part and the value of a buyer sale sort for a product %s', (_case, keys, part) => {
    expect(next({ sort: 'saleEndsAt', order: 'asc' }, keys)).toEqual({
      id: 4,
      s: 'saleEndsAt:asc',
      ...part,
    });
  });
});
