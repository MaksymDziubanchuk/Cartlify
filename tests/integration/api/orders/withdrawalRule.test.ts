import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { sendOrderPaidEmail } from '@routes/api/payments/services/helpers/sendOrderPaidEmail.helper.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { watchMail } from '../../../helpers/mail.js';
import { deliveryBody, placeOrderOf, quotedDeliveryPrice } from '../../../helpers/orders.js';

// the rule of withdrawal in the items of an order: a cart shows the rule of the product as it is
// now, the confirmation fixes the rule of that moment and the order keeps it whatever an admin
// changes after. The mail of the payment names the goods that are not taken back and the ones that
// are taken back only while sealed

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const newBuyer = async () => {
  const user = await createUser({ name: 'Anna' });
  userIds.push(user.id);
  return user;
};

const newProduct = async (opts: Parameters<typeof createProduct>[0] = {}) => {
  const product = await createProduct({ price: 10, stock: 5, ...opts });
  products.push(product);
  return product;
};

const setCategoryRule = (categoryId: number, withdrawal: string | null) =>
  asAdmin((tx) =>
    tx.category.update({
      where: { id: categoryId },
      data: { withdrawal: withdrawal as never },
    }),
  );

const read = async (orderId: number, actor: TestUser) => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/orders/${orderId}`,
    headers: { cookie: accessCookie(actor) },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
};

const rulesOf = (order: { items: Array<{ product: { id: number }; withdrawal: unknown }> }) =>
  Object.fromEntries(order.items.map((item) => [item.product.id, item.withdrawal]));

describe('the rule of withdrawal in the items of a cart', () => {
  it('is the rule of the product with its kind, and follows the rule as it changes', async () => {
    const category = await createCategory();
    const buyer = await newBuyer();
    const product = await newProduct({ categoryId: category.id });
    const cartId = await placeOrderOf(app, csrf, buyer, [{ item: product }], 'cart');

    const before = await read(cartId, buyer);
    await setCategoryRule(category.id, 'sealed_hygiene');
    const after = await read(cartId, buyer);

    expect(rulesOf(before)).toEqual({ [product.id]: { rule: 'allowed', right: 'full' } });
    expect(rulesOf(after)).toEqual({
      [product.id]: { rule: 'sealed_hygiene', right: 'conditional' },
    });
  });

  it('is in the answer of an item put in and changed, and in the admin view of the order', async () => {
    const buyer = await newBuyer();
    const product = await newProduct({ withdrawal: 'perishable' });
    const cartId = await placeOrderOf(app, csrf, buyer, [{ item: product }], 'cart');

    const adminView = await read(cartId, admin);

    expect(rulesOf(await read(cartId, buyer))).toEqual({
      [product.id]: { rule: 'perishable', right: 'none' },
    });
    expect(rulesOf(adminView)).toEqual({ [product.id]: { rule: 'perishable', right: 'none' } });
  });
});

describe('the rule of withdrawal an order keeps', () => {
  it('is the rule at the confirmation, and stays when the product or its category changes after', async () => {
    const category = await createCategory({ withdrawal: 'sealed_media' });
    const buyer = await newBuyer();
    const followed = await newProduct({ categoryId: category.id });
    const own = await newProduct({ withdrawal: 'perishable' });

    const orderId = await placeOrderOf(
      app,
      csrf,
      buyer,
      [{ item: followed }, { item: own }],
      'waiting',
    );
    await setCategoryRule(category.id, 'periodical');
    await asAdmin((tx) =>
      tx.product.update({ where: { id: own.id }, data: { withdrawal: 'allowed' } }),
    );

    const order = await read(orderId, buyer);

    expect(rulesOf(order)).toEqual({
      [followed.id]: { rule: 'sealed_media', right: 'conditional' },
      [own.id]: { rule: 'perishable', right: 'none' },
    });
  });

  it('is the rule of the moment of the confirmation, whatever the cart showed before', async () => {
    const category = await createCategory({ withdrawal: 'mixed' });
    const buyer = await newBuyer();
    const product = await newProduct({ categoryId: category.id });
    const cartId = await placeOrderOf(app, csrf, buyer, [{ item: product }], 'cart');
    const shown = await read(cartId, buyer);

    await setCategoryRule(category.id, 'sealed_hygiene');
    const confirmed = await app.inject({
      method: 'POST',
      url: '/api/orders/current/confirm',
      headers: withCsrf(csrf, accessCookie(buyer)),
      payload: {
        orderId: cartId,
        delivery: deliveryBody,
        expectedDeliveryPrice: quotedDeliveryPrice(shown),
      },
    });

    expect(rulesOf(shown)).toEqual({ [product.id]: { rule: 'mixed', right: 'conditional' } });
    expect(confirmed.statusCode).toBe(200);
    expect(rulesOf(confirmed.json())).toEqual({
      [product.id]: { rule: 'sealed_hygiene', right: 'conditional' },
    });
  });
});

describe('the mail of the payment and the right of withdrawal', () => {
  const mailOf = async (rules: Array<'allowed' | 'perishable' | 'sealed_media'>) => {
    const buyer = await newBuyer();
    const items = await Promise.all(
      rules.map((withdrawal) => newProduct({ withdrawal, name: `Goods of ${withdrawal}` })),
    );
    const orderId = await placeOrderOf(
      app,
      csrf,
      buyer,
      items.map((item) => ({ item })),
      'paid',
    );
    const mails = watchMail();

    await sendOrderPaidEmail(orderId, { warn: () => undefined, error: () => undefined });

    const own = mails.filter((mail) => mail.to.includes(buyer.email));
    expect(own).toHaveLength(1);
    return own[0]!.text;
  };

  it('names the goods that are not taken back and the ones taken back only while sealed', async () => {
    const text = await mailOf(['allowed', 'perishable', 'sealed_media']);

    expect(text).toContain('No right of withdrawal applies to these goods:');
    expect(text).toContain('- Goods of perishable: goods that spoil or expire quickly');
    expect(text).toContain('You may withdraw from these goods only while the condition holds:');
    expect(text).toContain('- Goods of sealed_media: sealed audio or video recordings');
    expect(text).not.toContain('- Goods of allowed:');
  });

  // the mail offers the withdrawal itself (its link and days), but names no limit of it
  it('names no limit of the right when every item is taken back freely', async () => {
    const text = await mailOf(['allowed']);

    expect(text).toContain('You may withdraw from the contract without giving a reason');
    for (const part of [
      'No right of withdrawal',
      'only while the condition holds',
      'Goods of allowed:',
    ]) {
      expect(text).not.toContain(part);
    }
  });
});
