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

// normalize dto for findAll
export function normalizeFindAllProductsInput(dto: FindAllProductsDto) {
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

  // deleted products are for admin and root only, and only on request:
  // without the flag every role gets the products that are not deleted
  const isAdmin = dto.actorRole === 'ADMIN' || dto.actorRole === 'ROOT';
  if (dto.deleted === true && !isAdmin) throw new ForbiddenError('DELETED_PRODUCTS_FORBIDDEN');
  const deleted = dto.deleted === true;

  // only a deleted product has a deletedAt, a list of live products cannot be sorted by it
  if (sort === 'deletedAt' && !deleted) {
    throw new BadRequestError('SORT_DELETED_AT_REQUIRES_DELETED');
  }

  const inStock = typeof dto.inStock === 'boolean' ? dto.inStock : undefined;

  // normalize cursor
  const cursor = typeof dto.cursor === 'string' && dto.cursor ? dto.cursor : undefined;

  return { limit, sort, order, search, categoryIds, minPrice, maxPrice, deleted, inStock, cursor };
}

// build stable orderBy
export function buildOrderBy(sort: ProductsSortField, order: SortOrder) {
  switch (sort) {
    case 'name':
      return [{ name: order }, { id: order }];
    case 'price':
      return [{ price: order }, { id: order }];
    case 'stock':
      return [{ stock: order }, { id: order }];
    case 'popularity':
      return [{ popularity: order }, { id: order }];
    case 'views':
      return [{ views: order }, { id: order }];
    case 'avgRating':
      return [{ avgRating: order }, { id: order }];
    case 'reviewsCount':
      return [{ reviewsCount: order }, { id: order }];
    case 'createdAt':
      return [{ createdAt: order }, { id: order }];
    case 'updatedAt':
      return [{ updatedAt: order }, { id: order }];
    case 'deletedAt':
      return [{ deletedAt: order }, { id: order }];
    default: {
      const _exhaustive: never = sort;
      return _exhaustive;
    }
  }
}

// build keyset cursor where
export function buildCursorWhere(args: {
  sort: ProductsSortField;
  order: SortOrder;
  cursor?: string | undefined;
}) {
  if (!args.cursor) return undefined;

  const { id, v } = decodeCursor(args.cursor);

  const dir = args.order;
  const op = dir === 'asc' ? 'gt' : 'lt';

  // string sort branch
  if (args.sort === 'name') {
    const val = cursorString(v);
    return {
      OR: [{ name: { [op]: val } }, { AND: [{ name: val }, { id: { [op]: id } }] }],
    };
  }

  // date sort branch; a deletedAt sort lists only deleted products, so it has no nulls
  if (args.sort === 'createdAt' || args.sort === 'updatedAt' || args.sort === 'deletedAt') {
    const val = cursorDate(v);
    return {
      OR: [
        { [args.sort]: { [op]: val } } as any,
        { AND: [{ [args.sort]: val } as any, { id: { [op]: id } }] },
      ],
    };
  }

  // numeric sort branch
  const num = cursorNumber(v);
  return {
    OR: [
      { [args.sort]: { [op]: num } } as any,
      { AND: [{ [args.sort]: num } as any, { id: { [op]: id } }] },
    ],
  };
}

// build next cursor from last row
export function makeNextCursor(sort: ProductsSortField, last: any): string {
  let v: string | number | null = null;

  if (sort === 'name') v = last.name ?? '';
  else if (sort === 'createdAt') v = new Date(last.createdAt).toISOString();
  else if (sort === 'updatedAt') v = new Date(last.updatedAt).toISOString();
  else if (sort === 'deletedAt') v = last.deletedAt ? new Date(last.deletedAt).toISOString() : null;
  else if (sort === 'price') v = decimalToNumber(last.price);
  else v = typeof last[sort] === 'number' ? last[sort] : Number(last[sort] ?? 0);

  return encodeCursor({ id: last.id, v });
}

type ProductSearchIdsQueryArgs = {
  limit: number;
  sort: ProductsSortField;
  order: SortOrder;
  search: string;
  categoryIds?: number[];
  minPrice?: number;
  maxPrice?: number;
  deleted?: boolean;
  inStock?: boolean;
  cursor?: string;
};

// map sort field to raw sql column
function getSearchSortColumn(sort: ProductsSortField): Prisma.Sql {
  switch (sort) {
    case 'name':
      return Prisma.raw(`p."name"`);
    case 'price':
      return Prisma.raw(`p."price"`);
    case 'stock':
      return Prisma.raw(`p."stock"`);
    case 'popularity':
      return Prisma.raw(`p."popularity"`);
    case 'views':
      return Prisma.raw(`p."views"`);
    case 'avgRating':
      return Prisma.raw(`p."avgRating"`);
    case 'reviewsCount':
      return Prisma.raw(`p."reviewsCount"`);
    case 'createdAt':
      return Prisma.raw(`p."createdAt"`);
    case 'updatedAt':
      return Prisma.raw(`p."updatedAt"`);
    case 'deletedAt':
      return Prisma.raw(`p."deletedAt"`);
    default: {
      const _exhaustive: never = sort;
      return _exhaustive;
    }
  }
}

