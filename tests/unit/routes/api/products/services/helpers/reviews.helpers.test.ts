import { describe, expect, it } from '@jest/globals';

import {
  mapReviewRowToResponse,
  normalizeCreateReviewInput,
  normalizeDeleteReviewInput,
  readReviewCursor,
  reviewOrderOf,
  reviewSortValueOf,
  reviewsAfter,
} from '@routes/api/products/services/helpers/reviews.helpers.js';
import { BadRequestError, ForbiddenError } from '@utils/errors.js';

import { drawnAvatar } from '../../../../../../helpers/avatar.js';
import { thrownBy } from '../../../../../../helpers/errors.js';

import type { CreateReviewDto } from 'types/dto/products.dto.js';

const review = (patch: Record<string, unknown>) =>
  ({ productId: 3, userId: 8, actorRole: 'USER', ...patch }) as unknown as CreateReviewDto;

describe('normalizeCreateReviewInput', () => {
  it('accepts a rating with a trimmed comment', () => {
    expect(normalizeCreateReviewInput(review({ rating: 5, comment: '  Great lamp ' }))).toEqual({
      productId: 3,
      userId: 8,
      rating: 5,
      actorRole: 'USER',
      comment: 'Great lamp',
    });
  });

  it('accepts a rating alone', () => {
    expect(normalizeCreateReviewInput(review({ rating: 1 }))).toEqual({
      productId: 3,
      userId: 8,
      rating: 1,
      actorRole: 'USER',
    });
  });

  // the request schema and the database both allow a review without a rating
  it('accepts a comment without a rating', () => {
    expect(normalizeCreateReviewInput(review({ comment: 'Arrived fast' }))).toEqual({
      productId: 3,
      userId: 8,
      actorRole: 'USER',
      comment: 'Arrived fast',
    });
  });

  it('treats a comment of spaces next to a rating as a rating-only review', () => {
    const out = normalizeCreateReviewInput(review({ rating: 4, comment: '   ' }));

    expect(out).toMatchObject({ rating: 4 });
    expect(out).not.toHaveProperty('comment');
  });

  // the schema already needs a rating or a comment, only a comment of spaces gets this far
  it('rejects a comment of spaces sent without a rating', () => {
    const err = thrownBy(() => normalizeCreateReviewInput(review({ comment: '   ' })));

    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ errorCode: 'REVIEW_PAYLOAD_EMPTY' });
  });

  it.each([0, 6, 3.5, 'five'])('rejects the rating %p', (rating) => {
    expect(thrownBy(() => normalizeCreateReviewInput(review({ rating })))).toMatchObject({
      errorCode: 'RATING_INVALID',
    });
  });

  it('keeps the role of the writer, a user when none is named', () => {
    expect(normalizeCreateReviewInput(review({ rating: 3, actorRole: 'ADMIN' })).actorRole).toBe(
      'ADMIN',
    );
    expect(normalizeCreateReviewInput(review({ rating: 3, actorRole: undefined })).actorRole).toBe(
      'USER',
    );
  });

  it('leaves out the rating of a review that has only a comment', () => {
    expect(normalizeCreateReviewInput(review({ comment: 'Fine' }))).not.toHaveProperty('rating');
  });

  it.each([0, -3, 2.5, 'guest'])('rejects the user id %p', (userId) => {
    expect(thrownBy(() => normalizeCreateReviewInput(review({ rating: 4, userId })))).toMatchObject(
      { errorCode: 'USER_ID_INVALID' },
    );
  });

  it('rejects an invalid product or user id', () => {
    expect(
      thrownBy(() => normalizeCreateReviewInput(review({ rating: 4, productId: 0 }))),
    ).toMatchObject({
      errorCode: 'PRODUCT_ID_INVALID',
    });
    expect(
      thrownBy(() => normalizeCreateReviewInput(review({ rating: 4, userId: 'guest' }))),
    ).toMatchObject({
      errorCode: 'USER_ID_INVALID',
    });
  });
});

