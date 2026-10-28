import env from '@config/env.js';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';

import { ForbiddenError, InternalError, NotFoundError, isAppError } from '@utils/errors.js';

import {
  countReviewRemovals,
  normalizeDeleteReviewInput,
  sendReviewRemovedEmail,
} from './helpers/index.js';

import type {
  DeleteProductReviewDto,
  DeleteProductReviewResponseDto,
} from 'types/dto/products.dto.js';

// an author deletes an own review, an admin or root any review. A removal by a moderator goes to
// the journal of the admins and counts there against the author; after the commit the author gets
// a mail with the count. The answer tells the moderator how many removals the author has against
// the limit: past it the page asks to take the account to root
export async function deleteProductReview(
  dto: DeleteProductReviewDto,
): Promise<DeleteProductReviewResponseDto> {
  const { productId, reviewId, actorId, actorRole } = normalizeDeleteReviewInput(dto);
  const limit = env.REVIEW_REMOVALS_LIMIT;

  let removal: {
    removals: number;
    authorId: number;
    mailTo: string | null;
    userName: string | null;
    productName: string;
  } | null;

  try {
    removal = await prisma.$transaction(async (tx) => {
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

      // an author deletes only own reviews, an admin any review, the same rule as the db policy
      const isAdmin = actorRole === 'ADMIN' || actorRole === 'ROOT';
      if (!isAdmin && review.userId !== actorId) {
        throw new ForbiddenError('REVIEW_DELETE_FORBIDDEN');
      }

      // the delete waits for a delete of the same review at once and then finds no row: of two
      // moderators only one writes the line, counts and mails
      const { count } = await tx.review.deleteMany({ where: { id: reviewId } });
      if (count === 0) throw new NotFoundError('REVIEW_NOT_FOUND');

      // the admin audit log keeps admin actions only, an author deleting own review is not one
      if (!isAdmin) return null;

      // write admin audit log for review delete
      await writeAdminAuditLog(tx, {
        actorId: actorId as any,
        actorRole,
        entityType: 'review',
        entityId: reviewId,
        action: 'REVIEW_DELETE',
        event: 'review.delete',
        changes: [
          { field: 'productId', old: review.productId, new: null },
          { field: 'userId', old: review.userId, new: null },
          { field: 'rating', old: review.rating, new: null },
          { field: 'comment', old: review.comment, new: null },
        ],
      });

      // who gets the mail and of which product; an admin reads both, a removed product too
      const author = await tx.user.findUnique({
        where: { id: review.userId },
        select: { email: true, name: true, deletedAt: true },
      });
      const product = await tx.product.findUniqueOrThrow({
        where: { id: review.productId },
        select: { name: true },
      });

      return {
        removals: await countReviewRemovals(tx, review.userId),
        authorId: review.userId,
        // a deleted account has no address to write to
        mailTo: author && !author.deletedAt ? author.email : null,
        userName: author?.name ?? null,
        productName: product.name,
      };
    });
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PRODUCTS_DELETE_REVIEW_UNEXPECTED' }, err);
  }

  if (!removal) return { message: 'REVIEW_DELETED' };

  if (removal.mailTo) {
    await sendReviewRemovedEmail(
      {
        userId: removal.authorId,
        to: removal.mailTo,
        userName: removal.userName,
        productName: removal.productName,
        removals: removal.removals,
        limit,
      },
      dto.log,
    );
  }

  return {
    message: 'REVIEW_DELETED',
    reviewRemovals: removal.removals,
    reviewRemovalsLimit: limit,
  };
}
