import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import {
  buildCursorWhere,
  buildOrderBy,
  buildProductSearchIdsQuery,
  makeNextCursor,
  mapProductListRowToResponse,
  normalizeFindAllProductsInput,
} from '@routes/api/products/services/helpers/getAllProducts.helper.js';
import { InternalError } from '@utils/errors.js';

import type { FindAllProductsDto, ProductsSortField, SortOrder } from 'types/dto/products.dto.js';

import { thrownBy } from '../../../../../../helpers/errors.js';
import { matchesWhere, sortRows, walkPages } from '../../../../../../helpers/prismaWhere.js';

const imageUrl = 'https://res.cloudinary.com/demo/image/upload/v1/products/1/0.jpg';

const row = {
  id: 1,
  name: 'Desk lamp',
  description: 'Warm light' as string | null,
  price: new Prisma.Decimal('25.50') as unknown,
  stock: 10,
  reservedStock: 3,
  categoryId: 2,
  views: 40,
  popularity: 7,
  avgRating: new Prisma.Decimal('4.25') as unknown,
  reviewsCount: 4,
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  updatedAt: new Date('2026-01-05T10:00:00.000Z'),
  deletedAt: null as Date | null,
  images: [{ url: imageUrl, position: 0, isPrimary: true }],
};

const map = (patch: Partial<typeof row> = {}) => mapProductListRowToResponse({ ...row, ...patch });

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

  it('leaves out an empty description and shows when a product was deleted', () => {
    const out = map({ description: null, deletedAt: new Date('2026-02-01T00:00:00.000Z') });

    expect(out).not.toHaveProperty('description');
    expect(out.deletedAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('builds the image urls from the primary image', () => {
    expect(map().images.url200).toContain('/upload/c_fit,w_200');
  });

  it('throws an internal error when a product has no image, which every product must have', () => {
    expect(thrownBy(() => map({ images: [] }))).toBeInstanceOf(InternalError);
  });
});

describe('normalizeFindAllProductsInput', () => {
  it('lists 20 products that are not deleted, the most popular first, when the query sets nothing', () => {
    expect(
      normalizeFindAllProductsInput({ actorRole: 'GUEST' } as FindAllProductsDto),
    ).toMatchObject({
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
  it('rejects a category filter in which no id is valid instead of dropping the filter', () => {
    expect(thrownBy(() => normalizeFindAllProductsInput(dto({ categoryIds: [0] })))).toMatchObject({
      statusCode: 400,
      errorCode: 'CATEGORY_IDS_INVALID',
    });
  });

  // the controller drops invalid ids, ?categoryIds=0 reaches the helper as []
  it.each([
    ['empty, as the controller passes ?categoryIds=0', []],
    ['only zero and negative ids', [0, -1]],
  ])('rejects a category filter that is %s', (_case, categoryIds) => {
    expect(thrownBy(() => normalizeFindAllProductsInput(dto({ categoryIds })))).toMatchObject({
      errorCode: 'CATEGORY_IDS_INVALID',
    });
  });

  it('lists every category when the filter is not sent', () => {
    expect(normalizeFindAllProductsInput(dto()).categoryIds).toBeUndefined();
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

  describe('deleted products', () => {
    it.each(['GUEST', 'USER', 'ADMIN', 'ROOT'] as const)(
      'shows %s only products that are not deleted when the flag is not sent',
      (actorRole) => {
        expect(normalizeFindAllProductsInput(dto({ actorRole })).deleted).toBe(false);
      },
    );

    it.each(['GUEST', 'USER'] as const)(
      'lets %s ask for products that are not deleted',
      (actorRole) => {
        expect(normalizeFindAllProductsInput(dto({ actorRole, deleted: false })).deleted).toBe(
          false,
        );
      },
    );

    it.each(['GUEST', 'USER'] as const)('forbids %s to see deleted products', (actorRole) => {
      expect(
        thrownBy(() => normalizeFindAllProductsInput(dto({ actorRole, deleted: true }))),
      ).toMatchObject({ statusCode: 403, errorCode: 'DELETED_PRODUCTS_FORBIDDEN' });
    });

    it.each(['ADMIN', 'ROOT'] as const)(
      'shows %s only deleted products on request',
      (actorRole) => {
        expect(normalizeFindAllProductsInput(dto({ actorRole, deleted: true })).deleted).toBe(true);
      },
    );

    it('treats a deleted flag that is not a boolean as not sent', () => {
      const input = dto({
        actorRole: 'ADMIN',
        deleted: 'yes',
      } as unknown as Partial<FindAllProductsDto>);

      expect(normalizeFindAllProductsInput(input).deleted).toBe(false);
    });

    // products that are not deleted have no deletedAt to sort by
    it.each([
      ['a guest', { actorRole: 'GUEST' as const }],
      ['an admin without the flag', { actorRole: 'ADMIN' as const }],
      [
        'an admin asking for products that are not deleted',
        { actorRole: 'ADMIN' as const, deleted: false },
      ],
    ])('rejects a sort by deletedAt from %s', (_case, patch) => {
      expect(
        thrownBy(() => normalizeFindAllProductsInput(dto({ ...patch, sort: 'deletedAt' }))),
      ).toMatchObject({ statusCode: 400, errorCode: 'SORT_DELETED_AT_REQUIRES_DELETED' });
    });

    it('sorts the deleted products of an admin by deletedAt', () => {
      expect(
        normalizeFindAllProductsInput(dto({ actorRole: 'ROOT', deleted: true, sort: 'deletedAt' })),
      ).toMatchObject({ deleted: true, sort: 'deletedAt' });
    });
  });
});

const day = (n: number) => new Date(`2026-04-${String(n).padStart(2, '0')}T08:00:00.000Z`);

// ties on every sort field, deleted and not deleted products mixed
const products = [
  {
    id: 1,
    name: 'Lamp',
    price: new Prisma.Decimal('25.50'),
    stock: 4,
    popularity: 9,
    views: 10,
    avgRating: new Prisma.Decimal('4.50'),
    reviewsCount: 2,
    createdAt: day(1),
    updatedAt: day(3),
    deletedAt: null,
  },
  {
    id: 2,
    name: 'Desk',
    price: new Prisma.Decimal('99.00'),
    stock: 0,
    popularity: 9,
    views: 10,
    avgRating: new Prisma.Decimal('0.00'),
    reviewsCount: 0,
    createdAt: day(2),
    updatedAt: day(2),
    deletedAt: day(8),
  },
  {
    id: 3,
    name: 'Lamp',
    price: new Prisma.Decimal('25.50'),
    stock: 4,
    popularity: 1,
    views: 3,
    avgRating: new Prisma.Decimal('4.50'),
    reviewsCount: 2,
    createdAt: day(2),
    updatedAt: day(3),
    deletedAt: null,
  },
  {
    id: 4,
    name: 'Chair',
    price: new Prisma.Decimal('49.99'),
    stock: 12,
    popularity: 5,
    views: 40,
    avgRating: new Prisma.Decimal('3.00'),
    reviewsCount: 7,
    createdAt: day(4),
    updatedAt: day(9),
    deletedAt: day(8),
  },
  {
    id: 5,
    name: 'Mug',
    price: new Prisma.Decimal('5.00'),
    stock: 0,
    popularity: 5,
    views: 3,
    avgRating: new Prisma.Decimal('5.00'),
    reviewsCount: 1,
    createdAt: day(4),
    updatedAt: day(5),
    deletedAt: null,
  },
  {
    id: 6,
    name: 'Shelf',
    price: new Prisma.Decimal('49.99'),
    stock: 1,
    popularity: 0,
    views: 0,
    avgRating: new Prisma.Decimal('0.00'),
    reviewsCount: 0,
    createdAt: day(6),
    updatedAt: day(6),
    deletedAt: day(9),
  },
  {
    id: 7,
    name: 'Desk',
    price: new Prisma.Decimal('120.00'),
    stock: 3,
    popularity: 2,
    views: 8,
    avgRating: new Prisma.Decimal('3.00'),
    reviewsCount: 7,
    createdAt: day(7),
    updatedAt: day(9),
    deletedAt: null,
  },
  {
    id: 8,
    name: 'Rug',
    price: new Prisma.Decimal('5.00'),
    stock: 12,
    popularity: 1,
    views: 40,
    avgRating: new Prisma.Decimal('4.50'),
    reviewsCount: 1,
    createdAt: day(7),
    updatedAt: day(1),
    deletedAt: null,
  },
];

const SORTS: ProductsSortField[] = [
  'name',
  'price',
  'stock',
  'popularity',
  'views',
  'avgRating',
  'reviewsCount',
  'createdAt',
  'updatedAt',
  'deletedAt',
];
const ORDERS: SortOrder[] = ['asc', 'desc'];

// the service filters by the deleted flag the same way: a list holds either live or deleted products
const LISTS = [
  [
    'products that are not deleted',
    { deletedAt: null },
    SORTS.filter((sort) => sort !== 'deletedAt'),
  ],
  ['deleted products', { deletedAt: { not: null } }, SORTS],
] as const;

describe.each(LISTS)('product list pagination without search: %s', (_list, where, sorts) => {
  describe.each(sorts)('sorted by %s', (sort) => {
    it.each(ORDERS)('visits every product exactly once, in order, going %s', (order) => {
      const orderBy = buildOrderBy(sort, order);

      const visited = walkPages({
        rows: products,
        where,
        orderBy,
        limit: 2,
        cursorWhere: (cursor) => buildCursorWhere({ sort, order, cursor }),
        nextCursor: (last) => makeNextCursor(sort, last),
      });

      const listed = products.filter((product) => matchesWhere(product, where));
      expect(visited).toEqual(sortRows(listed, orderBy).map((product) => product.id));
    });
  });
});

describe('buildCursorWhere', () => {
  it('adds no condition without a cursor', () => {
    expect(buildCursorWhere({ sort: 'price', order: 'asc' })).toBeUndefined();
  });

  // a cursor comes back from the client: a changed one is a bad request, not a server error
  it.each([
    ['a date sort gets a word', 'createdAt', 'last week'],
    ['a date sort gets null', 'updatedAt', null],
    ['a deleted date sort gets a word', 'deletedAt', 'never'],
    ['a deleted date sort gets null', 'deletedAt', null],
    ['a price sort gets a word', 'price', 'cheap'],
    ['a counter sort gets null', 'views', null],
  ] as const)('rejects the cursor when %s', (_case, sort, v) => {
    const cursor = encodeCursor({ id: 3, v });

    expect(thrownBy(() => buildCursorWhere({ sort, order: 'asc', cursor }))).toMatchObject({
      statusCode: 400,
      errorCode: 'CURSOR_INVALID',
    });
  });
});

describe('makeNextCursor', () => {
  it.each([
    ['name', products[3]!, 'Chair'],
    ['price', products[3]!, 49.99],
    ['avgRating', products[3]!, 3],
    ['reviewsCount', products[3]!, 7],
    ['createdAt', products[3]!, '2026-04-04T08:00:00.000Z'],
    ['deletedAt', products[3]!, '2026-04-08T08:00:00.000Z'],
    ['deletedAt', products[0]!, null],
  ] as const)('puts the %s of the last row next to its id', (sort, last, v) => {
    expect(decodeCursor(makeNextCursor(sort, last))).toEqual({ id: last.id, v });
  });
});

const search = (patch: Partial<Parameters<typeof buildProductSearchIdsQuery>[0]> = {}) =>
  buildProductSearchIdsQuery({
    limit: 20,
    sort: 'popularity',
    order: 'desc',
    search: 'lamp',
    ...patch,
  });

describe('buildProductSearchIdsQuery', () => {
  it('requires a search text', () => {
    expect(thrownBy(() => search({ search: '   ' }))).toMatchObject({
      statusCode: 400,
      errorCode: 'SEARCH_REQUIRED',
    });
  });

  it('passes the search text as a parameter, never inside the sql text', () => {
    const text = "lamp'; drop table products; --";
    const sql = search({ search: text });

    expect(sql.sql).not.toContain('drop table');
    expect(sql.values).toContain(text);
  });

  it('matches names without accents and case through the indexed expression', () => {
    expect(sqlText(search())).toContain(
      `cartlify.immutable_unaccent(p."name") ILIKE '%' || cartlify.immutable_unaccent(?) || '%'`,
    );
  });

  // "50%" is a product name, not "50 and anything"; "_" is not "any one character"
  it.each([
    ['%', '50%', '50\\%'],
    ['_', 'usb_c', 'usb\\_c'],
    ['a backslash', 'a\\b', 'a\\\\b'],
  ])('matches %s in the search text literally', (_case, text, escaped) => {
    const sql = search({ search: text });

    expect(sql.values).toContain(escaped);
    expect(sql.values).not.toContain(text);
  });

  it('fetches one id more than the page size, to know if a next page exists', () => {
    const sql = search({ limit: 5 });

    expect(sqlText(sql)).toMatch(/LIMIT \?$/);
    expect(sql.values.at(-1)).toBe(6);
  });

  it('adds the deleted, category and price filters as parameters', () => {
    const sql = search({ deleted: false, categoryIds: [2, 7], minPrice: 10, maxPrice: 50 });
    const text = sqlText(sql);

    expect(text).toContain('p."deletedAt" IS NULL');
    expect(text).toContain('p."categoryId" IN (?,?)');
    expect(text).toContain('p."price" >= ?');
    expect(text).toContain('p."price" <= ?');
    expect(sql.values).toEqual(expect.arrayContaining([2, 7, 10, 50]));
  });

  it('keeps only deleted products when asked for them', () => {
    expect(sqlText(search({ deleted: true }))).toContain('p."deletedAt" IS NOT NULL');
  });

  // the list shows stock minus reserved units, the filter has to use the same number,
  // or "in stock" returns products the list shows with stock 0
  it.each([
    [true, 'p."stock" > p."reservedStock"'],
    [false, 'p."stock" <= p."reservedStock"'],
  ])('compares free units, not the raw stock, when inStock is %s', (inStock, condition) => {
    const text = sqlText(search({ inStock }));

    expect(text).toContain(condition);
    expect(text).not.toMatch(/p\."stock" (> 0|= 0)/);
  });

  it.each(SORTS)('orders by %s and then by id in the same direction', (sort) => {
    expect(sqlText(search({ sort, order: 'asc' }))).toContain(
      `ORDER BY p."${sort}" ASC, p."id" ASC`,
    );
  });

  describe('cursor', () => {
    const at = '2026-04-08T08:00:00.000Z';

    it('continues a name sort after the last name, passing the name as a parameter', () => {
      const sql = search({
        sort: 'name',
        order: 'desc',
        cursor: encodeCursor({ id: 4, v: 'Lamp' }),
      });

      expect(sqlText(sql)).toContain('AND ( p."name" < ? OR (p."name" = ? AND p."id" < ?) )');
      expect(sql.values).toEqual(expect.arrayContaining(['Lamp', 4]));
    });

    it('continues after the last row: a later value, or the same value and a later id', () => {
      const sql = search({
        sort: 'price',
        order: 'asc',
        cursor: encodeCursor({ id: 4, v: 49.99 }),
      });

      expect(sqlText(sql)).toContain('AND ( p."price" > ? OR (p."price" = ? AND p."id" > ?) )');
      expect(sql.values).toEqual(expect.arrayContaining([49.99, 4]));
    });

    it('turns a date cursor into a date parameter', () => {
      const sql = search({
        sort: 'createdAt',
        order: 'desc',
        cursor: encodeCursor({ id: 4, v: at }),
      });

      expect(sql.values).toContainEqual(new Date(at));
    });

    // a deletedAt sort lists only deleted products, every one of them has the date
    it.each([
      ['asc', 'AND ( p."deletedAt" > ? OR (p."deletedAt" = ? AND p."id" > ?) )'],
      ['desc', 'AND ( p."deletedAt" < ? OR (p."deletedAt" = ? AND p."id" < ?) )'],
    ] as const)('continues a deleted date sort going %s like any date sort', (order, text) => {
      const sql = search({
        deleted: true,
        sort: 'deletedAt',
        order,
        cursor: encodeCursor({ id: 4, v: at }),
      });

      expect(sqlText(sql)).toContain(text);
      expect(sql.values).toContainEqual(new Date(at));
    });

    it.each([
      ['a date sort gets a word', 'createdAt', 'soon'],
      ['a date sort gets null', 'updatedAt', null],
      ['a deleted date sort gets a word', 'deletedAt', 'never'],
      ['a deleted date sort gets null', 'deletedAt', null],
      ['a counter sort gets a word', 'views', 'many'],
      ['a counter sort gets null', 'views', null],
    ] as const)('rejects the cursor when %s', (_case, sort, v) => {
      expect(thrownBy(() => search({ sort, cursor: encodeCursor({ id: 4, v }) }))).toMatchObject({
        statusCode: 400,
        errorCode: 'CURSOR_INVALID',
      });
    });
  });
});
