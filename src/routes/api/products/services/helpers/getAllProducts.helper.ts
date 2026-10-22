import { Prisma } from '@prisma/client';

import { BadRequestError, ForbiddenError, InternalError } from '@utils/errors.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { buildImageUrls } from '@utils/cloudinary.util.js';
import {
  cursorDate,
  cursorNumber,
  cursorString,
  decodeCursor,
  encodeCursor,
} from '@helpers/codeCursor.js';
import { assertLimit } from '@helpers/assertLimit.js';

import type {
  ProductsSortField,
  SortOrder,
  FindAllProductsDto,
  ProductResponseDto,
} from 'types/dto/products.dto.js';

import {
  adminFieldsOf,
  buyerFieldsOf,
  productResponseSelect,
  productViewOf,
  type ProductResponseRow,
  type ProductView,
} from './productMapper.helper.js';

// a product of a list: the fields of its answer and its primary image
export const productListSelect = {
  ...productResponseSelect,
  images: {
    where: { isPrimary: true },
    select: { url: true, position: true, isPrimary: true },
    orderBy: { position: 'asc' },
    take: 1,
  },
} as const;

// the sorts of a buyer; saleEndsAt gives the products on sale first, the rest by popularity
export const BUYER_SORTS: ProductsSortField[] = [
  'createdAt',
  'price',
  'popularity',
  'avgRating',
  'name',
  'saleEndsAt',
];

// the price a product sells at now (db/05): the sale price while the sale lasts. It depends on the
// time, so no index holds it and Prisma cannot order or filter by it: every list goes through one
// raw query of ids (buildProductIdsQuery), Prisma reads the rows of the page
const CURRENT_PRICE_SQL = Prisma.raw(
  `cartlify.product_current_price(p."price", p."salePrice", p."saleEndsAt")`,
);

// a sale that is on: a sale price while the end is ahead, in utc as prisma keeps dates (db/05)
const SALE_ON_SQL = Prisma.raw(
  `(p."salePrice" IS NOT NULL AND p."saleEndsAt" > (now() AT TIME ZONE 'UTC'))`,
);

// an override of the popularity that is on: the database takes it while its end is ahead, an
// override without an end or past it does nothing (recalc_product_popularity, db/05). The end is
// checked for null first, so the condition is never null and NOT of it keeps such a product
const OVERRIDE_ON_SQL = Prisma.raw(
  `(p."popularityOverride" IS NOT NULL AND p."popularityOverrideUntil" IS NOT NULL ` +
    `AND p."popularityOverrideUntil" > (now() AT TIME ZONE 'UTC'))`,
);

// the stock a list shows: free units, never below 0
const FREE_STOCK_SQL = Prisma.raw(`GREATEST(p."stock" - p."reservedStock", 0)`);

export type ProductListQuery = {
  view: ProductView;
  limit: number;
  sort: ProductsSortField;
  order: SortOrder;
  search?: string | undefined;
  categoryIds?: number[] | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  // every role: true lists only deleted products, false only the products that are not deleted
  deleted: boolean;
  inStock?: boolean | undefined;
  // an admin: true lists only the products with a sale / an override that is on, false only the
  // ones without, undefined does not filter; a buyer: undefined, every product of the catalog
  onSale?: boolean | undefined;
  popularityOverridden?: boolean | undefined;
  cursor?: string | undefined;
};

// a field only the products of a flag have: a sort by it comes with the flag
const SORT_FLAGS: Partial<
  Record<ProductsSortField, { flag: 'deleted' | 'onSale' | 'popularityOverridden'; code: string }>
> = {
  deletedAt: { flag: 'deleted', code: 'SORT_DELETED_AT_REQUIRES_DELETED' },
  saleEndsAt: { flag: 'onSale', code: 'SORT_SALE_ENDS_AT_REQUIRES_ON_SALE' },
  salePrice: { flag: 'onSale', code: 'SORT_SALE_PRICE_REQUIRES_ON_SALE' },
  popularityOverride: {
    flag: 'popularityOverridden',
    code: 'SORT_POPULARITY_OVERRIDE_REQUIRES_OVERRIDDEN',
  },
  popularityOverrideUntil: {
    flag: 'popularityOverridden',
    code: 'SORT_POPULARITY_OVERRIDE_REQUIRES_OVERRIDDEN',
  },
};

