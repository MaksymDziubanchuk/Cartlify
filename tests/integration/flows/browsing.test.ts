import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createReview,
  createUser,
  uniqueTag,
  type TestUser,
} from '../../helpers/factories.js';
import { journeyOf } from '../../helpers/returnJourney.js';

// The catalog through the eyes of a guest and of a buyer, each step with what they see: the tree
// of the categories leads to a category and its products, the suggestions of the search box lead
// to a product, the card names its variants and opens one of them, the reviews of the product are
// read under it. The rules of each list are the tests of api/categories and api/products.
let app: FastifyInstance;
let csrf: Csrf;
let buyer: TestUser;
let author: TestUser;
const j = journeyOf(
  () => app,
  () => csrf,
);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  buyer = await createUser({ name: 'Browsing Buyer' });
  author = await createUser({ name: 'Review Author' });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, author.id]);
  } finally {
    await stopApp();
  }
});

type Node = { id: number; name: string; productCount: number; children: Node[] };
const findIn = (nodes: Node[], id: number): Node | undefined => {
  for (const node of nodes) {
    if (node.id === id) return node;
    const below = findIn(node.children, id);
    if (below) return below;
  }
  return undefined;
};

describe('the catalog through the eyes of a guest and of a buyer', () => {
  it('leads from the tree and from the search box to a product, its variant and its reviews', async () => {
    const tag = uniqueTag();
    const garden = await createCategory({ name: `Garden ${tag}` });
    const tools = await createCategory({ name: `Tools ${tag}`, parentId: garden.id });
    const product = await createProduct({ categoryId: tools.id, name: `Rake ${tag}` });
    await createReview(author.id, product.id, { rating: 4, comment: 'Sturdy and light.' });

    for (const viewer of [null, buyer]) {
      // the tree: the tools under the garden, with one product
      const tree = await j.get(viewer, '/api/categories/tree');
      expect(tree.statusCode).toBe(200);
      const node = findIn(tree.json().items as Node[], garden.id)!;
      expect(node.children).toEqual([expect.objectContaining({ id: tools.id, productCount: 1 })]);
      const inTools = await j.get(viewer, `/api/products?categoryIds=${tools.id}`);
      expect(
        (inTools.json().items as { product: { id: number } }[]).map(({ product: p }) => p.id),
      ).toEqual([product.id]);

      // the search box suggests the rake while the name is typed
      const suggested = await j.get(
        viewer,
        `/api/products/suggestions?q=${encodeURIComponent(`Rake ${tag}`)}`,
      );
      expect(suggested.json().items).toContainEqual({ id: product.id, name: `Rake ${tag}` });

      // the card names the variant, which opens on its own; the review is under the card
      const card = (await j.get(viewer, `/api/products/${product.id}`)).json();
      const variantId = (card.variants as { id: number }[])[0]!.id;
      const variant = await j.get(viewer, `/api/products/${product.id}/variants/${variantId}`);
      expect(variant.statusCode).toBe(200);
      expect(variant.json()).toMatchObject({ id: variantId, price: card.variant.price });
      const reviews = await j.get(viewer, `/api/products/${product.id}/reviews`);
      expect(reviews.json().items).toEqual([
        expect.objectContaining({
          rating: 4,
          comment: 'Sturdy and light.',
          user: expect.objectContaining({ name: 'Review Author' }),
        }),
      ]);
    }

    // the buyer keeps the rake among the favorites for a while, then takes it out
    const variantId = (await j.get(buyer, `/api/products/${product.id}`)).json().variant
      .id as number;
    expect((await j.post(buyer, `/api/favorites/${variantId}`)).json()).toMatchObject({
      isFavorite: true,
    });
    expect((await j.del(buyer, `/api/favorites/${variantId}`)).json()).toEqual({
      variantId,
      isFavorite: false,
    });
    expect((await j.get(buyer, '/api/favorites')).json().items).toEqual([]);
  });
});