describe('normalizeDeleteReviewInput', () => {
  const base = { productId: 3, reviewId: 12, actorId: 1, actorRole: 'ADMIN' as const };

  it('lets an admin or root delete', () => {
    expect(normalizeDeleteReviewInput(base)).toEqual(base);
    expect(normalizeDeleteReviewInput({ ...base, actorRole: 'ROOT' }).actorRole).toBe('ROOT');
  });

  // an author may delete own review, the service checks that the review is theirs
  it('lets a user through', () => {
    expect(normalizeDeleteReviewInput({ ...base, actorRole: 'USER' }).actorRole).toBe('USER');
  });

  it('forbids a guest', () => {
    const err = thrownBy(() => normalizeDeleteReviewInput({ ...base, actorRole: 'GUEST' }));

    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it.each(['x', 0, -2, 1.5])('rejects the review id %p', (reviewId) => {
    expect(thrownBy(() => normalizeDeleteReviewInput({ ...base, reviewId }))).toMatchObject({
      errorCode: 'REVIEW_ID_INVALID',
    });
  });

  it.each([0, 'x', null, 1.5])('forbids a delete with the actor id %p', (actorId) => {
    const err = thrownBy(() => normalizeDeleteReviewInput({ ...base, actorId }));

    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).toMatchObject({ errorCode: 'ACTOR_ID_INVALID' });
  });
});

describe('mapReviewRowToResponse', () => {
  const row = {
    id: 1,
    productId: 3,
    rating: 4,
    comment: 'ok',
    userId: 8,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  };

  // every review comes with its author
  const author = {
    id: 8,
    name: 'Anna',
    email: 'anna@example.com',
    avatarUrl: null,
    deletedAt: null,
  };

  // an author without a picture gets the drawn letter, the way every account does
  it('gives the author with the drawn letter of the name', () => {
    expect(mapReviewRowToResponse(row, author, false).user).toMatchObject({
      id: 8,
      name: 'Anna',
      avatarIsDefault: true,
      deleted: false,
      avatarUrls: { url32: expect.stringContaining('/l_text:Roboto_16_bold:A,co_white/') },
    });
  });

  // nothing of it is kept: the service reads whether the author bought the product
  it('names whether the author bought the product', () => {
    expect(mapReviewRowToResponse(row, author, true)).toMatchObject({ verifiedPurchase: true });
    expect(mapReviewRowToResponse(row, author, false)).toMatchObject({ verifiedPurchase: false });
  });

  // the account of a deleted author keeps its reviews, under Guest and a grey G
  it('names a deleted author with the drawn letter of a deleted account', () => {
    const user = mapReviewRowToResponse(
      row,
      { ...author, name: 'Guest', deletedAt: new Date('2026-02-01T00:00:00Z') },
      false,
    ).user;

    // a live account named Guest gets a letter of its colour, the deleted one the grey of deleted
    const alive = mapReviewRowToResponse(row, { ...author, name: 'Guest' }, false).user;
    const drawn = drawnAvatar(user.avatarUrls.url32);

    expect(user).toMatchObject({ deleted: true, avatarIsDefault: true });
    expect(drawn?.letter).toBe('G');
    expect(drawn?.color).not.toBe(drawnAvatar(alive.avatarUrls.url32)?.color);
  });

  it('gives the rating and the comment a review has', () => {
    expect(mapReviewRowToResponse(row, author, false)).toMatchObject({ rating: 4, comment: 'ok' });
    expect(mapReviewRowToResponse({ ...row, rating: 1 }, author, false).rating).toBe(1);
  });

  it('counts missing votes as zero', () => {
    expect(mapReviewRowToResponse(row, author, false)).toMatchObject({ upVotes: 0, downVotes: 0 });
  });

  it('leaves out an empty rating and comment', () => {
    const out = mapReviewRowToResponse({ ...row, rating: null, comment: null }, author, false);

    expect(out).not.toHaveProperty('rating');
    expect(out).not.toHaveProperty('comment');
  });

  it('keeps the vote of the viewer, including no vote', () => {
    expect(mapReviewRowToResponse({ ...row, userVote: 'down' }, author, false).userVote).toBe(
      'down',
    );
    expect(mapReviewRowToResponse({ ...row, userVote: null }, author, false)).toHaveProperty(
      'userVote',
      null,
    );
    expect(mapReviewRowToResponse(row, author, false)).not.toHaveProperty('userVote');
  });
});

// the reviews of a product page by page in the order of a sort: the cursor keeps the last review,
// the product, the sort and the value it orders by
describe('the sorts of the reviews', () => {
  it.each([
    ['newest', [{ id: 'desc' }]],
    ['helpful', [{ upVotes: 'desc' }, { id: 'desc' }]],
    ['ratingHigh', [{ rating: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }]],
    ['ratingLow', [{ rating: { sort: 'asc', nulls: 'last' } }, { id: 'desc' }]],
  ] as const)('orders %s', (sort, order) => {
    expect(reviewOrderOf(sort)).toEqual(order);
  });

  it('goes on after the last review of the page in the order of its sort', () => {
    expect(reviewsAfter({ id: 9, v: 3, s: 'newest', k: null })).toEqual({ id: { lt: 9 } });
    expect(reviewsAfter({ id: 9, v: 3, s: 'helpful', k: 2 })).toEqual({
      OR: [{ upVotes: { lt: 2 } }, { upVotes: 2, id: { lt: 9 } }],
    });
    expect(reviewsAfter({ id: 9, v: 3, s: 'ratingLow', k: 4 })).toEqual({
      OR: [{ rating: { gt: 4 } }, { rating: 4, id: { lt: 9 } }, { rating: null }],
    });
    expect(reviewsAfter({ id: 9, v: 3, s: 'ratingHigh', k: 4 })).toEqual({
      OR: [{ rating: { lt: 4 } }, { rating: 4, id: { lt: 9 } }, { rating: null }],
    });
    // after a review without a rating only the older of them
    expect(reviewsAfter({ id: 9, v: 3, s: 'ratingHigh', k: null })).toEqual({
      rating: null,
      id: { lt: 9 },
    });
  });

  it('keeps the value a review is ordered by', () => {
    expect(reviewSortValueOf('helpful', { rating: 4, upVotes: 6 })).toBe(6);
    expect(reviewSortValueOf('ratingHigh', { rating: null, upVotes: 6 })).toBeNull();
    expect(reviewSortValueOf('ratingHigh', { rating: 5, upVotes: 6 })).toBe(5);
    expect(reviewSortValueOf('ratingLow', { rating: 2, upVotes: 6 })).toBe(2);
    expect(reviewSortValueOf('newest', { rating: 4, upVotes: 6 })).toBeNull();
  });

  it('reads a cursor of the product and the sort, an old one of the newest too', () => {
    expect(readReviewCursor({ id: 9, v: 3, s: 'helpful', k: 2 }, 3, 'helpful')).toEqual({
      id: 9,
      v: 3,
      s: 'helpful',
      k: 2,
    });
    expect(readReviewCursor({ id: 9, v: 3 }, 3, 'newest')).toMatchObject({ s: 'newest', k: null });
  });

  // a cursor coded as text keeps its numbers as text
  it('reads the product of a cursor written as text, and a value of 0', () => {
    expect(readReviewCursor({ id: '9', v: '3', s: 'helpful', k: 0 }, 3, 'helpful')).toEqual({
      id: 9,
      v: 3,
      s: 'helpful',
      k: 0,
    });
  });

  it.each([
    ['another product', { id: 9, v: 4, s: 'newest' }],
    ['another product of the same sort', { id: 9, v: 4, s: 'helpful', k: 1 }],
    ['a value below 0', { id: 9, v: 3, s: 'helpful', k: -1 }],
    ['a value written as text', { id: 9, v: 3, s: 'helpful', k: '2' }],
    ['another sort', { id: 9, v: 3, s: 'ratingLow', k: 2 }],
    ['a value that is not a whole number', { id: 9, v: 3, s: 'helpful', k: 1.5 }],
    ['an id that is not one', { id: 0, v: 3, s: 'helpful', k: 1 }],
  ])('refuses a cursor of %s', (_case, payload) => {
    expect(thrownBy(() => readReviewCursor(payload, 3, 'helpful'))).toMatchObject({
      errorCode: 'CURSOR_INVALID',
    });
  });
});
