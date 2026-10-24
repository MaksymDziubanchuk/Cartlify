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
  createReviewVote,
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

  // a review that has votes already: the author adds the comment it missed, the answer showed 0
  it('answers with the votes the review has when the author adds the missing part', async () => {
    const product = await createProduct();
    const author = await newUser();
    const voter = await newUser();
    const review = await createReview(author.id, product.id, { rating: 4 });
    await createReviewVote(voter.id, review.id, 'UP');

    const res = await writeReview(author, product.id, { comment: 'Holds the heat well' });

    expect(res.statusCode).toBeLessThan(300);
    expect(res.json()).toMatchObject({ id: review.id, upVotes: 1, downVotes: 0 });
  });

  it('takes a comment of 2000 signs and refuses a longer one', async () => {
    const product = await createProduct();

    const long = await writeReview(await newUser(), product.id, { comment: 'a'.repeat(2001) });
    const fits = await writeReview(await newUser(), product.id, { comment: 'a'.repeat(2000) });

    expect(long.statusCode).toBe(400);
    expect(long.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(fits.statusCode).toBe(201);
  });

  // postgres keeps no NUL in a text: the review failed with 500; any json body with one is refused
  it('refuses a comment with a NUL sign', async () => {
    const product = await createProduct();

    const res = await writeReview(await newUser(), product.id, { comment: 'bad\u0000text' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'TEXT_NUL_FORBIDDEN' });
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

  // the next page started after the review the cursor named; once it was deleted, the page was empty
  it('goes on after the review the cursor points to is deleted', async () => {
    const product = await createProduct();
    const ids: number[] = [];
    for (let i = 0; i < 3; i += 1)
      ids.push((await createReview((await newUser()).id, product.id)).id);

    const first = await app.inject({
      method: 'GET',
      url: `/api/products/${product.id}/reviews?limit=1`,
    });
    expect(first.json().items.map((r: { id: number }) => r.id)).toEqual([ids[2]]);
    await asAdmin((tx) => tx.review.delete({ where: { id: ids[2]! } }));

    const next = await app.inject({
      method: 'GET',
      url: `/api/products/${product.id}/reviews?limit=1&cursor=${first.json().nextCursor}`,
    });

    expect(next.statusCode).toBe(200);
    expect(next.json().items.map((r: { id: number }) => r.id)).toEqual([ids[1]]);
  });

  // the card of a product taken out answers 404 to a buyer, its reviews stayed open
  it('shows a buyer no reviews of a product taken out of the catalog, an admin sees them', async () => {
    const product = await createProduct();
    await createReview((await newUser()).id, product.id, { rating: 2 });
    await deleteProductFromCatalog(product.id);
    const admin = await createUser({ role: 'ADMIN' });
    userIds.push(admin.id);

    const buyer = await app.inject({ method: 'GET', url: `/api/products/${product.id}/reviews` });
    const staff = await app.inject({
      method: 'GET',
      url: `/api/products/${product.id}/reviews`,
      headers: { cookie: accessCookie(admin) },
    });

    expect(buyer.statusCode).toBe(404);
    expect(buyer.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
    expect(staff.statusCode).toBe(200);
    expect(staff.json().items).toHaveLength(1);
  });
});