// normalize dto for findAll: a buyer sorts by BUYER_SORTS and uses no flag of an admin; an admin
// sorts by anything, a field only some products have with their flag
export function normalizeFindAllProductsInput(dto: FindAllProductsDto): ProductListQuery {
  const view = productViewOf(dto.actorRole);
  const limit = assertLimit(dto.limit ?? 20);

  const sort: ProductsSortField = (dto.sort ?? 'popularity') as ProductsSortField;
  const order: SortOrder = dto.order === 'asc' ? 'asc' : 'desc';

  const search =
    typeof dto.search === 'string' && dto.search.trim() ? dto.search.trim() : undefined;

  // a sent category filter with no valid id must not turn into "every product";
  // the controller drops invalid ids, so ?categoryIds=0 arrives here as an empty list
  const categoryIds = Array.isArray(dto.categoryIds)
    ? dto.categoryIds.filter((n) => Number.isInteger(n) && n > 0)
    : undefined;
  if (categoryIds && !categoryIds.length) throw new BadRequestError('CATEGORY_IDS_INVALID');

  const minPrice = dto.minPrice != null ? Number(dto.minPrice) : undefined;
  const maxPrice = dto.maxPrice != null ? Number(dto.maxPrice) : undefined;

  // validate price range
  if (minPrice != null && (!Number.isFinite(minPrice) || minPrice < 0)) {
    throw new BadRequestError('MIN_PRICE_INVALID');
  }
  if (maxPrice != null && (!Number.isFinite(maxPrice) || maxPrice < 0)) {
    throw new BadRequestError('MAX_PRICE_INVALID');
  }
  if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
    throw new BadRequestError('PRICE_RANGE_INVALID');
  }

  const inStock = typeof dto.inStock === 'boolean' ? dto.inStock : undefined;

  // a flag is on only when it is true: false, or anything else, is no flag
  const deleted = dto.deleted === true;
  const onSale = dto.onSale === true;
  const popularityOverridden = dto.popularityOverridden === true;

  // normalize cursor
  const cursor = typeof dto.cursor === 'string' && dto.cursor ? dto.cursor : undefined;

  const base = { view, limit, sort, order, search, categoryIds, minPrice, maxPrice, inStock };

  if (view === 'buyer') {
    // deleted products are for admin and root only
    if (deleted) throw new ForbiddenError('DELETED_PRODUCTS_FORBIDDEN');
    if (onSale) throw new ForbiddenError('FILTER_FORBIDDEN', { filter: 'onSale' });
    if (popularityOverridden) {
      throw new ForbiddenError('FILTER_FORBIDDEN', { filter: 'popularityOverridden' });
    }
    if (!BUYER_SORTS.includes(sort)) throw new ForbiddenError('SORT_FORBIDDEN', { sort });

    // a buyer sees every product of the catalog, on sale or not
    return { ...base, deleted: false, cursor };
  }

  // only the products of a flag have the field, the list of a flag sorts by it
  const needed = SORT_FLAGS[sort];
  if (needed && !{ deleted, onSale, popularityOverridden }[needed.flag]) {
    throw new BadRequestError(needed.code);
  }

  // without any flag an admin gets the plain products: not deleted, without a sale and without an
  // override that are on. With a flag only its condition counts, the other marks do not filter;
  // the deleted products stay out without their flag
  const anyFlag = deleted || onSale || popularityOverridden;

  return {
    ...base,
    deleted,
    onSale: anyFlag ? onSale || undefined : false,
    popularityOverridden: anyFlag ? popularityOverridden || undefined : false,
    cursor,
  };
}

type SortKind = 'string' | 'date' | 'number';

// the price of the sort and the filters: a buyer pays the price a product sells at now, an admin
// sees the usual price in the field, the sale price has a sort of its own
const priceSqlOf = (view: ProductView) =>
  view === 'admin' ? Prisma.raw(`p."price"`) : CURRENT_PRICE_SQL;

// the expression a sort orders by and the kind of its cursor value; a field only some products
// have is sorted in the list of its flag, where every product has it
function sortExpressionOf(
  sort: ProductsSortField,
  view: ProductView,
): { sql: Prisma.Sql; kind: SortKind } {
  switch (sort) {
    case 'name':
      return { sql: Prisma.raw(`p."name"`), kind: 'string' };
    case 'price':
      return { sql: priceSqlOf(view), kind: 'number' };
    case 'salePrice':
      return { sql: Prisma.raw(`p."salePrice"`), kind: 'number' };
    case 'stock':
      return { sql: FREE_STOCK_SQL, kind: 'number' };
    case 'totalStock':
      return { sql: Prisma.raw(`p."stock"`), kind: 'number' };
    case 'reservedStock':
    case 'popularity':
    case 'views':
    case 'avgRating':
    case 'reviewsCount':
    case 'popularityOverride':
      return { sql: Prisma.raw(`p."${sort}"`), kind: 'number' };
    case 'createdAt':
    case 'updatedAt':
    case 'deletedAt':
    case 'saleEndsAt':
    case 'popularityOverrideUntil':
      return { sql: Prisma.raw(`p."${sort}"`), kind: 'date' };
    default: {
      const _exhaustive: never = sort;
      return _exhaustive;
    }
  }
}

