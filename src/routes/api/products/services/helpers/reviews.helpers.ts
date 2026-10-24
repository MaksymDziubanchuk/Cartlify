import { Prisma } from '@prisma/client';

import { BadRequestError, ForbiddenError } from '@utils/errors.js';

import { toNumberSafe, toStringSafe } from '@helpers/safeNormalizer.js';
import { avatarOf } from '@utils/avatar.util.js';
import { normalizeFindProductByIdInput } from './index.js';

import type {
  CreateReviewDto,
  ReviewAuthorDto,
  ReviewResponseDto,
} from 'types/dto/products.dto.js';
import type { Role } from 'types/user.js';

export function normalizeCreateReviewInput(dto: CreateReviewDto) {
  // normalize ids
  const { productId: productIdRaw } = normalizeFindProductByIdInput({ productId: dto.productId });

  const userIdRaw = toNumberSafe(dto.userId);
  if (userIdRaw == null || !Number.isInteger(userIdRaw) || userIdRaw <= 0) {
    throw new BadRequestError('USER_ID_INVALID');
  }

  // normalize optional rating, a review may be only a comment
  let ratingNorm: number | undefined;
  if (dto.rating != null) {
    const ratingRaw = toNumberSafe(dto.rating);
    if (ratingRaw == null || !Number.isInteger(ratingRaw) || ratingRaw < 1 || ratingRaw > 5) {
      throw new BadRequestError('RATING_INVALID');
    }
    ratingNorm = ratingRaw;
  }

  // normalize optional comment, a comment of spaces counts as no comment
  const commentRaw = dto.comment != null ? toStringSafe(dto.comment) : undefined;
  const commentNorm = typeof commentRaw === 'string' ? commentRaw.trim() || undefined : undefined;

  // the request schema needs a rating or a comment,
  // so this only catches a comment of spaces sent without a rating
  if (ratingNorm === undefined && !commentNorm) {
    throw new BadRequestError('REVIEW_PAYLOAD_EMPTY');
  }

  // normalize role for rls context
  const actorRole = dto.actorRole ?? 'USER';

  return {
    productId: productIdRaw,
    userId: userIdRaw,
    actorRole,
    ...(ratingNorm !== undefined ? { rating: ratingNorm } : {}),
    ...(commentNorm ? { comment: commentNorm } : {}),
  };
}

export function normalizeDeleteReviewInput(dto: {
  productId: unknown;
  reviewId: unknown;
  actorId: unknown;
  actorRole: Role;
}) {
  // normalize ids for db
  const { productId } = normalizeFindProductByIdInput({ productId: dto.productId });

  const reviewId = toNumberSafe(dto.reviewId);
  if (reviewId == null || !Number.isInteger(reviewId) || reviewId <= 0) {
    throw new BadRequestError('REVIEW_ID_INVALID');
  }

  const actorId = toNumberSafe(dto.actorId);
  if (actorId == null || !Number.isInteger(actorId) || actorId <= 0) {
    throw new ForbiddenError('ACTOR_ID_INVALID');
  }

  // an author deletes own reviews, an admin any review; the service checks the author
  if (dto.actorRole !== 'USER' && dto.actorRole !== 'ADMIN' && dto.actorRole !== 'ROOT') {
    throw new ForbiddenError('INSUFFICIENT_ROLE');
  }

  return { productId, reviewId, actorId, actorRole: dto.actorRole };
}

// what a review reads about its author
export const reviewAuthorSelect = {
  id: true,
  name: true,
  email: true,
  avatarUrl: true,
  deletedAt: true,
} as const;

export type ReviewAuthorRow = {
  id: number;
  name: string | null;
  email: string;
  avatarUrl: string | null;
  deletedAt: Date | null;
};

export function mapReviewAuthor(author: ReviewAuthorRow): ReviewAuthorDto {
  return {
    id: author.id as any,
    ...(author.name ? { name: author.name } : {}),
    ...avatarOf({ ...author, deleted: author.deletedAt !== null }),
    deleted: author.deletedAt !== null,
  };
}

