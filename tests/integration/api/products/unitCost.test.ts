import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  receiveBatch,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';

// the cost of a unit in the latest delivery of a supplier (lastUnitCost): an admin sees it next to
// the price in the card and the list of products and in the answers of the changes of a product,
// to set a price or a sale against it. A surplus an inventory found or goods a buyer brought back
// are no purchase; a buyer never sees it

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;

const DAY = 86_400_000;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
});

afterAll(async () => {
  try {
    await closeSessions([admin.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

const cardOf = (productId: number, actor?: TestUser) =>
  app.inject({
    method: 'GET',
    url: `/api/products/${productId}`,
    headers: actor ? { cookie: accessCookie(actor) } : {},
  });

const listOf = (categoryId: number, actor?: TestUser) =>
  app.inject({
    method: 'GET',
    url: `/api/products?categoryIds=${categoryId}&limit=100`,
    headers: actor ? { cookie: accessCookie(actor) } : {},
  });

const send = (method: 'PATCH' | 'POST', url: string, payload?: Record<string, unknown>) =>
  app.inject({
    method,
    url,
    headers: withCsrf(csrf, accessCookie(admin)),
    ...(payload ? { payload } : {}),
  });

// a product with no batch yet, then the deliveries of the test
const productWithDeliveries = async (
  deliveries: Array<{ unitCost: number; source?: 'supplier' | 'surplus' | 'customer_return' }>,
  categoryId?: number,
) => {
  const product = await createProduct({
    price: 30,
    stock: 0,
    ...(categoryId ? { categoryId } : {}),
  });
  for (const delivery of deliveries) await receiveBatch(product.id, { quantity: 1, ...delivery });
  return product;
};

describe('the cost of the latest delivery of a supplier', () => {
  it('shows in the card of an admin, a surplus or a return after it change nothing', async () => {
    const product = await productWithDeliveries([
      { unitCost: 12.5 },
      { unitCost: 14 },
      { unitCost: 0, source: 'surplus' },
      { unitCost: 3, source: 'customer_return' },
    ]);

    const res = await cardOf(product.id, admin);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: product.id, price: 30, lastUnitCost: 14 });
  });

  it('is null for a product no supplier delivered', async () => {
    const bare = await productWithDeliveries([]);
    const found = await productWithDeliveries([{ unitCost: 2, source: 'surplus' }]);

    for (const product of [bare, found]) {
      const res = await cardOf(product.id, admin);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: product.id, lastUnitCost: null });
    }
  });

  it('never shows to a buyer or a guest', async () => {
    const { id: categoryId } = await createCategory();
    const product = await productWithDeliveries([{ unitCost: 9 }], categoryId);

    for (const actor of [buyer, undefined]) {
      const card = await cardOf(product.id, actor);
      const list = await listOf(categoryId, actor);

      expect(card.statusCode).toBe(200);
      expect(card.json()).not.toHaveProperty('lastUnitCost');
      expect(list.statusCode).toBe(200);
      expect(list.json().items).toHaveLength(1);
      expect(list.json().items[0]).not.toHaveProperty('lastUnitCost');
    }
  });

  it('shows in the list of an admin, null for a product no supplier delivered', async () => {
    const { id: categoryId } = await createCategory();
    const delivered = await productWithDeliveries(
      [{ unitCost: 7.25 }, { unitCost: 8.1 }],
      categoryId,
    );
    const bare = await productWithDeliveries([], categoryId);

    const res = await listOf(categoryId, admin);

    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ id: number; lastUnitCost: number | null }>;
    expect(new Map(items.map((item) => [item.id, item.lastUnitCost]))).toEqual(
      new Map([
        [delivered.id, 8.1],
        [bare.id, null],
      ]),
    );
  });

  it.each([
    [
      'a change of the product',
      async (id: number) =>
        send('PATCH', `/api/products/${id}`, { name: `Renamed ${uniqueTag()}` }),
    ],
    [
      'a sale',
      async (id: number) =>
        send('PATCH', `/api/products/${id}/sale`, { sale: { percent: 10, endsAt: inMs(DAY) } }),
    ],
    [
      'a move to another category',
      async (id: number) =>
        send('PATCH', `/api/products/${id}/category`, {
          categoryId: (await createCategory()).id,
        }),
    ],
    [
      'a restore',
      async (id: number) => {
        await deleteProductFromCatalog(id);
        return send('POST', `/api/products/${id}/restore`);
      },
    ],
  ])('comes with the answer of %s', async (_, change) => {
    const product = await productWithDeliveries([{ unitCost: 11.4 }]);

    const res = await change(product.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: product.id, lastUnitCost: 11.4 });
  });
});
