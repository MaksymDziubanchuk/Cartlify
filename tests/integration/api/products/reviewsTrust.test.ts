import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { cancelPaidOrder } from '../../../helpers/cancel.js';
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
// most helpful or the rating and filters by that purchase (verifiedPurchase=true or false), and the
// mail of a delivered order asks to rate each product

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

type ReviewItem = {
  id: number;
  rating?: number;
  verifiedPurchase: boolean;
  userVote?: 'up' | 'down' | null;
};

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
    await cancelPaidOrder(admin.id, orderId);
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

// The filter ?verifiedPurchase=true|false keeps the reviews whose mark is true, or false; without it
// the list has them all. It is the rule of the mark, not a copy of it: an author has bought the product
// when an order of it is paid, shipped or delivered
describe('GET /api/products/:productId/reviews filtered by the purchase', () => {
  const SORTS = ['newest', 'helpful', 'ratingHigh', 'ratingLow'] as const;

  type Page = { items: ReviewItem[]; limit: number; total: number; nextCursor?: string };

  // six authors with a review each: two bought the product (a paid and a shipped order), four did not
  // (no order, an order of another product, a paid order that was cancelled, an order that waits for
  // its payment). The ratings are all different but one review has none; four reviews have votes
  async function reviewedByBuyers() {
    const product = await createProduct({ price: 10, stock: 20 });
    const another = await createProduct({ price: 10, stock: 5 });

    const paid = await newUser();
    await placeOrder(app, csrf, paid, product, 'paid');
    const shipped = await newUser();
    await placeOrder(app, csrf, shipped, product, 'shipped');
    const stranger = await newUser();
    const elsewhere = await newUser();
    await placeOrder(app, csrf, elsewhere, another, 'paid');
    const cancelled = await newUser();
    await cancelPaidOrder(admin.id, await placeOrder(app, csrf, cancelled, product, 'paid'));
    const waiting = await newUser();
    await placeOrder(app, csrf, waiting, product, 'waiting');

    const made = {
      paid: await createReview(paid.id, product.id, { rating: 5 }),
      shipped: await createReview(shipped.id, product.id, { rating: 3 }),
      stranger: await createReview(stranger.id, product.id, { rating: null, comment: 'Fine' }),
      elsewhere: await createReview(elsewhere.id, product.id, { rating: 4 }),
      cancelled: await createReview(cancelled.id, product.id, { rating: 1 }),
      waiting: await createReview(waiting.id, product.id, { rating: 2 }),
    };

    const voters = [await newUser(), await newUser()];
    for (const voter of voters) await createReviewVote(voter.id, made.paid.id, 'UP');
    await createReviewVote(voters[0]!.id, made.stranger.id, 'UP');
    await createReviewVote(voters[0]!.id, made.cancelled.id, 'UP');

    return {
      product,
      voters,
      buyer: paid,
      bought: [made.paid.id, made.shipped.id],
      notBought: [made.stranger.id, made.elsewhere.id, made.cancelled.id, made.waiting.id],
    };
  }

  async function pageOf(
    productId: number,
    query = '',
    as?: TestUser,
  ): Promise<{ status: number; page: Page; res: LightMyRequestResponse }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/products/${productId}/reviews${query}`,
      ...(as ? { headers: { cookie: accessCookie(as) } } : {}),
    });
    return { status: res.statusCode, page: res.json() as Page, res };
  }

  const idsOf = (page: Page) => page.items.map((item) => item.id);

  // every page of a walk with the query given: the ids in the order of the pages, the totals seen
  async function walk(productId: number, query: string, limit: number) {
    const ids: number[] = [];
    const totals = new Set<number>();
    let cursor: string | undefined;

    do {
      const { status, page } = await pageOf(
        productId,
        `?${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(status).toBe(200);
      ids.push(...idsOf(page));
      totals.add(page.total);
      cursor = page.nextCursor;
    } while (cursor);

    return { ids, totals: [...totals] };
  }

  it('lists the reviews of the authors who bought the product with true', async () => {
    const { product, bought } = await reviewedByBuyers();

    const { status, page } = await pageOf(product.id, '?verifiedPurchase=true');

    expect(status).toBe(200);
    expect(idsOf(page)).toEqual([...bought].reverse());
    expect(page.items.every((item) => item.verifiedPurchase)).toBe(true);
    expect(page.total).toBe(2);
  });

  it('lists the reviews of the authors who did not buy it with false', async () => {
    const { product, notBought } = await reviewedByBuyers();

    const { status, page } = await pageOf(product.id, '?verifiedPurchase=false');

    expect(status).toBe(200);
    expect(idsOf(page)).toEqual([...notBought].reverse());
    expect(page.items.some((item) => item.verifiedPurchase)).toBe(false);
    expect(page.total).toBe(4);
  });

  it('lists every review without the filter', async () => {
    const { product, bought, notBought } = await reviewedByBuyers();

    const { page } = await pageOf(product.id);

    expect(idsOf(page).sort((a, b) => a - b)).toEqual(
      [...bought, ...notBought].sort((a, b) => a - b),
    );
    expect(page.total).toBe(6);
    expect(page.items.filter((item) => item.verifiedPurchase)).toHaveLength(2);
  });

  // the cancelled order gave the money back, and the order that waits has not been paid: the authors of
  // both have not bought it, for the mark and for the filter alike
  it('does not count an author whose order is cancelled or waits for its payment', async () => {
    const { product, bought } = await reviewedByBuyers();

    const { page } = await pageOf(product.id, '?verifiedPurchase=true');

    expect(idsOf(page).sort((a, b) => a - b)).toEqual([...bought].sort((a, b) => a - b));
  });

  it('keeps the newest first when no sort is given', async () => {
    const { product, bought } = await reviewedByBuyers();

    const { page } = await pageOf(product.id, '?verifiedPurchase=true');

    expect(idsOf(page)).toEqual([bought[1], bought[0]]);
  });

  it('counts as bought the author whose order is delivered', async () => {
    const product = await createProduct({ price: 10, stock: 3 });
    const author = await newUser();
    const orderId = await placeOrder(app, csrf, author, product, 'shipped');
    await asAdmin((tx) =>
      tx.order.update({ where: { id: orderId }, data: { status: 'delivered' } }),
    );
    const review = await createReview(author.id, product.id);

    expect(idsOf((await pageOf(product.id, '?verifiedPurchase=true')).page)).toEqual([review.id]);
    expect(idsOf((await pageOf(product.id, '?verifiedPurchase=false')).page)).toEqual([]);
  });

  // the filter and the mark follow the order: once the paid order of an author is cancelled, the review
  // leaves the list of the buyers, and comes into the other one
  it('moves a review from one list to the other when the order of its author is cancelled', async () => {
    const product = await createProduct({ price: 10, stock: 3 });
    const author = await newUser();
    const orderId = await placeOrder(app, csrf, author, product, 'paid');
    const review = await createReview(author.id, product.id);

    expect(idsOf((await pageOf(product.id, '?verifiedPurchase=true')).page)).toEqual([review.id]);
    expect(await verifiedOf(product.id, review.id)).toBe(true);

    await cancelPaidOrder(admin.id, orderId);

    expect(idsOf((await pageOf(product.id, '?verifiedPurchase=true')).page)).toEqual([]);
    expect(idsOf((await pageOf(product.id, '?verifiedPurchase=false')).page)).toEqual([review.id]);
    expect(await verifiedOf(product.id, review.id)).toBe(false);
  });

  it('agrees with the mark of every review: the two lists make the whole one, and no review is in both', async () => {
    const { product } = await reviewedByBuyers();

    const all = (await pageOf(product.id)).page;
    const yes = (await pageOf(product.id, '?verifiedPurchase=true')).page;
    const no = (await pageOf(product.id, '?verifiedPurchase=false')).page;

    expect(new Set([...idsOf(yes), ...idsOf(no)])).toEqual(new Set(idsOf(all)));
    expect(idsOf(yes).filter((id) => idsOf(no).includes(id))).toEqual([]);
    for (const item of all.items) {
      expect(idsOf(item.verifiedPurchase ? yes : no)).toContain(item.id);
    }
  });

  it.each(SORTS)('keeps the order of the sort %s in each list', async (sort) => {
    const { product, bought, notBought } = await reviewedByBuyers();
    const every = idsOf((await pageOf(product.id, `?sort=${sort}`)).page);

    const yes = idsOf((await pageOf(product.id, `?sort=${sort}&verifiedPurchase=true`)).page);
    const no = idsOf((await pageOf(product.id, `?sort=${sort}&verifiedPurchase=false`)).page);

    expect(yes).toEqual(every.filter((id) => bought.includes(id)));
    expect(no).toEqual(every.filter((id) => notBought.includes(id)));
  });

  describe.each(SORTS)('page by page, sorted by %s', (sort) => {
    it.each([
      ['true', 2],
      ['false', 4],
    ])('with verifiedPurchase=%s', async (value, count) => {
      const { product } = await reviewedByBuyers();
      const filter = `sort=${sort}&verifiedPurchase=${value}`;
      const whole = await pageOf(product.id, `?${filter}`);

      for (const limit of [1, 3]) {
        const walked = await walk(product.id, filter, limit);

        expect(walked.ids).toEqual(idsOf(whole.page));
        // the count is that of the filtered reviews, on every page
        expect(walked.totals).toEqual([count]);
      }
    });
  });

  it('counts the filtered reviews in total, whatever the size of the page', async () => {
    const { product } = await reviewedByBuyers();

    expect((await pageOf(product.id, '?verifiedPurchase=true&limit=1')).page).toMatchObject({
      limit: 1,
      total: 2,
    });
    expect((await pageOf(product.id, '?verifiedPurchase=false&limit=1')).page).toMatchObject({
      limit: 1,
      total: 4,
    });
    expect((await pageOf(product.id, '?limit=1')).page).toMatchObject({ limit: 1, total: 6 });
  });

  it('gives a page of nothing for a product with no review of that kind', async () => {
    const product = await createProduct({ price: 10, stock: 3 });
    const author = await newUser();
    await createReview(author.id, product.id);

    const yes = (await pageOf(product.id, '?verifiedPurchase=true')).page;

    expect(yes).toMatchObject({ items: [], total: 0 });
    expect(yes.nextCursor).toBeUndefined();
  });

  // a cursor goes on a list: the one of another filter, or of none, is not the cursor of this one
  it.each([
    ['true', 'false'],
    ['true', ''],
    ['false', 'true'],
    ['false', ''],
    ['', 'true'],
    ['', 'false'],
  ])(
    'refuses the cursor of a page with verifiedPurchase=%j on a page with %j',
    async (from, to) => {
      const { product } = await reviewedByBuyers();
      const first = await pageOf(product.id, `?limit=1${from ? `&verifiedPurchase=${from}` : ''}`);
      expect(first.page.nextCursor).toBeDefined();

      const { status, res } = await pageOf(
        product.id,
        `?limit=1${to ? `&verifiedPurchase=${to}` : ''}&cursor=${first.page.nextCursor}`,
      );

      expect(status).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
    },
  );

  it('goes on with the cursor of its own filter', async () => {
    const { product } = await reviewedByBuyers();
    const first = await pageOf(product.id, '?limit=1&verifiedPurchase=false');

    const { status, page } = await pageOf(
      product.id,
      `?limit=1&verifiedPurchase=false&cursor=${first.page.nextCursor}`,
    );

    expect(status).toBe(200);
    expect(idsOf(page)).not.toEqual(idsOf(first.page));
    expect(page.total).toBe(4);
  });

  it.each(['maybe', 'yes', '2'])('refuses the value %j', async (value) => {
    const product = await createProduct({ price: 10, stock: 3 });

    const { status, res } = await pageOf(product.id, `?verifiedPurchase=${value}`);

    expect(status).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  // the orders are hidden from a guest and from a buyer by the rules of the database: the filter reads
  // as the system, and what each role gets is the same list
  it.each([
    ['a guest', () => undefined],
    ['a buyer who bought the product', (made: { buyer: TestUser }) => made.buyer],
    ['an admin', () => admin],
  ])('gives %s the same lists', async (_who, actor) => {
    const made = await reviewedByBuyers();
    const { product, bought, notBought } = made;
    const as = actor(made);

    const yes = (await pageOf(product.id, '?verifiedPurchase=true', as)).page;
    const no = (await pageOf(product.id, '?verifiedPurchase=false', as)).page;

    expect(idsOf(yes).sort((a, b) => a - b)).toEqual([...bought].sort((a, b) => a - b));
    expect(idsOf(no).sort((a, b) => a - b)).toEqual([...notBought].sort((a, b) => a - b));
    expect([yes.total, no.total]).toEqual([2, 4]);
  });

  it('gives a buyer who has no order the same lists', async () => {
    const { product, bought } = await reviewedByBuyers();
    const reader = await newUser();

    const yes = (await pageOf(product.id, '?verifiedPurchase=true', reader)).page;

    expect(idsOf(yes).sort((a, b) => a - b)).toEqual([...bought].sort((a, b) => a - b));
  });

  // the votes of the viewer are read as the viewer, after the page is read as the system
  it('keeps the vote of the viewer on the reviews of the filtered page', async () => {
    const { product, voters, bought, notBought } = await reviewedByBuyers();

    const yes = (await pageOf(product.id, '?verifiedPurchase=true', voters[0])).page;
    const no = (await pageOf(product.id, '?verifiedPurchase=false', voters[0])).page;

    // the first voter voted up on one review of the buyers and two of the others
    expect(yes.items.filter((item) => item.userVote === 'up').map((item) => item.id)).toEqual([
      bought[0],
    ]);
    expect(yes.items.every((item) => item.userVote !== undefined)).toBe(true);
    expect(no.items.filter((item) => item.userVote === 'up')).toHaveLength(2);
    expect(no.items.filter((item) => item.userVote === 'up').map((item) => item.id)).toEqual(
      expect.arrayContaining([notBought[0], notBought[2]]),
    );

    // a guest has no vote to show
    const guest = (await pageOf(product.id, '?verifiedPurchase=true')).page;
    expect(guest.items.every((item) => item.userVote === undefined)).toBe(true);
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
