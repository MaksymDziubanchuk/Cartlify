import { prisma } from '@db/client.js';

import { AppError, BadRequestError, NotFoundError, isAppError } from '@utils/errors.js';

import { toNumberSafe } from '@helpers/safeNormalizer.js';
import { mapReviewRowToResponse, normalizeFindProductByIdInput } from './helpers/index.js';

import type { FindProductReviewsDto, ReviewsResponseDto } from 'types/dto/products.dto.js';

export async function findReviews({
  productId: productIdIn,
  limit: limitIn,
  cursorId: cursorIdIn,
}: FindProductReviewsDto): Promise<ReviewsResponseDto> {
  // normalize and validate ids
  const { productId } = normalizeFindProductByIdInput({ productId: productIdIn });

  const limitRaw = toNumberSafe(limitIn);
  const limit =
    limitRaw != null && Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 10;

  const cursorId = cursorIdIn != null ? toNumberSafe(cursorIdIn) : null;
  if (cursorIdIn != null && (cursorId == null || !Number.isInteger(cursorId) || cursorId <= 0)) {
    throw new BadRequestError('CURSOR_ID_INVALID');
  }

  try {
    // ensure product exists for stable 404
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) throw new NotFoundError('PRODUCT_NOT_FOUND');

    // read page by cursor and total
    const [rows, total] = await prisma.$transaction([
      prisma.review.findMany({
        where: { productId },
        orderBy: { id: 'desc' },
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        take: limit,
        select: {
          id: true,
          productId: true,
          rating: true,
          comment: true,
          userId: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.review.count({ where: { productId } }),
    ]);

    // compute next cursor from last item
    const nextCursorId = rows.length ? rows[rows.length - 1].id : undefined;

    // map db rows into api dto
    return {
      items: rows.map(mapReviewRowToResponse),
      limit,
      total,
      ...(nextCursorId ? { nextCursorId: nextCursorId as any } : {}),
    };
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`products.findReviews: unexpected (${msg})`, 500);
  }
}
