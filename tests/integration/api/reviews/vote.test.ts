import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createReview,
  createReviewVote,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';

// POST /api/reviews/:reviewId/vote: a user votes for a review of a product, up or down, or takes
// the vote back. The answer carries the counts of every vote of the review, while the database
// shows the voter only an own vote

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];

const newUser = async () => {
  const user = await createUser();
  userIds.push(user.id);
  return user;
};

// a review with the given number of up and down votes of other users
async function reviewWithVotes(votes: { up: number; down: number }): Promise<number> {
  const product = await createProduct();
  const { id } = await createReview((await newUser()).id, product.id);

  for (let i = 0; i < votes.up; i++) await createReviewVote((await newUser()).id, id, 'UP');
  for (let i = 0; i < votes.down; i++) await createReviewVote((await newUser()).id, id, 'DOWN');

  return id;
}

const vote = (user: TestUser, reviewId: number, action: 'up' | 'down' | 'remove') =>
  app.inject({
    method: 'POST',
    url: `/api/reviews/${reviewId}/vote`,
    headers: withCsrf(csrf, accessCookie(user)),
    payload: { action },
  });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('POST /api/reviews/:reviewId/vote', () => {
  it('answers with the counts of every vote, not only of the voter', async () => {
    const reviewId = await reviewWithVotes({ up: 2, down: 1 });

    const res = await vote(await newUser(), reviewId, 'up');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: reviewId, upVotes: 3, downVotes: 1, userVote: 'up' });
  });

  it('answers with the counts after the vote changes and after it is taken back', async () => {
    const reviewId = await reviewWithVotes({ up: 1, down: 0 });
    const voter = await newUser();

    await vote(voter, reviewId, 'up');
    const changed = await vote(voter, reviewId, 'down');
    const removed = await vote(voter, reviewId, 'remove');

    expect(changed.json()).toMatchObject({ upVotes: 1, downVotes: 1, userVote: 'down' });
    expect(removed.json()).toMatchObject({ upVotes: 1, downVotes: 0, userVote: null });
  });

  // a vote tells other buyers whether a review helps; it is for the reviews of others
  it.each(['up', 'down'] as const)(
    'refuses a vote %s of the author on an own review and counts nothing',
    async (action) => {
      const author = await newUser();
      const { id } = await createReview(author.id, (await createProduct()).id);

      const res = await vote(author, id, action);

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'REVIEW_OWN_VOTE_FORBIDDEN' });
      const stored = await asAdmin(async (tx) => ({
        review: await tx.review.findUniqueOrThrow({
          where: { id },
          select: { upVotes: true, downVotes: true },
        }),
        votes: await tx.reviewVote.count({ where: { reviewId: id } }),
      }));
      expect(stored).toEqual({ review: { upVotes: 0, downVotes: 0 }, votes: 0 });
    },
  );
});