// the cursor of the sort: its value as the kind of the sort wants it, a changed one is a bad request
function cursorValueOf(kind: SortKind, v: unknown): string | number | Date {
  const value = v as string | number | null;
  if (kind === 'string') return cursorString(value);
  if (kind === 'date') return cursorDate(value);
  return cursorNumber(value);
}

// the products on sale first, then the rest by popularity: the sale sort of a buyer
const isBuyerSaleSort = (q: Pick<ProductListQuery, 'view' | 'sort'>) =>
  q.view === 'buyer' && q.sort === 'saleEndsAt';

const sortKeyOf = (q: Pick<ProductListQuery, 'sort' | 'order'>) => `${q.sort}:${q.order}`;

type DecodedCursor = { id: number; v: unknown; g?: unknown };

// a cursor of the same sort and direction; a cursor of another one, or without one, is invalid
function decodeListCursor(q: ProductListQuery): DecodedCursor | undefined {
  if (!q.cursor) return undefined;

  const payload = decodeCursor(q.cursor) as DecodedCursor & { s?: unknown };
  if (payload.s !== sortKeyOf(q)) throw new BadRequestError('CURSOR_INVALID');

  return payload;
}

// build keyset cursor sql for the raw query of ids
function buildCursorSql(q: ProductListQuery): Prisma.Sql {
  const cursor = decodeListCursor(q);
  if (!cursor) return Prisma.empty;

  const op = Prisma.raw(q.order === 'asc' ? '>' : '<');

  // the sale sort of a buyer: after a product on sale come the later ones and every product
  // without a sale; after a product without a sale only the less popular ones
  if (isBuyerSaleSort(q)) {
    if (cursor.g === 1) {
      const endsAt = cursorDate(cursor.v as string);
      return Prisma.sql`
        AND (
          (${SALE_ON_SQL} AND (p."saleEndsAt" ${op} ${endsAt} OR (p."saleEndsAt" = ${endsAt} AND p."id" ${op} ${cursor.id})))
          OR NOT ${SALE_ON_SQL}
        )
      `;
    }
    if (cursor.g === 0) {
      const popularity = cursorNumber(cursor.v as number);
      return Prisma.sql`
        AND (
          NOT ${SALE_ON_SQL} AND (p."popularity" < ${popularity} OR (p."popularity" = ${popularity} AND p."id" < ${cursor.id}))
        )
      `;
    }
    throw new BadRequestError('CURSOR_INVALID');
  }

  const { sql: col, kind } = sortExpressionOf(q.sort, q.view);
  const value = cursorValueOf(kind, cursor.v);

  return Prisma.sql`
    AND (
      ${col} ${op} ${value}
      OR (${col} = ${value} AND p."id" ${op} ${cursor.id})
    )
  `;
}

// the conditions of the filters, joined with AND
function buildWhereSql(q: ProductListQuery): Prisma.Sql {
  const whereParts: Prisma.Sql[] = [];

  // deleted filter, every role
  whereParts.push(
    q.deleted ? Prisma.sql`p."deletedAt" IS NOT NULL` : Prisma.sql`p."deletedAt" IS NULL`,
  );

  // the flags of an admin: only the products with a sale / an override that is on, or only the
  // ones without; undefined does not filter
  if (q.onSale === true) whereParts.push(SALE_ON_SQL);
  if (q.onSale === false) whereParts.push(Prisma.sql`NOT ${SALE_ON_SQL}`);
  if (q.popularityOverridden === true) whereParts.push(OVERRIDE_ON_SQL);
  if (q.popularityOverridden === false) whereParts.push(Prisma.sql`NOT ${OVERRIDE_ON_SQL}`);

  // stock filter by free units, the same number the list shows as stock
  if (q.inStock === true) whereParts.push(Prisma.sql`p."stock" > p."reservedStock"`);
  if (q.inStock === false) whereParts.push(Prisma.sql`p."stock" <= p."reservedStock"`);

  // category filter
  if (q.categoryIds?.length) {
    whereParts.push(Prisma.sql`p."categoryId" IN (${Prisma.join(q.categoryIds)})`);
  }

  // price range: the price a buyer pays now, the usual price for an admin
  const price = priceSqlOf(q.view);
  if (q.minPrice != null) whereParts.push(Prisma.sql`${price} >= ${q.minPrice}`);
  if (q.maxPrice != null) whereParts.push(Prisma.sql`${price} <= ${q.maxPrice}`);

  // the search text is matched literally: % and _ are wildcards of ILIKE and \ is its escape,
  // so each of them gets a \ in front
  const searchText = q.search?.trim().replace(/[\\%_]/g, '\\$&');

  // indexed search by immutable_unaccent(name)
  if (searchText) {
    whereParts.push(
      Prisma.sql`
        cartlify.immutable_unaccent(p."name")
        ILIKE '%' || cartlify.immutable_unaccent(${searchText}) || '%'
      `,
    );
  }

  return Prisma.join(whereParts, ' AND ');
}

