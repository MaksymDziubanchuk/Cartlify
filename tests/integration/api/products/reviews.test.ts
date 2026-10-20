import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  type TestUser,
} from '../../../helpers/factories.js';

// POST /api/products/:productId/reviews: a user rates a product of the catalog or comments on it

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];

const newUser = async () => {
  const user = await createUser();
  userIds.push(user.id);
  return user;
};

const writeReview = (user: TestUser, productId: number, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/api/products/${productId}/reviews`,
    headers: withCsrf(csrf, accessCookie(user)),
    payload,
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

describe('POST /api/products/:productId/reviews', () => {
  it('writes the review of a product of the catalog', async () => {
    const product = await createProduct();

    const res = await writeReview(await newUser(), product.id, { rating: 4 });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ productId: product.id, rating: 4 });
  });

  // the database refuses a review of a removed product as well; the route answers it as missing
  it('refuses a product removed from the catalog with 404 and writes nothing', async () => {
    const product = await createProduct();
    await deleteProductFromCatalog(product.id);

    const res = await writeReview(await newUser(), product.id, { rating: 4 });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
    const written = await asAdmin((tx) => tx.review.count({ where: { productId: product.id } }));
    expect(written).toBe(0);
  });
});
