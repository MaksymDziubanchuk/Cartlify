import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import {
  createProduct,
  createReview,
  createReviewVote,
  createUser,
} from '../../../helpers/factories.js';

// the reviews of a product as a user reads them: each review says how the user voted on it, a
// guest gets the counts only
let app: FastifyInstance;

beforeAll(async () => {
  app = await startApp();
});

afterAll(stopApp);

type Item = { id: number; upVotes: number; downVotes: number; userVote?: 'up' | 'down' | null };

describe('GET /api/products/:productId/reviews', () => {
  it('gives a user the vote they gave each review of the page, and none where they gave none', async () => {
    const product = await createProduct();
    const reader = await createUser();
    const liked = await createReview((await createUser()).id, product.id, { rating: 5 });
    const disliked = await createReview((await createUser()).id, product.id, { rating: 2 });
    const untouched = await createReview((await createUser()).id, product.id, { rating: 4 });
    await createReviewVote(reader.id, liked.id, 'UP');
    await createReviewVote(reader.id, disliked.id, 'DOWN');

    const res = await app.inject({
      method: 'GET',
      url: `/api/products/${product.id}/reviews`,
      headers: { cookie: accessCookie(reader) },
    });
    const byId = new Map((res.json().items as Item[]).map((item) => [item.id, item]));

    expect(res.statusCode).toBe(200);
    expect(byId.get(liked.id)).toMatchObject({ upVotes: 1, downVotes: 0, userVote: 'up' });
    expect(byId.get(disliked.id)).toMatchObject({ upVotes: 0, downVotes: 1, userVote: 'down' });
    expect(byId.get(untouched.id)).toMatchObject({ upVotes: 0, downVotes: 0, userVote: null });
  });

  it('gives a guest the counts and no vote of anyone', async () => {
    const product = await createProduct();
    const review = await createReview((await createUser()).id, product.id, { rating: 5 });
    await createReviewVote((await createUser()).id, review.id, 'UP');

    const res = await app.inject({ method: 'GET', url: `/api/products/${product.id}/reviews` });
    const [item] = res.json().items as Item[];

    expect(res.statusCode).toBe(200);
    expect(item).toMatchObject({ id: review.id, upVotes: 1, downVotes: 0 });
    expect(item!.userVote ?? null).toBeNull();
  });
});