// build raw query that returns the ids of a page and the values of their sort, for the cursor; one
// id more than the page tells there is a next page
export function buildProductIdsQuery(q: ProductListQuery): Prisma.Sql {
  const whereSql = buildWhereSql(q);
  const cursorSql = buildCursorSql(q);
  const dir = Prisma.raw(q.order === 'asc' ? 'ASC' : 'DESC');

  // the products on sale first by the end of the sale in the direction asked for, then every
  // other product by popularity, the most popular first
  if (isBuyerSaleSort(q)) {
    return Prisma.sql`
      SELECT p."id" AS id,
             CASE WHEN ${SALE_ON_SQL} THEN 1 ELSE 0 END AS g,
             p."saleEndsAt" AS "endsAt",
             p."popularity" AS popularity
      FROM "products" p
      WHERE ${whereSql}
      ${cursorSql}
      ORDER BY CASE WHEN ${SALE_ON_SQL} THEN 1 ELSE 0 END DESC,
               CASE WHEN ${SALE_ON_SQL} THEN p."saleEndsAt" END ${dir},
               CASE WHEN ${SALE_ON_SQL} THEN p."id" END ${dir},
               p."popularity" DESC, p."id" DESC
      LIMIT ${q.limit + 1}
    `;
  }

  const { sql: col } = sortExpressionOf(q.sort, q.view);

  return Prisma.sql`
    SELECT p."id" AS id, ${col} AS v
    FROM "products" p
    WHERE ${whereSql}
    ${cursorSql}
    ORDER BY ${col} ${dir}, p."id" ${dir}
    LIMIT ${q.limit + 1}
  `;
}

// a row of the raw query: the id and the value of its sort; the sale sort of a buyer gives the part
// (g: 1 on sale, 0 not), the end of the sale and the popularity
export type ProductKeyRow = {
  id: number;
  v?: unknown;
  g?: number;
  endsAt?: Date | null;
  popularity?: number;
};

// a value of the database as a cursor keeps it: a date as iso, a decimal as a number
function cursorValue(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' || typeof v === 'number') return v;
  return decimalToNumber(v);
}

// the cursor of the next page from the last row, with its sort and direction
export function makeNextCursor(
  q: Pick<ProductListQuery, 'view' | 'sort' | 'order'>,
  last: ProductKeyRow,
): string {
  const s = sortKeyOf(q);

  if (isBuyerSaleSort(q)) {
    const g = Number(last.g) === 1 ? 1 : 0;
    const v = g === 1 ? cursorValue(last.endsAt) : cursorValue(last.popularity);
    return encodeCursor({ id: last.id, v, s, g } as never);
  }

  return encodeCursor({ id: last.id, v: cursorValue(last.v), s } as never);
}

// a product of a list: the card fields of every role and the primary image; a buyer gets the
// popularity a list sorts by, an admin every field of an admin
export function mapProductListRowToResponse(
  row: ProductResponseRow & {
    images: Array<{ url: string; position: number; isPrimary: boolean }>;
  },
  view: ProductView,
): ProductResponseDto {
  const primaryUrl = row.images?.[0]?.url;
  if (!primaryUrl) throw new InternalError({ reason: 'PRODUCT_PRIMARY_IMAGE_NOT_FOUND' });

  return {
    ...buyerFieldsOf(row),
    images: buildImageUrls(primaryUrl, 'product'),
    ...(view === 'admin' ? adminFieldsOf(row) : { popularity: row.popularity }),
  };
}
