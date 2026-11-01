import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createFavorite,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  putOnSale,
  waitForSalesEnd,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { shippingData } from '../../../helpers/orders.js';

// What a sale does outside the products routes: the sort and the filters of the catalog and the
// price of a row, the favorites, the price of a cart and of a confirmation. The sale is the
// variant's. These cases belong to the packages that convert the list (3), the orders (5) and the
// favorites (6) to variants: they read the answers of those routes in the form of the variants
// ({ product, variant } rows, a cart of variants), so they stay red until those packages land.
// Products with a log of prices cannot be deleted: the products of the file stay

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];
const products: TestProduct[] = [];

const DAY = 86_400_000;
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

async function newProduct(price = 20) {
  const product = await createProduct({ price, stock: 50 });
  products.push(product);
  return product;
}

async function newUser() {
  const user = await createUser();
  userIds.push(user.id);
  return user;
}

let admin: TestUser;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);
});

afterAll(async () => {
  try {
    for (const product of products) await deleteProductFromCatalog(product.id);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const patchSale = (productId: number, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}/sale`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload,
  });

const listProducts = (query: Record<string, string>) =>
  app.inject({ method: 'GET', url: `/api/products?${new URLSearchParams(query)}` });

// the variants of the rows of a list
const variantIdsOf = (res: LightMyRequestResponse) =>
  (res.json().items as Array<{ variant: { id: number } }>).map((item) => item.variant.id);

const addToCart = (user: TestUser, variantId: number, quantity = 1) =>
  app.inject({
    method: 'POST',
    url: '/api/orders/current/items',
    headers: withCsrf(csrf, accessCookie(user)),
    payload: { variantId, quantity },
  });

const confirm = (user: TestUser, orderId: number) =>
  app.inject({
    method: 'POST',
    url: '/api/orders/current/confirm',
    headers: withCsrf(csrf, accessCookie(user)),
    payload: { orderId, ...shippingData },
  });

describe('a sale in the catalog and the favorites', () => {
  let onSale: TestProduct;
  let endsAt: string;

  beforeAll(async () => {
    onSale = await newProduct(20);
    endsAt = inMs(DAY);
    const res = await patchSale(onSale.id, { sale: { percent: 25, endsAt } });
    if (res.statusCode !== 200) throw new Error(`the sale route answered ${res.statusCode}`);
  });

  it('shows the sale in the catalog', async () => {
    const res = await listProducts({ categoryIds: String(onSale.categoryId) });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      expect.objectContaining({
        product: expect.objectContaining({ id: onSale.id }),
        variant: expect.objectContaining({
          id: onSale.variantId,
          price: 20,
          salePrice: 15,
          saleEndsAt: endsAt,
        }),
      }),
    ]);
  });

  it('shows the sale in the favorites', async () => {
    const user = await newUser();
    await createFavorite(user.id, onSale.id);

    const res = await app.inject({
      method: 'GET',
      url: '/api/favorites',
      headers: { cookie: accessCookie(user) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      expect.objectContaining({
        product: expect.objectContaining({ id: onSale.id }),
        variant: expect.objectContaining({
          id: onSale.variantId,
          salePrice: 15,
          saleEndsAt: endsAt,
        }),
      }),
    ]);
  });

  it('shows the lowest price of the 30 days before the sale in the catalog', async () => {
    const product = await newProduct(20);
    await patchSale(product.id, { sale: { percent: 50, endsAt: inMs(DAY) } });

    const res = await listProducts({ categoryIds: String(product.categoryId) });

    expect(res.json().items).toEqual([
      expect.objectContaining({
        variant: expect.objectContaining({ salePrice: 10, salePriorPrice: 20 }),
      }),
    ]);
  });
});

describe('GET /api/products and the price a variant sells at', () => {
  let cheap: TestProduct;
  let onSale: TestProduct;
  let middle: TestProduct;
  let categoryIds: string;

  beforeAll(async () => {
    cheap = await newProduct(10);
    onSale = await newProduct(30);
    middle = await newProduct(20);
    await putOnSale(onSale.id, 5);
    categoryIds = [cheap, onSale, middle].map((product) => product.categoryId).join(',');
  });

  it.each([
    ['asc', () => [onSale.variantId, cheap.variantId, middle.variantId]],
    ['desc', () => [middle.variantId, cheap.variantId, onSale.variantId]],
  ])('sorts by it going %s', async (order, ids) => {
    const res = await listProducts({ categoryIds, sort: 'price', order });

    expect(res.statusCode).toBe(200);
    expect(variantIdsOf(res)).toEqual(ids());
  });

  it('filters by it', async () => {
    const below = await listProducts({ categoryIds, maxPrice: '8' });
    const above = await listProducts({ categoryIds, minPrice: '25' });

    expect(variantIdsOf(below)).toEqual([onSale.variantId]);
    expect(variantIdsOf(above)).toEqual([]);
  });

  it('sorts and filters a search by it', async () => {
    const res = await listProducts({
      categoryIds,
      search: 'Test product',
      sort: 'price',
      order: 'asc',
      maxPrice: '15',
    });

    expect(res.statusCode).toBe(200);
    expect(variantIdsOf(res)).toEqual([onSale.variantId, cheap.variantId]);
  });

  it('pages through a sort by it', async () => {
    const seen: number[] = [];
    let cursor: string | undefined;

    do {
      const res = await listProducts({
        categoryIds,
        sort: 'price',
        order: 'asc',
        limit: '1',
        ...(cursor ? { cursor } : {}),
      });
      expect(res.statusCode).toBe(200);
      seen.push(...variantIdsOf(res));
      cursor = res.json().nextCursor;
    } while (cursor && seen.length < 10);

    expect(seen).toEqual([onSale.variantId, cheap.variantId, middle.variantId]);
  });
});

describe('the cart and a sale', () => {
  it('takes the sale price for an item', async () => {
    const user = await newUser();
    const product = await newProduct(20);
    await putOnSale(product.id, 15);

    const res = await addToCart(user, product.variantId, 2);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      total: 30,
      items: [expect.objectContaining({ unitPrice: 15, totalPrice: 30 })],
    });
  });

  it('confirms an order at the sale price', async () => {
    const user = await newUser();
    const product = await newProduct(20);
    await putOnSale(product.id, 15);
    const added = await addToCart(user, product.variantId, 2);

    const res = await confirm(user, added.json().id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'waiting', total: 30 });
  });

  // the smallest payment is checked at the price the order is confirmed with
  it('refuses a total below the smallest payment at the sale price', async () => {
    const user = await newUser();
    const product = await newProduct(1);
    await putOnSale(product.id, 0.1);
    const added = await addToCart(user, product.variantId, 1);

    const res = await confirm(user, added.json().id);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_TOTAL_BELOW_MINIMUM' });
  });

  // a free variant is bought together with something that costs the smallest payment
  it('confirms a free item next to a paid one', async () => {
    const user = await newUser();
    const free = await newProduct(10);
    const paid = await newProduct(1);
    await putOnSale(free.id, 0);
    await addToCart(user, free.variantId, 1);
    const added = await addToCart(user, paid.variantId, 1);

    const res = await confirm(user, added.json().id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'waiting', total: 1 });
  });

  it('refuses an order of a free item alone', async () => {
    const user = await newUser();
    const free = await newProduct(10);
    await putOnSale(free.id, 0);
    const added = await addToCart(user, free.variantId, 1);

    const res = await confirm(user, added.json().id);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_TOTAL_BELOW_MINIMUM' });
  });
});

// sales that end a moment after they start: the tests wait for the end by both clocks, the one of
// the database that prices the orders and the one of the app that answers
describe('a sale past its end', () => {
  const ENDS_IN_MS = 1_500;
  let listed: TestProduct;
  let carted: TestProduct;
  let buyer: TestUser;
  let orderId: number;

  beforeAll(async () => {
    listed = await newProduct(20);
    carted = await newProduct(20);
    for (const product of [listed, carted]) await putOnSale(product.id, 15, ENDS_IN_MS);

    // an item put in the cart while the sale was on, at the sale price
    buyer = await newUser();
    const added = await addToCart(buyer, carted.variantId, 1);
    if (added.json().items?.[0]?.unitPrice !== 15) {
      throw new Error('the cart did not take the sale price before the end of the sale');
    }
    orderId = added.json().id;

    await waitForSalesEnd([listed.id, carted.id]);
  });

  it('sorts and filters the catalog by the price again', async () => {
    const atSalePrice = await listProducts({
      categoryIds: String(listed.categoryId),
      maxPrice: '16',
    });
    const atPrice = await listProducts({ categoryIds: String(listed.categoryId), maxPrice: '20' });

    expect(variantIdsOf(atSalePrice)).toEqual([]);
    expect(variantIdsOf(atPrice)).toEqual([listed.variantId]);
    expect(atPrice.json().items[0].variant).not.toHaveProperty('salePrice');
  });

  it('refuses to confirm an item at the sale price, the cart then shows the price', async () => {
    const res = await confirm(buyer, orderId);
    const cart = await app.inject({
      method: 'GET',
      url: '/api/orders/current',
      headers: { cookie: accessCookie(buyer) },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_PRICES_CHANGED' });
    expect(cart.json()).toMatchObject({
      total: 20,
      items: [expect.objectContaining({ unitPrice: 20 })],
    });
  });
});