export function mapReviewRowToResponse(
  row: {
    id: number;
    productId: number;
    rating: number | null;
    comment: string | null;
    userId: number;
    createdAt: Date;
    updatedAt: Date;

    upVotes?: number;
    downVotes?: number;
    userVote?: 'up' | 'down' | null;
  },
  author: ReviewAuthorRow,
  // the author bought the product (buyersOf)
  verifiedPurchase: boolean,
): ReviewResponseDto {
  // map db row to api dto
  return {
    id: row.id as any,
    productId: row.productId as any,
    ...(row.rating != null ? { rating: row.rating } : {}),
    userId: row.userId as any,
    user: mapReviewAuthor(author),
    ...(row.comment ? { comment: row.comment } : {}),
    verifiedPurchase,
    upVotes: row.upVotes ?? 0,
    downVotes: row.downVotes ?? 0,
    ...(row.userVote !== undefined ? { userVote: row.userVote } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// the authors who bought the product: a paid order of it, shipped or delivered too; a cancelled
// one gave the money back. No field in the database, read for the page. The caller sees the orders
// of the authors (the system, or the author of their own)
export async function buyersOf(
  tx: Prisma.TransactionClient,
  productId: number,
  userIds: number[],
): Promise<Set<number>> {
  if (!userIds.length) return new Set();

  const rows = await tx.$queryRaw<{ userId: number }[]>`
    select distinct o."userId"
    from cartlify.orders o
    join cartlify.order_items i on i."orderId" = o.id
    where i."productId" = ${productId}::int
      and o."userId" = any(${userIds}::int[])
      and o.status in ('paid', 'shipped', 'delivered')
  `;
  return new Set(rows.map((row) => row.userId));
}

// the orders of the reviews of a product: the newest first (the default), the most helpful (the
// most votes up), the rating high or low; a review without a rating comes last, the newest first
// among the same values
export const REVIEW_SORTS = ['newest', 'helpful', 'ratingHigh', 'ratingLow'] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];

// the cursor of a page: the last review, the product and the sort it is of, and its value
export type ReviewCursor = { id: number; v: number; s: ReviewSort; k: number | null };

export function reviewOrderOf(sort: ReviewSort): Prisma.ReviewOrderByWithRelationInput[] {
  switch (sort) {
    case 'helpful':
      return [{ upVotes: 'desc' }, { id: 'desc' }];
    case 'ratingHigh':
      return [{ rating: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }];
    case 'ratingLow':
      return [{ rating: { sort: 'asc', nulls: 'last' } }, { id: 'desc' }];
    default:
      return [{ id: 'desc' }];
  }
}

// the reviews after the last one of the page in the order of the sort
export function reviewsAfter(cursor: ReviewCursor): Prisma.ReviewWhereInput {
  const older = { id: { lt: cursor.id } };

  switch (cursor.s) {
    case 'helpful': {
      const k = cursor.k ?? 0;
      return { OR: [{ upVotes: { lt: k } }, { upVotes: k, ...older }] };
    }
    case 'ratingHigh':
    case 'ratingLow': {
      // the reviews without a rating come last: after one of them only the older of them
      if (cursor.k === null) return { rating: null, ...older };
      const further = cursor.s === 'ratingHigh' ? { lt: cursor.k } : { gt: cursor.k };
      return { OR: [{ rating: further }, { rating: cursor.k, ...older }, { rating: null }] };
    }
    default:
      return older;
  }
}

// the value of a review its sort orders by, the one the cursor keeps
export function reviewSortValueOf(
  sort: ReviewSort,
  row: { rating: number | null; upVotes: number },
): number | null {
  if (sort === 'helpful') return row.upVotes;
  if (sort === 'ratingHigh' || sort === 'ratingLow') return row.rating;
  return null;
}

// a cursor of this product and this sort; one of another product or sort, or changed, is invalid.
// A cursor without a sort is one of the newest first, the only order there was before
export function readReviewCursor(
  payload: Record<string, unknown>,
  productId: number,
  sort: ReviewSort,
): ReviewCursor {
  const v = typeof payload.v === 'number' ? payload.v : Number(payload.v);
  const s = payload.s ?? 'newest';
  const k = payload.k ?? null;
  const id = Number(payload.id);

  if (!Number.isInteger(v) || v !== productId || s !== sort)
    throw new BadRequestError('CURSOR_INVALID');
  if (!Number.isInteger(id) || id <= 0) throw new BadRequestError('CURSOR_INVALID');
  if (k !== null && (typeof k !== 'number' || !Number.isInteger(k) || k < 0)) {
    throw new BadRequestError('CURSOR_INVALID');
  }

  return { id, v, s: sort, k: k as number | null };
}
