import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { DELETED_AVATAR_COLOR } from '@utils/avatar.util.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { drawnAvatarOf } from '../../../helpers/avatar.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createReview,
  createUser,
  deleteProductFromCatalog,
  type TestUser,
} from '../../../helpers/factories.js';

// POST /api/products/:productId/reviews: a user rates a product of the catalog or comments on it;
// GET lists the reviews with their authors

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

describe('GET /api/products/:productId/reviews', () => {
  it('draws the letter of an author without a picture and G on grey for a deleted one', async () => {
    const product = await createProduct();
    const author = await createUser({ name: 'Ira' });
    const gone = await createUser({ name: 'Taras' });
    const root = await createUser({ role: 'ROOT' });
    userIds.push(author.id, gone.id, root.id);
    await createReview(author.id, product.id, { rating: 5 });
    await createReview(gone.id, product.id, { rating: 3 });
    const deletion = await app.inject({
      method: 'DELETE',
      url: `/api/users/${gone.id}`,
      headers: withCsrf(csrf, accessCookie(root)),
    });
    expect(deletion.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: `/api/products/${product.id}/reviews` });

    expect(res.statusCode).toBe(200);
    type Author = { id: number; avatarUrls: Record<string, string> };
    const authors = new Map<number, Author>(
      res.json().items.map((review: { user: Author }) => [review.user.id, review.user] as const),
    );
    expect(authors.get(author.id)).toMatchObject({ name: 'Ira', avatarIsDefault: true });
    expect(drawnAvatarOf(authors.get(author.id)!.avatarUrls)).toMatchObject({ letter: 'I' });
    expect(authors.get(gone.id)).toMatchObject({
      name: 'Guest',
      deleted: true,
      avatarIsDefault: true,
    });
    expect(drawnAvatarOf(authors.get(gone.id)!.avatarUrls)).toEqual({
      letter: 'G',
      color: DELETED_AVATAR_COLOR,
    });
  });
});
