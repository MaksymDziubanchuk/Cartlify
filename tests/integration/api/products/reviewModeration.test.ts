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
  createUser,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { refuseMail, watchMail } from '../../../helpers/mail.js';

// DELETE /api/products/:productId/reviews/:reviewId by an admin or root: a review that breaks the
// rules goes. Every such removal is a line of the journal of the admins (REVIEW_DELETE, the author
// in its changes) and mails the author which removal it is; the answer and the profile an admin
// reads count the removals of the reviews of the author against the limit (REVIEW_REMOVALS_LIMIT,
// 2 in the tests), and past it the page tells the admin to ask root about the account. An author
// who deletes an own review is no removal

const LIMIT = 2;

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

// a review with a comment of the author on a product of its own
async function reviewOf(author: TestUser, name = `Brass desk lamp ${uniqueTag()}`) {
  const product = await createProduct({ name });
  const review = await createReview(author.id, product.id, { rating: 1, comment: 'Bad words' });
  return { productId: product.id, reviewId: review.id, name };
}

const removeReview = (
  { productId, reviewId }: { productId: number; reviewId: number },
  actor: TestUser = admin,
) =>
  app.inject({
    method: 'DELETE',
    url: `/api/products/${productId}/reviews/${reviewId}`,
    headers: withCsrf(csrf, accessCookie(actor)),
  });

const journalOf = (reviewId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'review', entityId: reviewId },
      select: { actorId: true, action: true },
    }),
  );

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
  root = await newUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('DELETE /api/products/:productId/reviews/:reviewId by a moderator', () => {
  it('deletes the review, writes the journal, mails the author and counts the removal', async () => {
    const author = await newUser({ name: 'Anna' });
    const review = await reviewOf(author);
    const mails = watchMail();

    const res = await removeReview(review);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      message: 'REVIEW_DELETED',
      reviewRemovals: 1,
      reviewRemovalsLimit: LIMIT,
    });
    expect(await journalOf(review.reviewId)).toEqual([
      { actorId: admin.id, action: 'REVIEW_DELETE' },
    ]);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      to: [author.email],
      subject: 'Cartlify — Your review was removed',
      accepted: true,
    });
    expect(mails[0]!.text).toContain('Hi Anna,');
    expect(mails[0]!.text).toContain(`A moderator removed your review of ${review.name}`);
    expect(mails[0]!.text).toContain(`This is removal 1 of the ${LIMIT} the rules allow.`);
  });

  // the removals of the reviews of one author add up, whatever the product
  it('counts every removal of the author and tells when the limit is reached and passed', async () => {
    const author = await newUser();
    const mails = watchMail();
    const counts: number[] = [];

    for (let i = 0; i < LIMIT + 1; i++) {
      const res = await removeReview(await reviewOf(author), i === 1 ? root : admin);
      expect(res.statusCode).toBe(200);
      counts.push(res.json().reviewRemovals);
    }

    expect(counts).toEqual([1, 2, 3]);
    expect(mails.map((mail) => mail.text)).toEqual([
      expect.stringContaining(`This is removal 1 of the ${LIMIT} the rules allow.`),
      expect.stringContaining(`This is the last removal the rules allow, ${LIMIT} of ${LIMIT}.`),
      expect.stringContaining(`This is removal 3, past the ${LIMIT} the rules allow.`),
    ]);
  });

  it('counts nothing and mails nobody when the author deletes the own review', async () => {
    const author = await newUser();
    const own = await reviewOf(author);
    const mails = watchMail();

    const res = await removeReview(own, author);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'REVIEW_DELETED' });
    expect(mails).toEqual([]);

    const byAdmin = await removeReview(await reviewOf(author));
    expect(byAdmin.json()).toMatchObject({ reviewRemovals: 1 });
  });

  it('shows the count and the limit in the profile an admin reads, not to a user', async () => {
    const author = await newUser();
    await removeReview(await reviewOf(author));

    const forAdmin = await app.inject({
      method: 'GET',
      url: `/api/users/${author.id}`,
      headers: { cookie: accessCookie(admin) },
    });
    const forUser = await app.inject({
      method: 'GET',
      url: `/api/users/${author.id}`,
      headers: { cookie: accessCookie(await newUser()) },
    });

    expect(forAdmin.statusCode).toBe(200);
    expect(forAdmin.json()).toMatchObject({ reviewRemovals: 1, reviewRemovalsLimit: LIMIT });
    expect(forUser.json()).not.toHaveProperty('reviewRemovals');
    expect(forUser.json()).not.toHaveProperty('reviewRemovalsLimit');
  });

  // both found the review before either deleted it: the second answered 500 after the first took
  // it; now it is missing, and there is one line, one count and one mail
  it('deletes, writes, counts and mails once when two moderators remove the same review at once', async () => {
    for (let round = 0; round < 3; round += 1) {
      const author = await newUser();
      const review = await reviewOf(author);
      const mails = watchMail();

      const answers = await Promise.all([removeReview(review, admin), removeReview(review, root)]);

      expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 404]);
      expect(answers.find((res) => res.statusCode === 404)!.json()).toMatchObject({
        errorCode: 'REVIEW_NOT_FOUND',
      });
      expect(answers.find((res) => res.statusCode === 200)!.json()).toMatchObject({
        reviewRemovals: 1,
      });
      expect(await journalOf(review.reviewId)).toHaveLength(1);
      expect(mails.filter((mail) => mail.to.includes(author.email))).toHaveLength(1);
    }
  });

  // a deleted account keeps its reviews (the popularity counts them) and has no address to write to
  it('counts the removal of a review of a deleted account and mails nobody', async () => {
    const author = await newUser();
    const review = await reviewOf(author);
    const deletion = await app.inject({
      method: 'DELETE',
      url: `/api/users/${author.id}`,
      headers: withCsrf(csrf, accessCookie(root)),
    });
    expect(deletion.statusCode).toBe(200);
    const mails = watchMail();

    const res = await removeReview(review);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reviewRemovals: 1 });
    expect(mails).toEqual([]);
  });

  it('deletes the review even when the mail cannot be sent, and logs it', async () => {
    const author = await newUser();
    const review = await reviewOf(author);
    refuseMail();

    const res = await removeReview(review);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reviewRemovals: 1 });
    // the failed mail goes to the log with the id of the account, never with its address
    const [logged] = takeLogs({ msg: 'review removed mail was not sent' });
    expect(logged).toMatchObject({ userId: author.id });
    expect(JSON.stringify(logged)).not.toContain(author.email);
  });
});
