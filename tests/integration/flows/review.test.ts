import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { asAdmin } from '../../helpers/db.js';
import { closeSessions, createProduct, createUser } from '../../helpers/factories.js';
import { placeOrder } from '../../helpers/orders.js';

// a review from the delivery to its removal, through the routes of orders, products, reviews and
// users: the buyer of a delivered order reviews the product, others vote, the product counts the
// rating, the admin sees the review and the votes in the profiles and takes the review down, which
// the admin log keeps and the product counts no more
let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];

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

describe('a review from the delivery to its removal', () => {
  it('counts the rating and the votes, shows them to the admin and takes them back down', async () => {
    const product = await createProduct({ price: 30, stock: 3 });
    const buyer = await createUser({ name: 'Olena' });
    const voter = await createUser();
    const critic = await createUser();
    const admin = await createUser({ role: 'ADMIN' });
    userIds.push(buyer.id, voter.id, critic.id, admin.id);

    // a delivered order of the buyer
    const orderId = await placeOrder(app, csrf, buyer, product, 'shipped');
    const delivered = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${orderId}/status`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { status: 'delivered' },
    });
    expect(delivered.statusCode).toBe(200);

    // two reviews: the buyer of the product and someone who did not buy it
    const write = (author: typeof buyer, rating: number, comment: string) =>
      app.inject({
        method: 'POST',
        url: `/api/products/${product.id}/reviews`,
        headers: withCsrf(csrf, accessCookie(author)),
        payload: { rating, comment },
      });
    const praise = await write(buyer, 5, 'Worth every cent.');
    const doubt = await write(critic, 2, 'Too heavy for me.');
    expect(praise.json()).toMatchObject({ verifiedPurchase: true });
    expect(doubt.json()).toMatchObject({ verifiedPurchase: false });
    const praiseId = praise.json().id as number;

    // another user finds the review of the buyer helpful, the author may not vote on their own
    const vote = (user: typeof buyer, reviewId: number) =>
      app.inject({
        method: 'POST',
        url: `/api/reviews/${reviewId}/vote`,
        headers: withCsrf(csrf, accessCookie(user)),
        payload: { action: 'up' },
      });
    expect((await vote(voter, praiseId)).json()).toMatchObject({ upVotes: 1, userVote: 'up' });
    expect((await vote(buyer, praiseId)).json().errorCode).toBe('REVIEW_OWN_VOTE_FORBIDDEN');

    // the product counts both, the most helpful comes first
    const card = await app.inject({ method: 'GET', url: `/api/products/${product.id}` });
    expect(card.json()).toMatchObject({ reviewsCount: 2, avgRating: 3.5 });
    const helpful = await app.inject({
      method: 'GET',
      url: `/api/products/${product.id}/reviews?sort=helpful`,
    });
    expect(helpful.json().items.map((r: { id: number }) => r.id)[0]).toBe(praiseId);

    // the admin sees the review in the profile of the buyer and the vote in the one of the voter
    const profile = (userId: number, include: string) =>
      app.inject({
        method: 'GET',
        url: `/api/users/${userId}?include=${include}`,
        headers: { cookie: accessCookie(admin) },
      });
    expect(
      (await profile(buyer.id, 'reviews')).json().reviews.map((r: { id: number }) => r.id),
    ).toEqual([praiseId]);
    expect((await profile(voter.id, 'votes')).json().votes).toHaveLength(1);

    // the admin takes the review of the critic down: the admin log keeps it, the product counts
    // the one left
    const doubtId = doubt.json().id as number;
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/products/${product.id}/reviews/${doubtId}`,
      headers: withCsrf(csrf, accessCookie(admin)),
    });
    expect(removed.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: `/api/products/${product.id}` });
    expect(after.json()).toMatchObject({ reviewsCount: 1, avgRating: 5 });
    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { action: 'REVIEW_DELETE', entityId: doubtId },
        select: { actorId: true },
      }),
    );
    expect(lines).toEqual([{ actorId: admin.id }]);
  });
});
