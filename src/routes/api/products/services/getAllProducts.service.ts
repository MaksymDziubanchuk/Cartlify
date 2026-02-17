import { prisma } from '@db/client.js';

import {
  mapProductListRowToResponse,
  normalizeFindAllProductsInput,
  buildCursorWhere,
  buildOrderBy,
  makeNextCursor,
} from './helpers/index.js';
import { AppError, isAppError } from '@utils/errors.js';

import type { FindAllProductsDto, ProductsResponseDto } from 'types/dto/products.dto.js';

export async function findAll(dto: FindAllProductsDto): Promise<ProductsResponseDto> {
  const { limit, sort, order, search, categoryIds, minPrice, maxPrice, deleted, inStock, cursor } =
    normalizeFindAllProductsInput(dto);

  try {
    const where: any = {};

    // deleted filter
    if (deleted === true) where.deletedAt = { not: null };
    if (deleted === false) where.deletedAt = null;

    // stock filter
    if (inStock === true) where.stock = { gt: 0 };
    if (inStock === false) where.stock = 0;

    // category filter
    if (categoryIds?.length) where.categoryId = { in: categoryIds };

    // price range
    if (minPrice != null || maxPrice != null) {
      where.price = {
        ...(minPrice != null ? { gte: minPrice } : {}),
        ...(maxPrice != null ? { lte: maxPrice } : {}),
      };
    }

    // search (simple contains; later можна замінити на raw + immutable_unaccent + trigram)
    if (search) {
      where.name = { contains: search, mode: 'insensitive' };
    }

    const cursorWhere = buildCursorWhere({ sort, order, cursor });
    const finalWhere = cursorWhere ? { AND: [where, cursorWhere] } : where;

    const rows = await prisma.product.findMany({
      where: finalWhere,
      orderBy: buildOrderBy(sort, order) as any,
      take: limit + 1, // fetch one extra to know if next page exists
      select: {
        id: true,
        name: true,
        description: true,
        price: true,
        stock: true,
        categoryId: true,
        views: true,
        popularity: true,
        avgRating: true,
        reviewsCount: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        images: {
          where: { isPrimary: true },
          select: { url: true, position: true, isPrimary: true },
          orderBy: { position: 'asc' },
          take: 1,
        },
      },
    });

    const hasNext = rows.length > limit;
    const pageRows = hasNext ? rows.slice(0, limit) : rows;

    const items = pageRows.map(mapProductListRowToResponse);

    return {
      items,
      limit,
      ...(hasNext ? { nextCursor: makeNextCursor(sort, pageRows[pageRows.length - 1]) } : {}),
    };
  } catch (err) {
    if (isAppError(err)) throw err;

    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`products.findAll: unexpected (${msg})`, 500);
  }
}
