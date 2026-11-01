import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { setAdminContext } from '@db/dbContext.service.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin, testTx } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  createVariant,
  putOnSale,
  type TestUser,
} from '../../../helpers/factories.js';
import { watchMail } from '../../../helpers/mail.js';
import {
  placeOrder,
  placeOrderOf,
  placeUnconfirmedOrder,
  shippingData,
} from '../../../helpers/orders.js';
import { lockVariantRow } from '../../../helpers/variants.js';

// the items of an order: an order that is not paid shows the sale of each variant next to its
// price, the way the catalog does; a confirmed order keeps the name each variant had when it was
// confirmed, the history and the mails show it after a rename. Two buyers of the last unit: the one
// who loses gets the items that cannot be had, as a confirm that comes later gets them

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];

const newUser = async () => {
  const user = await createUser();
  userIds.push(user.id);
  return user;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const orderOf = async (user: TestUser, orderId: number) =>
  (
    await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(user) },
    })
  ).json();

const rename = (productId: number, name: string) =>
  asAdmin((tx) => tx.product.update({ where: { id: productId }, data: { name } }));

describe('the sale of a variant in an order that is not paid', () => {
  it.each(['cart', 'waiting'] as const)('shows in an order of the %s', async (stage) => {
    const product = await createProduct({ price: 20, stock: 3 });
    await putOnSale(product.id, 15);
    const buyer = await newUser();
    const orderId = await placeOrder(app, csrf, buyer, product, stage);

    const [item] = (await orderOf(buyer, orderId)).items;

    expect(item.variant).toMatchObject({
      price: 20,
      salePrice: 15,
      saleEndsAt: expect.any(String),
    });
  });

  it('shows in an order that lost its reservation', async () => {
    const product = await createProduct({ price: 20, stock: 3 });
    await putOnSale(product.id, 15);
    const buyer = await newUser();
    const orderId = await placeUnconfirmedOrder(app, csrf, buyer, product);

    const [item] = (await orderOf(buyer, orderId)).items;

    expect(item.variant).toMatchObject({ price: 20, salePrice: 15 });
  });

  // the sale is a sale of one variant: its sibling in the same order sells at the regular price
  it('belongs to the variant that is on sale and not to its sibling in the same order', async () => {
    const product = await createProduct({ price: 20, stock: 3 });
    const sibling = await createVariant(product.id, { price: 30, stock: 3 });
    await putOnSale({ variantId: product.variantId }, 15);
    const buyer = await newUser();
    const orderId = await placeOrderOf(
      app,
      csrf,
      buyer,
      [{ item: product }, { item: { variantId: sibling.id } }],
      'waiting',
    );

    const items = (await orderOf(buyer, orderId)).items;

    expect(items[0]).toMatchObject({ unitPrice: 15, variant: { price: 20, salePrice: 15 } });
    expect(items[1]).toMatchObject({ unitPrice: 30, variant: { price: 30 } });
    expect(items[1].variant).not.toHaveProperty('salePrice');
  });

  // a paid order shows what it was paid at, the sale of now is no matter to it
  it('is left out of a paid order', async () => {
    const product = await createProduct({ price: 20, stock: 3 });
    const buyer = await newUser();
    const orderId = await placeOrder(app, csrf, buyer, product, 'paid');
    await putOnSale(product.id, 15);

    const [item] = (await orderOf(buyer, orderId)).items;

    expect(item.variant).not.toHaveProperty('salePrice');
    // the variant shows the price the order was paid at, not the price of now
    expect(item.variant.price).toBe(20);
    expect(item.unitPrice).toBe(20);
  });
});

describe('the name of the item', () => {
  it('stays the name the product had when the order was confirmed', async () => {
    const product = await createProduct({ price: 20, stock: 3, name: 'Phone X 128GB' });
    const buyer = await newUser();
    const orderId = await placeOrder(app, csrf, buyer, product, 'paid');
    await rename(product.id, 'Phone X 256GB');

    const [item] = (await orderOf(buyer, orderId)).items;

    expect(item.variant.name).toBe('Phone X 128GB');
    const row = await asAdmin((tx) =>
      tx.orderItem.findFirstOrThrow({ where: { orderId }, select: { productName: true } }),
    );
    expect(row.productName).toBe('Phone X 128GB');
  });

  it('follows the product while the order is not confirmed', async () => {
    const product = await createProduct({ price: 20, stock: 3, name: 'Lamp A' });
    const buyer = await newUser();
    const orderId = await placeOrder(app, csrf, buyer, product, 'cart');
    await rename(product.id, 'Lamp B');

    const [item] = (await orderOf(buyer, orderId)).items;

    expect(item.variant.name).toBe('Lamp B');
  });

  it('is the one the mail of a shipped order names', async () => {
    const product = await createProduct({ price: 20, stock: 3, name: 'Kettle Old' });
    const buyer = await newUser();
    const orderId = await placeOrder(app, csrf, buyer, product, 'paid');
    await rename(product.id, 'Kettle New');
    const mails = watchMail();

    await app.inject({
      method: 'PATCH',
      url: `/api/orders/${orderId}/status`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { status: 'shipped' },
    });

    expect(mails[0]!.text).toContain('Kettle Old');
    expect(mails[0]!.text).not.toContain('Kettle New');
  });
});

describe('POST /api/orders/current/confirm and the last unit', () => {
  const addToCart = (user: TestUser, variantId: number) =>
    app.inject({
      method: 'POST',
      url: '/api/orders/current/items',
      headers: withCsrf(csrf, accessCookie(user)),
      payload: { variantId, quantity: 1 },
    });

  const confirm = (user: TestUser, orderId: number) =>
    app.inject({
      method: 'POST',
      url: '/api/orders/current/confirm',
      headers: withCsrf(csrf, accessCookie(user)),
      payload: { orderId, ...shippingData },
    });

  // both buyers find the unit free; the product row is held a moment, so both get to the reserve
  // and the one who waits finds it taken
  it('gives the buyer who loses it the item that cannot be had', async () => {
    const product = await createProduct({ price: 20, stock: 1 });
    const buyers = [await newUser(), await newUser()];
    const orders: number[] = [];
    for (const buyer of buyers) orders.push((await addToCart(buyer, product.variantId)).json().id);

    const held = testTx(
      async (tx) => {
        await setAdminContext(tx);
        await lockVariantRow(tx, product.variantId);
        await new Promise((resolve) => setTimeout(resolve, 700));
      },
      { timeout: 5_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const answers = await Promise.all(buyers.map((buyer, i) => confirm(buyer, orders[i]!)));
    await held;

    expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    const lost = answers.find((res) => res.statusCode === 409)!;
    expect(lost.json()).toMatchObject({
      errorCode: 'ORDER_ITEMS_UNAVAILABLE',
      details: {
        items: [
          { variantId: product.variantId, reason: 'out_of_stock', available: 0, requested: 1 },
        ],
      },
    });
  });
});
