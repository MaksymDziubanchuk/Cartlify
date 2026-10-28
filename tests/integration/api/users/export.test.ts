import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';

import { accessCookie, signIn } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createChatThread,
  createFavorite,
  createLoginLog,
  createProduct,
  createReview,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { addShipment, placeOrder } from '../../../helpers/orders.js';

// GET /api/users/me/export: everything the shop keeps of the person, read with the rights of the
// person, as one file; once an hour

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];
const products: TestProduct[] = [];

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

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const exportOf = (cookie: string) =>
  app.inject({ method: 'GET', url: '/api/users/me/export', headers: cookie ? { cookie } : {} });

// a person with a bit of everything: an order, a favorite, a review, a chat, a login
async function personWithData(): Promise<{
  user: TestUser;
  orderId: number;
  product: TestProduct;
  productName: string;
}> {
  const user = await newUser({ name: 'Anna', phone: '+380501234567' });
  const productName = `Export mug ${user.id}`;
  const product = await createProduct({ stock: 5, name: productName });
  products.push(product);

  const orderId = await placeOrder(app, csrf, user, product, 'paid');
  await createFavorite(user.id, product.id);
  await createReview(user.id, product.id, { rating: 5, comment: 'Good mug' });
  await createChatThread(user.id, { type: 'bot' });
  await createLoginLog(user, new Date(Date.now() - 60_000));

  return { user, orderId, product, productName };
}

describe('GET /api/users/me/export', () => {
  it('gives the person a file of their data, read with their rights', async () => {
    const { user, orderId, product, productName } = await personWithData();
    // another person whose data must not be in it
    const other = await personWithData();

    const res = await exportOf(accessCookie(user));

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="cartlify-data-${user.id}.json"`,
    );
    const data = res.json();
    expect(data).toMatchObject({
      exportedAt: expect.any(String),
      profile: {
        id: user.id,
        email: user.email,
        name: 'Anna',
        phone: '+380501234567',
        role: 'USER',
      },
      orders: [
        expect.objectContaining({
          id: orderId,
          status: 'paid',
          delivery: expect.objectContaining({
            method: 'manual',
            recipientFirstName: 'Anna',
            recipientLastName: 'Koval',
            city: 'Kyiv',
            street: 'Test street',
            price: expect.any(String),
          }),
          shipments: [],
          items: [
            expect.objectContaining({ productId: product.id, name: productName, quantity: 1 }),
          ],
        }),
      ],
      favorites: [expect.objectContaining({ productId: product.id })],
      reviews: [expect.objectContaining({ productId: product.id, rating: 5, comment: 'Good mug' })],
      chats: [
        expect.objectContaining({
          type: 'bot',
          messages: [
            expect.objectContaining({ senderType: 'user', content: 'Where is my order?' }),
          ],
        }),
      ],
      logins: [expect.objectContaining({ createdAt: expect.any(String) })],
    });
    expect(Array.isArray(data.reviewVotes)).toBe(true);
    expect(Array.isArray(data.sessions)).toBe(true);
    expect(JSON.stringify(data)).not.toContain(other.user.email);
    // what is no data of the person stays out: the hash of the password, the id of the payment
    expect(JSON.stringify(data)).not.toMatch(/passwordHash|paymentId|pi_test_/);
  });

  it('gives the sends of an order with the carrier and the number, not what they cost the shop', async () => {
    const user = await newUser();
    const product = await createProduct({ stock: 5 });
    products.push(product);
    const orderId = await placeOrder(app, csrf, user, product, 'shipped');
    await addShipment(orderId, { carrier: 'DHL', trackingNumber: 'JD0146', cost: 7.35 });
    await addShipment(orderId, { carrier: 'UPS', cost: 9.1, rolledBack: true });

    const res = await exportOf(accessCookie(user));

    expect(res.json().orders[0].shipments).toEqual([
      {
        carrier: 'DHL',
        trackingNumber: 'JD0146',
        trackingUrl: null,
        shippedAt: expect.any(String),
        rolledBackAt: null,
      },
      {
        carrier: 'UPS',
        trackingNumber: null,
        trackingUrl: null,
        shippedAt: expect.any(String),
        rolledBackAt: expect.any(String),
      },
    ]);
    // what a send cost the shop is no data of the person: no key of it, whatever the amounts are
    expect(JSON.stringify(res.json())).not.toContain('"cost"');
    expect(JSON.stringify(res.json())).not.toContain('"expense"');
  });

  it('lists the sessions of the person with the browser of each', async () => {
    const user = await newUser();
    const session = await signIn(app, csrf, user);

    const res = await exportOf(`accessToken=${session.accessToken}`);

    expect(res.json().sessions).toEqual([
      { device: expect.any(String), lastUsedAt: expect.any(String), expiresAt: expect.any(String) },
    ]);
  });

  // the file reads every table of the person: a script asking for it in a loop loads the database
  it('gives the file once an hour', async () => {
    const user = await newUser();
    const scale = env.REQUEST_LIMITS_SCALE;
    env.REQUEST_LIMITS_SCALE = 1;

    try {
      expect((await exportOf(accessCookie(user))).statusCode).toBe(200);

      const again = await exportOf(accessCookie(user));
      expect(again.statusCode).toBe(429);
      expect(again.json()).toMatchObject({
        errorCode: 'RATE_LIMITED',
        details: { limit: 'export', retryAfterSeconds: expect.any(Number) },
      });
    } finally {
      env.REQUEST_LIMITS_SCALE = scale;
    }
  });

  it('refuses a guest', async () => {
    const res = await exportOf('');

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});
