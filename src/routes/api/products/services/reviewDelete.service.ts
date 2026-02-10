import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import { AppError, NotFoundError, isAppError } from '@utils/errors.js';

import { writeAdminAuditLog, normalizeDeleteReviewInput } from './helpers/index.js';

import type {
  DeleteProductReviewDto,
  DeleteProductReviewResponseDto,
} from 'types/dto/products.dto.js';

export async function deleteProductReview(
  dto: DeleteProductReviewDto,
): Promise<DeleteProductReviewResponseDto> {
  const { productId, reviewId, actorId, actorRole } = normalizeDeleteReviewInput(dto);

  try {
    await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setUserContext(tx, { userId: actorId, role: actorRole });

      // load review with product id for stable 404 and mismatch check
      const review = await tx.review.findUnique({
        where: { id: reviewId },
        select: { id: true, productId: true, userId: true, rating: true, comment: true },
      });
      if (!review) throw new NotFoundError('REVIEW_NOT_FOUND');

      // prevent deleting review from a different product route
      if (review.productId !== productId) throw new NotFoundError('REVIEW_NOT_FOUND');

      // delete review row
      await tx.review.delete({ where: { id: reviewId } });

      // write admin audit log for review delete
      await writeAdminAuditLog(tx, {
        actorId: actorId as any,
        actorRole,
        entityType: 'review',
        entityId: reviewId,
        action: 'REVIEW_DELETE',
        changes: [
          { field: 'productId', old: review.productId, new: null },
          { field: 'userId', old: review.userId, new: null },
          { field: 'rating', old: review.rating, new: null },
          { field: 'comment', old: review.comment, new: null },
        ],
      });
    });

    return { message: 'REVIEW_DELETED' };
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`products.deleteProductReview: unexpected (${msg})`, 500);
  }
}
