import { AppError } from '@utils/errors.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { buildImageUrls } from '@utils/cloudinary.util.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { assertLimit } from '@helpers/assertLimit.js';

import type {
  ProductsSortField,
  SortOrder,
  FindAllProductsDto,
  ProductResponseDto,
} from 'types/dto/products.dto.js';

export function normalizeFindAllProductsInput(dto: FindAllProductsDto) {
  const limit = assertLimit(dto.limit ?? 20);

  const sort: ProductsSortField = (dto.sort ?? 'popularity') as ProductsSortField;
  const order: SortOrder = dto.order === 'asc' ? 'asc' : 'desc';

  const search =
    typeof dto.search === 'string' && dto.search.trim() ? dto.search.trim() : undefined;

  const categoryIds =
    Array.isArray(dto.categoryIds) && dto.categoryIds.length
      ? dto.categoryIds.filter((n) => Number.isInteger(n) && n > 0)
      : undefined;

  const minPrice = dto.minPrice != null ? Number(dto.minPrice) : undefined;
  const maxPrice = dto.maxPrice != null ? Number(dto.maxPrice) : undefined;

  if (minPrice != null && (!Number.isFinite(minPrice) || minPrice < 0)) {
    throw new AppError('MIN_PRICE_INVALID', 400);
  }
  if (maxPrice != null && (!Number.isFinite(maxPrice) || maxPrice < 0)) {
    throw new AppError('MAX_PRICE_INVALID', 400);
  }
  if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
    throw new AppError('PRICE_RANGE_INVALID', 400);
  }

  const deleted = typeof dto.deleted === 'boolean' ? dto.deleted : undefined;
  const inStock = typeof dto.inStock === 'boolean' ? dto.inStock : undefined;

  const cursor = typeof dto.cursor === 'string' && dto.cursor ? dto.cursor : undefined;

  return { limit, sort, order, search, categoryIds, minPrice, maxPrice, deleted, inStock, cursor };
}

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

export function buildCursorWhere(args: {
  sort: ProductsSortField;
  order: SortOrder;
  cursor?: string | undefined;
}) {
  if (!args.cursor) return undefined;

  const { id, v } = decodeCursor(args.cursor);

  const dir = args.order;
  const op = dir === 'asc' ? 'gt' : 'lt';

  // if sorting by id only (we never do), but keep safe
  if (args.sort === 'name') {
    // v should be string
    return {
      OR: [
        { name: { [op]: String(v ?? '') } },
        { AND: [{ name: String(v ?? '') }, { id: { [op]: id } }] },
      ],
    };
  }

  if (args.sort === 'createdAt' || args.sort === 'updatedAt' || args.sort === 'deletedAt') {
    // v is ISO string or null
    const val = v == null ? null : new Date(String(v));
    return {
      OR: [
        { [args.sort]: { [op]: val } } as any,
        { AND: [{ [args.sort]: val } as any, { id: { [op]: id } }] },
      ],
    };
  }

  // numeric
  const num = v == null ? null : Number(v);
  return {
    OR: [
      { [args.sort]: { [op]: num } } as any,
      { AND: [{ [args.sort]: num } as any, { id: { [op]: id } }] },
    ],
  };
}

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

export function mapProductListRowToResponse(row: {
  id: number;
  name: string;
  description: string | null;
  price: unknown;
  stock: number;
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
  if (!primaryUrl) throw new AppError('PRODUCT_PRIMARY_IMAGE_NOT_FOUND', 500);

  return {
    id: row.id as any,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    price: decimalToNumber(row.price),
    stock: row.stock,
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
