import { describe, expect, it } from '@jest/globals';

import {
  mapReviewRowToResponse,
  normalizeCreateReviewInput,
  normalizeDeleteReviewInput,
} from '@routes/api/products/services/helpers/reviews.helpers.js';
import { BadRequestError, ForbiddenError } from '@utils/errors.js';

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

  it('rejects an invalid review id', () => {
    expect(thrownBy(() => normalizeDeleteReviewInput({ ...base, reviewId: 'x' }))).toMatchObject({
      errorCode: 'REVIEW_ID_INVALID',
    });
  });

  it.each([0, 'x', null])('forbids a delete with the actor id %p', (actorId) => {
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
    expect(mapReviewRowToResponse(row, author).user).toMatchObject({
      id: 8,
      name: 'Anna',
      avatarIsDefault: true,
      deleted: false,
      avatarUrls: { url32: expect.stringContaining('/l_text:Roboto_16_bold:A,co_white/') },
    });
  });

  it('counts missing votes as zero', () => {
    expect(mapReviewRowToResponse(row, author)).toMatchObject({ upVotes: 0, downVotes: 0 });
  });

  it('leaves out an empty rating and comment', () => {
    const out = mapReviewRowToResponse({ ...row, rating: null, comment: null }, author);

    expect(out).not.toHaveProperty('rating');
    expect(out).not.toHaveProperty('comment');
  });

  it('keeps the vote of the viewer, including no vote', () => {
    expect(mapReviewRowToResponse({ ...row, userVote: 'down' }, author).userVote).toBe('down');
    expect(mapReviewRowToResponse({ ...row, userVote: null }, author)).toHaveProperty(
      'userVote',
      null,
    );
    expect(mapReviewRowToResponse(row, author)).not.toHaveProperty('userVote');
  });
});
