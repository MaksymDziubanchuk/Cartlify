import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type DbSession } from '../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createReview,
  createReviewVote,
  createUser,
  type TestUser,
} from '../../helpers/factories.js';

// review_votes: who voted how on a review belongs to the voter, an admin sees every vote. Everybody
// else reads the counts the review keeps, and the database counts every vote into them, also the
// ones the voter cannot see

let author: TestUser;
let first: TestUser;
let second: TestUser;
let third: TestUser;
let reviewId: number;

const votesOf = (db: DbSession) =>
  db.rows<{ userId: number; action: string }>(
    `select "userId", action::text as action
     from cartlify.review_votes where "reviewId" = $1 order by "userId"`,
    reviewId,
  );

const countsOf = async (db: DbSession) =>
  (
    await db.rows<{ up: number; down: number }>(
      'select "upVotes" as up, "downVotes" as down from cartlify.reviews where id = $1',
      reviewId,
    )
  )[0];

// a review of a product with an up vote of the first user and a down vote of the second
beforeAll(async () => {
  author = await createUser();
  first = await createUser();
  second = await createUser();
  third = await createUser();
  const product = await createProduct();

  ({ id: reviewId } = await createReview(author.id, product.id));
  await createReviewVote(first.id, reviewId, 'UP');
  await createReviewVote(second.id, reviewId, 'DOWN');
});

afterAll(async () => {
  try {
    await closeSessions([author.id, first.id, second.id, third.id]);
  } finally {
    await prisma.$disconnect();
  }
});

describe('review_votes', () => {
  it('shows a user only an own vote', async () => {
    const votes = await inRolledBackTx(async (db) => {
      await db.as({ role: 'USER', userId: first.id });
      return votesOf(db);
    });

    expect(votes).toEqual([{ userId: first.id, action: 'UP' }]);
  });

  it('shows a guest no vote', async () => {
    const votes = await inRolledBackTx(async (db) => {
      await db.as({ role: 'GUEST', guestId: randomUUID() });
      return votesOf(db);
    });

    expect(votes).toEqual([]);
  });

  it.each(['ADMIN', 'ROOT'] as const)('shows an %s every vote', async (role) => {
    const votes = await inRolledBackTx(async (db) => {
      await db.as({ role, userId: third.id });
      return votesOf(db);
    });

    expect(votes).toEqual([
      { userId: first.id, action: 'UP' },
      { userId: second.id, action: 'DOWN' },
    ]);
  });

  it('counts into the review every vote, also the ones the voter does not see', async () => {
    const counts = await inRolledBackTx(async (db) => {
      await db.as({ role: 'USER', userId: third.id });
      await db.rows(
        `insert into cartlify.review_votes ("userId", "reviewId", action)
         values ($1, $2, 'UP') returning 1`,
        third.id,
        reviewId,
      );
      return countsOf(db);
    });

    expect(counts).toEqual({ up: 2, down: 1 });
  });

  it('lets the voter change an own vote and take it back, the counts follow', async () => {
    const { changed, removed } = await inRolledBackTx(async (db) => {
      await db.as({ role: 'USER', userId: first.id });
      await db.rows(
        `update cartlify.review_votes set action = 'DOWN'
         where "userId" = $1 and "reviewId" = $2 returning 1`,
        first.id,
        reviewId,
      );
      const changed = await countsOf(db);
      await db.rows(
        'delete from cartlify.review_votes where "userId" = $1 and "reviewId" = $2 returning 1',
        first.id,
        reviewId,
      );
      return { changed, removed: await countsOf(db) };
    });

    expect(changed).toEqual({ up: 0, down: 2 });
    expect(removed).toEqual({ up: 0, down: 1 });
  });

  it('lets a user change and delete no vote of another user', async () => {
    const { changed, removed, votes } = await inRolledBackTx(async (db) => {
      await db.as({ role: 'USER', userId: first.id });
      const changed = await db.rows(
        `update cartlify.review_votes set action = 'UP' where "userId" = $1 returning 1`,
        second.id,
      );
      const removed = await db.rows(
        'delete from cartlify.review_votes where "userId" = $1 returning 1',
        second.id,
      );
      await db.as({ role: 'ADMIN', userId: third.id });
      return { changed, removed, votes: await votesOf(db) };
    });

    expect(changed).toEqual([]);
    expect(removed).toEqual([]);
    expect(votes).toContainEqual({ userId: second.id, action: 'DOWN' });
  });

  // a vote is for the review of another user
  it('refuses the author a vote on an own review', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as({ role: 'USER', userId: author.id });
      return db.attempt(
        `insert into cartlify.review_votes ("userId", "reviewId", action) values ($1, $2, 'UP')`,
        author.id,
        reviewId,
      );
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });

  it('does not let a vote move onto an own review of the voter', async () => {
    const { id: ownReview } = await createReview(first.id, (await createProduct()).id);

    const outcome = await inRolledBackTx(async (db) => {
      await db.as({ role: 'USER', userId: first.id });
      return db.attempt(
        `update cartlify.review_votes set "reviewId" = $1 where "userId" = $2 and "reviewId" = $3`,
        ownReview,
        first.id,
        reviewId,
      );
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });

  // a vote moved to another review would leave the counters of the review it left as they were
  it('does not let a vote move to another review, the counts stay', async () => {
    const { id: elsewhere } = await createReview(third.id, (await createProduct()).id);

    const { outcome, counts } = await inRolledBackTx(async (db) => {
      await db.as({ role: 'USER', userId: first.id });
      const outcome = await db.attempt(
        `update cartlify.review_votes set "reviewId" = $1 where "userId" = $2 and "reviewId" = $3`,
        elsewhere,
        first.id,
        reviewId,
      );
      return { outcome, counts: await countsOf(db) };
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
    expect(counts).toEqual({ up: 1, down: 1 });
  });

  it('does not let a vote change its voter', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as({ role: 'USER', userId: first.id });
      return db.attempt(
        `update cartlify.review_votes set "userId" = $1 where "userId" = $2 and "reviewId" = $3`,
        third.id,
        first.id,
        reviewId,
      );
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });
});
