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
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';

// DELETE /api/products/:productId takes a product out of the catalog (its row stays for the orders
// that hold it); DELETE /api/products/:productId/reviews/:reviewId deletes a review

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let author: TestUser;
let stranger: TestUser;
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  author = await createUser();
  stranger = await createUser();
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions([admin.id, author.id, stranger.id]);
  } finally {
    await stopApp();
  }
});

const newProduct = async () => {
  const product = await createProduct({ price: 10 });
  products.push(product);
  return product;
};

const removeProduct = (productId: number, actor: TestUser = admin) =>
  app.inject({
    method: 'DELETE',
    url: `/api/products/${productId}`,
    headers: withCsrf(csrf, accessCookie(actor)),
  });

const cardOf = (productId: number, cookie = '') =>
  app.inject({
    method: 'GET',
    url: `/api/products/${productId}`,
    headers: cookie ? { cookie } : {},
  });

const removeReview = (productId: number, reviewId: number, actor: TestUser) =>
  app.inject({
    method: 'DELETE',
    url: `/api/products/${productId}/reviews/${reviewId}`,
    headers: withCsrf(csrf, accessCookie(actor)),
  });

// the lines of the deletions; a product made for a test has a line of its delivery too
const journalOf = (entityType: 'product' | 'review', entityId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType, entityId, action: { in: ['PRODUCT_DELETE', 'REVIEW_DELETE'] } },
      select: { actorId: true, action: true },
    }),
  );

describe('DELETE /api/products/:productId', () => {
  it('takes the product out of the catalog, keeps its row and writes the admin log', async () => {
    const product = await newProduct();

    const res = await removeProduct(product.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'PRODUCT_DELETED' });
    const row = await asAdmin((tx) =>
      tx.product.findUniqueOrThrow({ where: { id: product.id }, select: { deletedAt: true } }),
    );
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(await journalOf('product', product.id)).toEqual([
      { actorId: admin.id, action: 'PRODUCT_DELETE' },
    ]);
  });

  it('shows a buyer no card of a product taken out of the catalog', async () => {
    const product = await newProduct();
    await removeProduct(product.id);

    for (const cookie of ['', accessCookie(stranger)]) {
      const res = await cardOf(product.id, cookie);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
    }
  });

  it('shows an admin the card of a product taken out, with the time it went', async () => {
    const product = await newProduct();
    await removeProduct(product.id);

    const res = await cardOf(product.id, accessCookie(admin));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: product.id, deletedAt: expect.any(String) });
  });

  it('answers 409 the second time and writes no second line', async () => {
    const product = await newProduct();
    await removeProduct(product.id);

    const res = await removeProduct(product.id);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_ALREADY_DELETED' });
    expect(await journalOf('product', product.id)).toHaveLength(1);
  });

  it('answers 404 for a product that does not exist', async () => {
    const res = await removeProduct(2_000_000_000);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
  });

  it('refuses a user', async () => {
    const product = await newProduct();

    const res = await removeProduct(product.id, stranger);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

describe('DELETE /api/products/:productId/reviews/:reviewId', () => {
  const countsOf = (productId: number) =>
    asAdmin((tx) =>
      tx.product.findUniqueOrThrow({
        where: { id: productId },
        select: { reviewsCount: true },
      }),
    );

  it('lets the author delete their own review, no line in the admin log, the product counts it no more', async () => {
    const product = await newProduct();
    // the product counts the reviews with a comment
    const review = await createReview(author.id, product.id, { rating: 4, comment: 'Fine' });
    expect((await countsOf(product.id)).reviewsCount).toBe(1);

    const res = await removeReview(product.id, review.id, author);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'REVIEW_DELETED' });
    expect((await countsOf(product.id)).reviewsCount).toBe(0);
    expect(await journalOf('review', review.id)).toEqual([]);
  });

  it('lets an admin delete the review of anybody, with a line in the admin log', async () => {
    const product = await newProduct();
    const review = await createReview(author.id, product.id, { rating: 2, comment: 'Bad' });

    const res = await removeReview(product.id, review.id, admin);

    expect(res.statusCode).toBe(200);
    expect(await journalOf('review', review.id)).toEqual([
      { actorId: admin.id, action: 'REVIEW_DELETE' },
    ]);
  });

  it('refuses a user who did not write the review and keeps it', async () => {
    const product = await newProduct();
    const review = await createReview(author.id, product.id, { comment: 'Mine' });

    const res = await removeReview(product.id, review.id, stranger);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'REVIEW_DELETE_FORBIDDEN' });
    expect((await countsOf(product.id)).reviewsCount).toBe(1);
  });

  it('answers 404 for a review of another product', async () => {
    const product = await newProduct();
    const other = await newProduct();
    const review = await createReview(author.id, product.id);

    const res = await removeReview(other.id, review.id, author);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'REVIEW_NOT_FOUND' });
  });
});
