import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';

// GET /api/favorites: the favorite products of a guest or a user, each as a product card. A product
// removed from the catalog stays among the favorites in the database and is left out of the list

let app: FastifyInstance;
let csrf: Csrf;
let buyer: TestUser;
let product: TestProduct;

// the cookies a response sets, ready to send back
const cookiesOf = (res: { headers: Record<string, unknown> }) =>
  [res.headers['set-cookie']]
    .flat()
    .filter(Boolean)
    .map((cookie) => String(cookie).split(';')[0])
    .join('; ');

// a new guest with the product among its favorites
async function guestWithFavorite(productId: number) {
  const first = await app.inject({ method: 'GET', url: '/api/favorites' });
  const cookie = cookiesOf(first);

  const add = await app.inject({
    method: 'POST',
    url: `/api/favorites/${productId}`,
    headers: withCsrf(csrf, cookie),
  });
  expect(add.statusCode).toBe(200);

  return cookie;
}

const listOf = (cookie: string) =>
  app.inject({ method: 'GET', url: '/api/favorites', headers: { cookie } });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);

  // 5 in stock, 2 of them reserved by an order that waits for its payment: 3 are free. An order
  // keeps its product, so the product stays; the test database goes after the run
  buyer = await createUser();
  product = await createProduct({ price: 25.5, stock: 5 });
  await placeOrder(app, csrf, buyer, product, 'waiting', 2);
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id]);
  } finally {
    await stopApp();
  }
});

describe('GET /api/favorites', () => {
  it('returns an empty list to a new guest', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/favorites' });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  // the list used to fail with 500: its query left out reservedStock and the card stock was NaN
  it('lists a favorite product with its free units, not the raw stock', async () => {
    const cookie = await guestWithFavorite(product.id);

    const res = await listOf(cookie);

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].product).toMatchObject({ id: product.id, stock: 3 });
  });

  it('leaves out a product removed from the catalog after it went into the favorites', async () => {
    const removed = await createProduct({ price: 10 });
    const cookie = await guestWithFavorite(removed.id);
    await deleteProductFromCatalog(removed.id);

    const res = await listOf(cookie);

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });
});