// build keyset cursor sql for raw search path
function buildSearchCursorSql(args: {
  sort: ProductsSortField;
  order: SortOrder;
  cursor?: string;
}): Prisma.Sql {
  if (!args.cursor) return Prisma.empty;

  const { id, v } = decodeCursor(args.cursor);
  const col = getSearchSortColumn(args.sort);
  const op = Prisma.raw(args.order === 'asc' ? '>' : '<');

  // string cursor branch
  if (args.sort === 'name') {
    const value = cursorString(v);

    return Prisma.sql`
      AND (
        ${col} ${op} ${value}
        OR (${col} = ${value} AND p."id" ${op} ${id})
      )
    `;
  }

  // date cursor branch; a deletedAt sort lists only deleted products, so it has no nulls
  if (args.sort === 'createdAt' || args.sort === 'updatedAt' || args.sort === 'deletedAt') {
    const value = cursorDate(v);

    return Prisma.sql`
      AND (
        ${col} ${op} ${value}
        OR (${col} = ${value} AND p."id" ${op} ${id})
      )
    `;
  }

  // numeric cursor branch
  const value = cursorNumber(v);

  return Prisma.sql`
    AND (
      ${col} ${op} ${value}
      OR (${col} = ${value} AND p."id" ${op} ${id})
    )
  `;
}

// build raw query that returns only product ids for search
export function buildProductSearchIdsQuery(args: ProductSearchIdsQueryArgs): Prisma.Sql {
  if (!args.search.trim()) throw new BadRequestError('SEARCH_REQUIRED');

  const whereParts: Prisma.Sql[] = [];

  // deleted filter
  if (args.deleted === true) whereParts.push(Prisma.sql`p."deletedAt" IS NOT NULL`);
  if (args.deleted === false) whereParts.push(Prisma.sql`p."deletedAt" IS NULL`);

  // stock filter by free units, the same number the list shows as stock
  if (args.inStock === true) whereParts.push(Prisma.sql`p."stock" > p."reservedStock"`);
  if (args.inStock === false) whereParts.push(Prisma.sql`p."stock" <= p."reservedStock"`);

  // category filter
  if (args.categoryIds?.length) {
    whereParts.push(Prisma.sql`p."categoryId" IN (${Prisma.join(args.categoryIds)})`);
  }

  // min price filter
  if (args.minPrice != null) {
    whereParts.push(Prisma.sql`p."price" >= ${args.minPrice}`);
  }

  // max price filter
  if (args.maxPrice != null) {
    whereParts.push(Prisma.sql`p."price" <= ${args.maxPrice}`);
  }

  // the search text is matched literally: % and _ are wildcards of ILIKE and \ is its escape,
  // so each of them gets a \ in front
  const searchText = args.search.trim().replace(/[\\%_]/g, '\\$&');

  // indexed search by immutable_unaccent(name)
  whereParts.push(
    Prisma.sql`
      cartlify.immutable_unaccent(p."name")
      ILIKE '%' || cartlify.immutable_unaccent(${searchText}) || '%'
    `,
  );

  const whereSql = whereParts.length ? Prisma.join(whereParts, ' AND ') : Prisma.sql`TRUE`;
  const sortCol = getSearchSortColumn(args.sort);
  const dir = Prisma.raw(args.order === 'asc' ? 'ASC' : 'DESC');

  const orderBySql = Prisma.sql`
    ORDER BY ${sortCol} ${dir}, p."id" ${dir}
  `;

  return Prisma.sql`
    SELECT p."id" AS id
    FROM "products" p
    WHERE ${whereSql}
    ${buildSearchCursorSql({
      sort: args.sort,
      order: args.order,
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
    })}
    ${orderBySql} 
    LIMIT ${args.limit + 1}
  `;
}

// map db row to response dto
export function mapProductListRowToResponse(row: {
  id: number;
  name: string;
  description: string | null;
  price: unknown;
  stock: number;
  reservedStock: number;
  categoryId: number;
  views: number;
  popularity: number;
  avgRating: unknown;
  reviewsCount: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  images: Array<{ url: string; position: number; isPrimary: boolean }>;
}): ProductResponseDto {
  const primaryUrl = row.images?.[0]?.url;
  if (!primaryUrl) throw new InternalError({ reason: 'PRODUCT_PRIMARY_IMAGE_NOT_FOUND' });

  // hide reserved units from public stock, never below zero, the same as the product card shows it
  const realStock = Math.max(0, row.stock - row.reservedStock);

  return {
    id: row.id as any,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    price: decimalToNumber(row.price),
    stock: realStock,
    categoryId: row.categoryId as any,
    images: buildImageUrls(primaryUrl, 'product'),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    popularity: row.popularity,
    views: row.views,
    avgRating: decimalToNumber(row.avgRating),
    reviewsCount: row.reviewsCount,
    ...(row.deletedAt ? { deletedAt: row.deletedAt.toISOString() } : {}),
  };
}
