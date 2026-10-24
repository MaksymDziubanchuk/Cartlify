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
import { watchMail } from '../../../helpers/mail.js';
import { placeOrder } from '../../../helpers/orders.js';

// reviews a buyer can trust: each says whether its author bought the product (verifiedPurchase:
// a paid order of it, shipped or delivered too, not cancelled), the list sorts by the newest, the
// most helpful or the rating, and the mail of a delivered order asks to rate each product

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];

const newUser = async () => {
  const user = await createUser();
  userIds.push(user.id);
  return user;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

type ReviewItem = { id: number; rating?: number; verifiedPurchase: boolean };

const reviewsOf = async (productId: number, query = '') => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/products/${productId}/reviews${query}`,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { items: ReviewItem[]; nextCursor?: string };
};

const verifiedOf = async (productId: number, reviewId: number) =>
  (await reviewsOf(productId)).items.find((item) => item.id === reviewId)?.verifiedPurchase;

describe('GET /api/products/:productId/reviews and the purchase of the author', () => {
  it.each(['paid', 'shipped'] as const)(
    'marks the review of an author with a %s order of the product',
    async (stage) => {
      const product = await createProduct({ price: 10, stock: 3 });
      const author = await newUser();
      await placeOrder(app, csrf, author, product, stage);
      const review = await createReview(author.id, product.id, { comment: 'Good' });

      expect(await verifiedOf(product.id, review.id)).toBe(true);
    },
  );

  it('marks the review of an author whose order is delivered', async () => {
    const product = await createProduct({ price: 10, stock: 3 });
    const author = await newUser();
    const orderId = await placeOrder(app, csrf, author, product, 'shipped');
    await asAdmin((tx) =>
      tx.order.update({ where: { id: orderId }, data: { status: 'delivered' } }),
    );
    const review = await createReview(author.id, product.id);

    expect(await verifiedOf(product.id, review.id)).toBe(true);
  });

  it('does not mark the review of an author who did not buy the product', async () => {
    const product = await createProduct({ price: 10, stock: 3 });
    const other = await createProduct({ price: 10, stock: 3 });
    const author = await newUser();
    await placeOrder(app, csrf, author, other, 'paid');
    const review = await createReview(author.id, product.id);

    expect(await verifiedOf(product.id, review.id)).toBe(false);
  });

  it('does not mark the review of an author whose order waits for its payment', async () => {
    const product = await createProduct({ price: 10, stock: 3 });
    const author = await newUser();
    await placeOrder(app, csrf, author, product, 'waiting');
    const review = await createReview(author.id, product.id);

    expect(await verifiedOf(product.id, review.id)).toBe(false);
  });

  // the money went back: the author has not bought it
  it('does not mark the review of an author whose paid order was cancelled', async () => {
    const product = await createProduct({ price: 10, stock: 3 });
    const author = await newUser();
    const orderId = await placeOrder(app, csrf, author, product, 'paid');
    await asAdmin((tx) => tx.$executeRaw`select cartlify.cancel_paid_order(${orderId}::int)`);
    const review = await createReview(author.id, product.id);

    expect(await verifiedOf(product.id, review.id)).toBe(false);
  });
});

describe('GET /api/products/:productId/reviews sorted', () => {
  // four reviews: ratings 3, 5, none and 1, the second with two votes up, the last with one
  async function reviewed() {
    const product = await createProduct({ price: 10 });
    const voters = [await newUser(), await newUser()];
    const ids: number[] = [];
    for (const rating of [3, 5, null, 1]) {
      const author = await newUser();
      ids.push(
        (await createReview(author.id, product.id, { rating, comment: rating ? null : 'Fine' })).id,
      );
    }
    for (const voter of voters) await createReviewVote(voter.id, ids[1]!, 'UP');
    await createReviewVote(voters[0]!.id, ids[3]!, 'UP');
    return { product, ids };
  }

  const idsOf = (page: { items: ReviewItem[] }) => page.items.map((item) => item.id);

  it('puts the newest first without a sort', async () => {
    const { product, ids } = await reviewed();

    expect(idsOf(await reviewsOf(product.id))).toEqual([...ids].reverse());
  });

  it('puts the most helpful first', async () => {
    const { product, ids } = await reviewed();

    expect(idsOf(await reviewsOf(product.id, '?sort=helpful'))).toEqual([
      ids[1],
      ids[3],
      ids[2],
      ids[0],
    ]);
  });

  it.each([
    ['ratingHigh', [1, 0, 3, 2]],
    ['ratingLow', [3, 0, 1, 2]],
  ])('sorts by %s, a review without a rating last', async (sort, order) => {
    const { product, ids } = await reviewed();

    expect(idsOf(await reviewsOf(product.id, `?sort=${sort}`))).toEqual(
      order.map((index) => ids[index]),
    );
  });

  it.each(['newest', 'helpful', 'ratingHigh', 'ratingLow'])(
    'goes page by page through the reviews sorted by %s',
    async (sort) => {
      const { product, ids } = await reviewed();
      const all = idsOf(await reviewsOf(product.id, `?sort=${sort}`));

      const seen: number[] = [];
      let cursor: string | undefined;
      do {
        const page: { items: ReviewItem[]; nextCursor?: string } = await reviewsOf(
          product.id,
          `?sort=${sort}&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        );
        seen.push(...idsOf(page));
        cursor = page.nextCursor;
      } while (cursor);

      expect(seen).toEqual(all);
      expect([...seen].sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
    },
  );

  it('refuses the cursor of another sort', async () => {
    const { product } = await reviewed();
    const first = await reviewsOf(product.id, '?sort=helpful&limit=1');

    const res = await app.inject({
      method: 'GET',
      url: `/api/products/${product.id}/reviews?sort=ratingLow&cursor=${first.nextCursor}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });

  it('refuses a sort it does not know', async () => {
    const product = await createProduct({ price: 10 });

    const res = await app.inject({
      method: 'GET',
      url: `/api/products/${product.id}/reviews?sort=oldest`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

describe('the mail of a delivered order', () => {
  it('asks the buyer to rate each product, with a link to it', async () => {
    const product = await createProduct({ price: 10, stock: 3 });
    const buyer = await newUser();
    const orderId = await placeOrder(app, csrf, buyer, product, 'shipped');
    const mails = watchMail();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${orderId}/status`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { status: 'delivered' },
    });

    expect(res.statusCode).toBe(200);
    expect(mails).toHaveLength(1);
    const link = `https://shop.example.com/products/${product.id}#reviews`;
    expect(mails[0]!.text).toContain(link);
    expect(mails[0]!.html).toContain(link);
    expect(mails[0]!.text).toMatch(/rate/i);
  });
});
