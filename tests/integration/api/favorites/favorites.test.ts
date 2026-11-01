import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  createVariant,
  deleteProductFromCatalog,
  putOnSale,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';

// GET /api/favorites: the favorite variants of a guest or a user, each with its product. A variant a
// buyer does not see (taken out of sale, without a picture, of a product taken out of the catalog)
// stays among the favorites in the database and is left out of the list

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

// a new guest with the variant among its favorites
async function guestWithFavorite(variantId: number) {
  const first = await app.inject({ method: 'GET', url: '/api/favorites' });
  const cookie = cookiesOf(first);

  await addAs(cookie, variantId);

  return cookie;
}

async function addAs(cookie: string, variantId: number) {
  const add = await app.inject({
    method: 'POST',
    url: `/api/favorites/${variantId}`,
    headers: withCsrf(csrf, cookie),
  });
  expect(add.statusCode).toBe(200);
}

const listOf = (cookie: string) =>
  app.inject({ method: 'GET', url: '/api/favorites', headers: { cookie } });

type Row = {
  product: { id: number; name: string; popularity: number };
  variant: { id: number; position: number; stock: number; price: number; image: unknown };
  addedAt: string;
};

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

  // the list used to fail with 500: its query left out reservedStock and the stock was NaN
  it('lists a favorite as its product and its variant, with the free units, not the raw stock', async () => {
    const cookie = await guestWithFavorite(product.variantId);

    const res = await listOf(cookie);

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    const row = res.json().items[0] as Row;
    expect(row.product).toMatchObject({ id: product.id, popularity: expect.any(Number) });
    expect(row.variant).toMatchObject({
      id: product.variantId,
      position: 1,
      price: 25.5,
      stock: 3,
      image: { url200: expect.any(String), url400: expect.any(String), url800: expect.any(String) },
    });
    expect(row.addedAt).toEqual(expect.any(String));
    // the variant of a buyer is the short one: no article number, no shipping data, no stock figures
    expect(Object.keys(row.variant)).not.toEqual(
      expect.arrayContaining(['sku', 'totalStock', 'reservedStock']),
    );
  });

  // a favorite is a variant: a person who likes two variants of one product has two rows
  it('lists two variants of one product as two rows, the one added last first', async () => {
    const own = await createProduct({ price: 10, stock: 4 });
    const second = await createVariant(own.id, { price: 12, stock: 2 });
    const cookie = await guestWithFavorite(own.variantId);
    await addAs(cookie, second.id);

    const res = await listOf(cookie);

    const rows = res.json().items as Row[];
    expect(
      rows.map((r) => [r.product.id, r.variant.id, r.variant.position, r.variant.price]),
    ).toEqual([
      [own.id, second.id, 2, 12],
      [own.id, own.variantId, 1, 10],
    ]);
    expect(rows.map((r) => r.variant.stock)).toEqual([2, 4]);
  });

  it('leaves out a product removed from the catalog after it went into the favorites', async () => {
    const removed = await createProduct({ price: 10 });
    const cookie = await guestWithFavorite(removed.variantId);
    await deleteProductFromCatalog(removed.id);

    const res = await listOf(cookie);

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  // the favorite stays in the table: the variant comes back into the list with its pictures
  it('leaves out a variant taken out of sale or without a picture, and shows it again when it is back', async () => {
    const own = await createProduct({ price: 10 });
    const other = await createVariant(own.id, { price: 11 });
    const cookie = await guestWithFavorite(own.variantId);
    await addAs(cookie, other.id);

    await asAdmin((tx) =>
      tx.productVariant.update({ where: { id: other.id }, data: { deletedAt: new Date() } }),
    );
    expect(((await listOf(cookie)).json().items as Row[]).map((r) => r.variant.id)).toEqual([
      own.variantId,
    ]);

    await asAdmin((tx) =>
      tx.productVariant.update({ where: { id: other.id }, data: { deletedAt: null } }),
    );
    await asAdmin((tx) => tx.variantImage.deleteMany({ where: { variantId: own.variantId } }));
    expect(((await listOf(cookie)).json().items as Row[]).map((r) => r.variant.id)).toEqual([
      other.id,
    ]);

    // both are still favorites of the guest
    expect(
      await asAdmin((tx) =>
        tx.favorite.count({ where: { variantId: { in: [own.variantId, other.id] } } }),
      ),
    ).toBe(2);
  });

  it('shows the sale of a variant while it lasts', async () => {
    const own = await createProduct({ price: 20, stock: 6 });
    const cookie = await guestWithFavorite(own.variantId);
    await putOnSale({ variantId: own.variantId }, 15);

    const row = (await listOf(cookie)).json().items[0] as Row & {
      variant: { salePrice: number; saleEndsAt: string };
    };

    expect(row.variant).toMatchObject({ price: 20, salePrice: 15, stock: 6 });
    expect(row.variant.saleEndsAt).toEqual(expect.any(String));
  });
});

describe('DELETE /api/favorites/:variantId', () => {
  it('takes a variant out of the favorites of a guest', async () => {
    const own = await createProduct({ price: 10 });
    const cookie = await guestWithFavorite(own.variantId);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/favorites/${own.variantId}`,
      headers: withCsrf(csrf, cookie),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ variantId: own.variantId, isFavorite: false });
    expect((await listOf(cookie)).json().items).toEqual([]);
  });

  // a second click of the heart: the same answer, nothing breaks
  it('answers the same for a variant that is not among the favorites', async () => {
    const cookie = await guestWithFavorite(product.variantId);
    const other = await createProduct({ price: 10 });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/favorites/${other.variantId}`,
      headers: withCsrf(csrf, cookie),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ variantId: other.variantId, isFavorite: false });
    expect((await listOf(cookie)).json().items).toHaveLength(1);
  });

  // the other variant of the same product stays a favorite
  it('takes out the variant named and leaves another variant of its product', async () => {
    const own = await createProduct({ price: 10 });
    const second = await createVariant(own.id, { price: 12 });
    const cookie = await guestWithFavorite(own.variantId);
    await addAs(cookie, second.id);

    await app.inject({
      method: 'DELETE',
      url: `/api/favorites/${own.variantId}`,
      headers: withCsrf(csrf, cookie),
    });

    expect(((await listOf(cookie)).json().items as Row[]).map((r) => r.variant.id)).toEqual([
      second.id,
    ]);
  });

  it('leaves the favorite of another guest alone', async () => {
    const shared = await createProduct({ price: 10 });
    const owner = await guestWithFavorite(shared.variantId);
    const stranger = await guestWithFavorite(product.variantId);

    await app.inject({
      method: 'DELETE',
      url: `/api/favorites/${shared.variantId}`,
      headers: withCsrf(csrf, stranger),
    });

    expect(((await listOf(owner)).json().items as Row[]).map((row) => row.variant.id)).toEqual([
      shared.variantId,
    ]);
  });
});
