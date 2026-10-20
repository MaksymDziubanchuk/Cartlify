import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { closeRedis, connectRedis } from '@redis/client.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  type TestProduct,
} from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { loseReservation, orderRowOf, placeOrder } from '../../../helpers/orders.js';
import {
  CHECKOUT_URL,
  checkout,
  confirmInDatabase,
  orderStateOf,
  redisStateOf,
} from '../../../helpers/payments.js';
import {
  closeOpenSessions,
  describeWithStripe,
  readSession,
  rememberSession,
  stripeRequestsDuring,
  withStripeOutOfReach,
} from '../../../helpers/stripe.js';

// POST /api/payments/checkout/sessions: the buyer of an order waiting for its payment gets a payment
// page for it at the provider the request names; there is no main provider. The server pays with
// Stripe for now: its page is opened for real (the test sandbox); the refusals before Stripe run
// without the key too. The payment itself and its webhook are in webhook*.test.ts

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];
// an order keeps its product, so these products stay; the test database goes after the run
const products: TestProduct[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const newProduct = async (opts: { price?: number; stock?: number } = {}) => {
  const product = await createProduct({ price: 25.5, stock: 5, ...opts });
  products.push(product);
  return product;
};

// a buyer with an order waiting for its payment
async function waitingOrder(opts: { price?: number; quantity?: number } = {}) {
  const user = await newUser();
  const product = await newProduct(opts.price !== undefined ? { price: opts.price } : {});
  const orderId = await placeOrder(app, csrf, user, product, 'waiting', opts.quantity ?? 2);
  return { user, product, orderId };
}

// an order of the price confirmed before the confirm route refused a total below the smallest
// payment: it may still wait for its payment on dev or prod
async function oldWaitingOrder(price: number) {
  const user = await newUser();
  const orderId = await placeOrder(app, csrf, user, await newProduct({ price }), 'cart');
  await confirmInDatabase(user, orderId);
  return { user, orderId };
}

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterAll(async () => {
  try {
    await closeOpenSessions();
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('POST /api/payments/checkout/sessions', () => {
  describe('refuses before Stripe', () => {
    // a request without a session is a guest, the way every route of a buyer answers one
    it('answers INSUFFICIENT_ROLE to a guest', async () => {
      const res = await app.inject({
        method: 'POST',
        url: CHECKOUT_URL,
        headers: withCsrf(csrf),
        payload: { orderId: 1, provider: 'stripe' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    });

    it('answers CSRF_TOKEN_INVALID without the csrf header', async () => {
      const { user, orderId } = await waitingOrder();

      const res = await app.inject({
        method: 'POST',
        url: CHECKOUT_URL,
        headers: { cookie: accessCookie(user) },
        payload: { orderId, provider: 'stripe' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'CSRF_TOKEN_INVALID' });
      expect((await redisStateOf(orderId)).pageLink).toBeNull();
    });

    // the shop sells to buyers; an admin or root account has no orders of its own to pay
    it.each(['ADMIN', 'ROOT'] as const)('answers INSUFFICIENT_ROLE to %s', async (role) => {
      const res = await checkout(app, csrf, await newUser({ role }), 1);

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    });

    it('answers VALIDATION_ERROR without the order id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: CHECKOUT_URL,
        headers: withCsrf(csrf, accessCookie(await newUser())),
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    });

    // there is no main provider: the buyer always names the one to pay with
    it('answers VALIDATION_ERROR without the provider and opens no page', async () => {
      const { user, orderId } = await waitingOrder();

      const res = await app.inject({
        method: 'POST',
        url: CHECKOUT_URL,
        headers: withCsrf(csrf, accessCookie(user)),
        payload: { orderId },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
      expect((await redisStateOf(orderId)).pageLink).toBeNull();
    });

    // the database knows liqpay already, this server takes no payments through it yet
    it.each(['liqpay', 'paypal', 'Stripe', '', 1])(
      'answers VALIDATION_ERROR for the provider %p',
      async (provider) => {
        const res = await checkout(app, csrf, await newUser(), 1, provider);

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
      },
    );

    // the largest id Postgres keeps is 2147483647: a bigger one is no order, not a server failure
    it.each([0, -1, 1.5, 'abc', 2_147_483_648])(
      'answers VALIDATION_ERROR for the order id %p',
      async (orderId) => {
        const res = await checkout(app, csrf, await newUser(), orderId);

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
      },
    );

    it('answers ORDER_NOT_FOUND for the largest order id', async () => {
      const res = await checkout(app, csrf, await newUser(), 2_147_483_647);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
    });

    it('answers ORDER_NOT_FOUND for an order that does not exist', async () => {
      const res = await checkout(app, csrf, await newUser(), 2_000_000_000);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
    });

    it('answers ORDER_NOT_FOUND for the order of another user and opens no page', async () => {
      const { orderId } = await waitingOrder();

      const res = await checkout(app, csrf, await newUser(), orderId);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
      expect((await redisStateOf(orderId)).pageLink).toBeNull();
    });

    it('answers ORDER_NOT_CONFIRMED for a cart', async () => {
      const user = await newUser();
      const orderId = await placeOrder(app, csrf, user, await newProduct(), 'cart');

      const res = await checkout(app, csrf, user, orderId);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_CONFIRMED' });
    });

    it('answers ORDER_NOT_CONFIRMED for an order that lost its reservation', async () => {
      const { user, orderId } = await waitingOrder();
      await loseReservation(orderId);

      const res = await checkout(app, csrf, user, orderId);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_CONFIRMED' });
    });

    it('answers ORDER_ALREADY_PAID for a paid order', async () => {
      const user = await newUser();
      const orderId = await placeOrder(app, csrf, user, await newProduct(), 'paid');

      const res = await checkout(app, csrf, user, orderId);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'ORDER_ALREADY_PAID' });
    });

    it('answers ORDER_STATUS_NOT_WAITING for a shipped order', async () => {
      const user = await newUser();
      const orderId = await placeOrder(app, csrf, user, await newProduct(), 'shipped');

      const res = await checkout(app, csrf, user, orderId);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'ORDER_STATUS_NOT_WAITING' });
    });

    it('answers ORDER_RESERVATION_EXPIRED once the reservation is over', async () => {
      const user = await newUser();
      const orderId = await placeOrder(app, csrf, user, await newProduct(), 'cart');
      await confirmInDatabase(user, orderId, { endedReservation: true });

      const res = await checkout(app, csrf, user, orderId);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'ORDER_RESERVATION_EXPIRED' });
      expect((await redisStateOf(orderId)).pageLink).toBeNull();
    });

    // the order exists, one of its items does not sell any more: the page names the item the way
    // the confirmation does, so the buyer can cancel the payment and change the order
    it('answers ORDER_ITEMS_UNAVAILABLE naming an item removed from the catalog', async () => {
      const { user, product, orderId } = await waitingOrder();
      await deleteProductFromCatalog(product.id);

      const res = await checkout(app, csrf, user, orderId);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        errorCode: 'ORDER_ITEMS_UNAVAILABLE',
        details: { items: [expect.objectContaining({ productId: product.id, reason: 'deleted' })] },
      });
      expect((await redisStateOf(orderId)).pageLink).toBeNull();
    });

    it('names the item with its id and the units ordered', async () => {
      const { user, product, orderId } = await waitingOrder({ quantity: 2 });
      await deleteProductFromCatalog(product.id);
      const [item] = (await orderRowOf(orderId)).items;

      const res = await checkout(app, csrf, user, orderId);

      expect(res.json().details.items).toEqual([
        { itemId: item!.id, productId: product.id, reason: 'deleted', available: 0, requested: 2 },
      ]);
      // the order keeps waiting with its reservation, the buyer decides what to do
      expect(await orderStateOf(orderId)).toMatchObject({ status: 'waiting', confirmed: true });
    });

    // the confirmation refuses a free order now, one confirmed before that still waits
    it('answers ORDER_TOTAL_INVALID for a free order', async () => {
      const { user, orderId } = await oldWaitingOrder(0);

      const res = await checkout(app, csrf, user, orderId);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'ORDER_TOTAL_INVALID' });
    });

    it('answers REDIS_UNAVAILABLE and opens no page while Redis is down', async () => {
      const { user, orderId } = await waitingOrder();
      await closeRedis();

      try {
        let res: Awaited<ReturnType<typeof checkout>> | undefined;
        const requests = await stripeRequestsDuring(async () => {
          res = await checkout(app, csrf, user, orderId);
        });

        expect(res!.statusCode).toBe(503);
        expect(res!.json()).toMatchObject({ errorCode: 'REDIS_UNAVAILABLE' });
        expect(requests).toEqual([]);
        expect(takeLogs({ msg: 'request failed', errorCode: 'REDIS_UNAVAILABLE' })).toHaveLength(1);
      } finally {
        await connectRedis(app.log);
      }
    });
  });

  // a real failed connection, it needs no key: the page asks the buyer to try again a bit later,
  // the answer the cancel of a payment gives
  it('answers PAYMENT_PROVIDER_UNAVAILABLE when Stripe cannot be reached', async () => {
    const { user, orderId } = await waitingOrder();

    const res = await withStripeOutOfReach(() => checkout(app, csrf, user, orderId));

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ errorCode: 'PAYMENT_PROVIDER_UNAVAILABLE' });
    expect((await redisStateOf(orderId)).pageLink).toBeNull();
    expect(
      takeLogs({ msg: 'request failed', errorCode: 'PAYMENT_PROVIDER_UNAVAILABLE' }),
    ).toHaveLength(1);
  });

  describeWithStripe('at Stripe', () => {
    it('opens a payment page for the order total that the reservation closes', async () => {
      const { user, orderId } = await waitingOrder({ quantity: 2 });

      const res = await checkout(app, csrf, user, orderId);

      expect(res.statusCode).toBe(201);
      const page = res.json().checkoutSession;
      rememberSession(page.sessionId);
      const order = await orderStateOf(orderId);
      expect(page).toEqual({
        provider: 'stripe',
        sessionId: expect.stringMatching(/^cs_test_/),
        url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//),
        mode: 'payment',
        status: 'open',
        paymentStatus: 'unpaid',
        // Stripe keeps a page open for a day, the reservation ends long before
        expiresAt: order!.reservationExpiresAt!.toISOString(),
      });
      expect(await readSession(page.sessionId)).toMatchObject({
        amount_total: 5100,
        currency: 'eur',
        mode: 'payment',
        client_reference_id: String(orderId),
        metadata: { entityType: 'order', entityId: String(orderId), userId: String(user.id) },
      });
    });

    it('returns the buyer to the pages of the shop', async () => {
      const { user, orderId } = await waitingOrder();

      const res = await checkout(app, csrf, user, orderId);

      const session = await readSession(rememberSession(res.json().checkoutSession.sessionId));
      expect(session.success_url).toBe(
        'https://shop.example.com/checkout/success?session_id={CHECKOUT_SESSION_ID}',
      );
      expect(session.cancel_url).toBe(
        `https://shop.example.com/checkout/cancel?orderId=${orderId}`,
      );
    });

    // the order timeout worker closes the page with the reservation, it finds the page here
    it('links the page to the order in Redis', async () => {
      const { user, orderId } = await waitingOrder();

      const res = await checkout(app, csrf, user, orderId);

      const sessionId = rememberSession(res.json().checkoutSession.sessionId);
      expect((await redisStateOf(orderId)).pageLink).toBe(`stripe:${sessionId}`);
    });

    // a double click must not open a second page the buyer could pay as well
    it('gives the same page to a repeated request', async () => {
      const { user, orderId } = await waitingOrder();

      const first = await checkout(app, csrf, user, orderId);
      const second = await checkout(app, csrf, user, orderId);

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json().checkoutSession.sessionId).toBe(
        rememberSession(first.json().checkoutSession.sessionId),
      );
    });

    it('opens a new page once the order is confirmed again', async () => {
      const { user, orderId } = await waitingOrder();
      const first = await checkout(app, csrf, user, orderId);
      await loseReservation(orderId);
      const confirmed = await app.inject({
        method: 'POST',
        url: '/api/orders/current/confirm',
        headers: withCsrf(csrf, accessCookie(user)),
        payload: { orderId },
      });
      expect(confirmed.statusCode).toBe(200);

      const second = await checkout(app, csrf, user, orderId);

      expect(second.statusCode).toBe(201);
      expect(rememberSession(second.json().checkoutSession.sessionId)).not.toBe(
        rememberSession(first.json().checkoutSession.sessionId),
      );
    });

    // Stripe takes no less than 0.50 EUR; the confirmation refuses such a total now
    // (orders/confirm.test.ts), an order confirmed before that gets the same answer here
    it('answers ORDER_TOTAL_BELOW_MINIMUM for a total Stripe does not take', async () => {
      const { user, orderId } = await oldWaitingOrder(0.3);

      const res = await checkout(app, csrf, user, orderId);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'ORDER_TOTAL_BELOW_MINIMUM',
        details: { minimum: 0.5, currency: 'eur' },
      });
      expect((await redisStateOf(orderId)).pageLink).toBeNull();
    });

    it('opens a page for the smallest total Stripe takes', async () => {
      const { user, orderId } = await waitingOrder({ price: 0.5, quantity: 1 });

      const res = await checkout(app, csrf, user, orderId);

      expect(res.statusCode).toBe(201);
      const page = await readSession(rememberSession(res.json().checkoutSession.sessionId));
      expect(page.amount_total).toBe(50);
    });
  });
});
