import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import stripe from '@config/stripe.js';
import { getRedis } from '@redis/client.js';
import { redisKeys } from '@redis/keys.js';
import { setOrderPaymentPageLink } from '@routes/api/orders/services/helpers/orderTimeoutQueue.helper.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { takeLogs } from '../../../helpers/logs.js';
import {
  closeSessions,
  createProduct,
  createUser,
  stockOf,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import {
  orderRowOf,
  placeOrder,
  placeUnconfirmedOrder,
  deliveryAnswer,
} from '../../../helpers/orders.js';
import { openPaymentPage, redisStateOf } from '../../../helpers/payments.js';
import {
  closeOpenSessions,
  expireSession,
  openBankPaymentPage,
  outOfReachDuring,
  payCheckoutSession,
  readSession,
  stripeRequestsDuring,
  withStripeOutOfReach,
} from '../../../helpers/stripe.js';

type Response = Awaited<ReturnType<FastifyInstance['inject']>>;

// POST /api/orders/:orderId/cancel-payment: the owner gives up paying an order that waits for its
// payment. The payment page at Stripe is closed first, so no payment can come for it any more;
// then the reservation goes and the order becomes unconfirmed with its items and shipping data.
// The pages are opened at Stripe (its mock, or the test sandbox with service:stripe) by the
// checkout route; Stripe out of reach is a real failed connection

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

const newProduct = async () => {
  const product = await createProduct({ price: 10, stock: 5 });
  products.push(product);
  return product;
};

const cancelPayment = (user: TestUser, orderId: number | string) =>
  app.inject({
    method: 'POST',
    url: `/api/orders/${orderId}/cancel-payment`,
    headers: withCsrf(csrf, accessCookie(user)),
  });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  try {
    await closeOpenSessions();
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('POST /api/orders/:orderId/cancel-payment', () => {
  it('makes the order unconfirmed, releases its stock and keeps its shipping data', async () => {
    const user = await newUser();
    const product = await newProduct();
    const orderId = await placeOrder(app, csrf, user, product, 'waiting', 2);

    const res = await cancelPayment(user, orderId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: orderId,
      status: 'unconfirmed',
      confirmed: false,
      delivery: deliveryAnswer,
      items: [{ productId: product.id, quantity: 2 }],
    });
    expect(res.json()).not.toHaveProperty('reservationExpiresAt');
    expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 0 });
  });

  it('removes the reservation timers of the order', async () => {
    const user = await newUser();
    const orderId = await placeOrder(app, csrf, user, await newProduct(), 'waiting');
    const redis = await getRedis();
    expect(await redis.zScore(redisKeys.orderTimeoutBaseZset, String(orderId))).not.toBeNull();

    await cancelPayment(user, orderId);

    expect(await redis.zScore(redisKeys.orderTimeoutBaseZset, String(orderId))).toBeNull();
    expect(await redis.zScore(redisKeys.orderTimeoutZset, String(orderId))).toBeNull();
  });

  it('lets the owner confirm the order again with only its id', async () => {
    const user = await newUser();
    const product = await newProduct();
    const orderId = await placeOrder(app, csrf, user, product, 'waiting');
    await cancelPayment(user, orderId);

    const res = await app.inject({
      method: 'POST',
      url: '/api/orders/current/confirm',
      headers: withCsrf(csrf, accessCookie(user)),
      payload: { orderId, expectedDeliveryPrice: 0 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'waiting', delivery: deliveryAnswer });
    expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 1 });
  });

  // a link written before links named their provider, or of a provider the server has not, leads
  // to no page the server could close: the cancel goes on and asks no provider
  it.each([
    ['the old form without a provider', 'cs_test_old_link'],
    ['a provider this server has not', 'liqpay:dev-1-1700000000000'],
  ])('cancels past a page link of %s and asks no provider', async (_case, link) => {
    const user = await newUser();
    const orderId = await placeOrder(app, csrf, user, await newProduct(), 'waiting');
    const redis = await getRedis();
    await redis.hSet(redisKeys.orderPaymentSessionMap, String(orderId), link);

    let res: Response | undefined;
    const requests = await stripeRequestsDuring(async () => {
      res = await cancelPayment(user, orderId);
    });

    expect(res!.statusCode).toBe(200);
    expect(res!.json()).toMatchObject({ status: 'unconfirmed' });
    expect(requests).toEqual([]);
    expect((await redisStateOf(orderId)).pageLink).toBeNull();
  });

  describe('with a payment page open at Stripe', () => {
    it('closes the payment page first and forgets it', async () => {
      const user = await newUser();
      const orderId = await placeOrder(app, csrf, user, await newProduct(), 'waiting');
      const sessionId = await openPaymentPage(app, csrf, user, orderId);

      const res = await cancelPayment(user, orderId);

      expect(res.statusCode).toBe(200);
      expect((await readSession(sessionId)).status).toBe('expired');
      expect((await redisStateOf(orderId)).pageLink).toBeNull();
    });

    it('cancels when the page was closed already', async () => {
      const user = await newUser();
      const orderId = await placeOrder(app, csrf, user, await newProduct(), 'waiting');
      await expireSession(await openPaymentPage(app, csrf, user, orderId));

      const res = await cancelPayment(user, orderId);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'unconfirmed' });
    });

    // the webhook marks it paid; the order keeps its reservation for it
    it('refuses when Stripe took the money on the page already', async () => {
      const user = await newUser();
      const product = await newProduct();
      const orderId = await placeOrder(app, csrf, user, product, 'waiting');
      await payCheckoutSession(await openPaymentPage(app, csrf, user, orderId));

      const res = await cancelPayment(user, orderId);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'ORDER_ALREADY_PAID' });
      expect(await orderRowOf(orderId)).toMatchObject({ status: 'waiting', confirmed: true });
      expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 1 });
    });

    // a bank debit completes the page before the money comes; the shop opens only card pages,
    // so the test links such a page to the order itself
    it('refuses while the bank still decides on the payment', async () => {
      const user = await newUser();
      const orderId = await placeOrder(app, csrf, user, await newProduct(), 'waiting');
      await setOrderPaymentPageLink(orderId, {
        provider: 'stripe',
        pageId: await openBankPaymentPage(1000),
      });

      const res = await cancelPayment(user, orderId);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'ORDER_PAYMENT_IN_PROGRESS' });
      expect((await orderRowOf(orderId)).status).toBe('waiting');
    });

    // a page left open could still be paid after the cancel. The connection fails for real,
    // for the close of the page only or for every call
    it.each([
      [
        'the page stays open',
        (fn: () => Promise<Response>) => {
          outOfReachDuring(stripe.checkout.sessions, 'expire');
          return fn();
        },
      ],
      ['Stripe cannot be reached', (fn: () => Promise<Response>) => withStripeOutOfReach(fn)],
    ])('changes nothing when %s', async (_case, during) => {
      const user = await newUser();
      const product = await newProduct();
      const orderId = await placeOrder(app, csrf, user, product, 'waiting');
      const sessionId = await openPaymentPage(app, csrf, user, orderId);

      const res = await during(() => cancelPayment(user, orderId));

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ errorCode: 'PAYMENT_PROVIDER_UNAVAILABLE' });
      expect(await orderRowOf(orderId)).toMatchObject({ status: 'waiting', confirmed: true });
      expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 1 });
      expect((await readSession(sessionId)).status).toBe('open');
      expect((await redisStateOf(orderId)).pageLink).toBe(`stripe:${sessionId}`);
      // what Stripe answered stays in the log of the server
      expect(
        takeLogs({ msg: 'request failed', errorCode: 'PAYMENT_PROVIDER_UNAVAILABLE' }),
      ).toHaveLength(1);
    });
  });

  // redis is up but the connection drops in the middle of reading the page link: the request
  // cannot go on, and the answer is the one the swagger document promises for redis, not a 500
  it('answers 503 REDIS_UNAVAILABLE when Redis drops the connection on the page link', async () => {
    const user = await newUser();
    const orderId = await placeOrder(app, csrf, user, await newProduct(), 'waiting');
    const redis = await getRedis();
    jest.spyOn(redis, 'hGet').mockRejectedValueOnce(new Error('Socket closed unexpectedly'));

    const res = await cancelPayment(user, orderId);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ errorCode: 'REDIS_UNAVAILABLE' });
    expect(takeLogs({ msg: 'request failed', errorCode: 'REDIS_UNAVAILABLE' })).toHaveLength(1);
    expect((await orderRowOf(orderId))!.status).toBe('waiting');
  });

  it('answers ORDER_ALREADY_PAID for a paid order and does not touch Stripe', async () => {
    const user = await newUser();
    const orderId = await placeOrder(app, csrf, user, await newProduct(), 'paid');
    let res: Response | undefined;

    const requests = await stripeRequestsDuring(async () => {
      res = await cancelPayment(user, orderId);
    });

    expect(res!.statusCode).toBe(409);
    expect(res!.json()).toMatchObject({ errorCode: 'ORDER_ALREADY_PAID' });
    expect(requests).toEqual([]);
    expect((await orderRowOf(orderId)).status).toBe('paid');
  });

  it.each([
    ['the cart', 'cart'],
    ['an unconfirmed order', 'unconfirmed'],
  ] as const)('refuses %s: it does not wait for a payment', async (_case, stage) => {
    const user = await newUser();
    const orderId =
      stage === 'cart'
        ? await placeOrder(app, csrf, user, await newProduct(), 'cart')
        : await placeUnconfirmedOrder(app, csrf, user, await newProduct());

    const res = await cancelPayment(user, orderId);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_STATUS_NOT_WAITING' });
  });

  it('hides the order of another user as not found and changes nothing', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'waiting');

    const res = await cancelPayment(await newUser(), orderId);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
    expect((await orderRowOf(orderId)).status).toBe('waiting');
  });

  it('answers 404 for an order that does not exist', async () => {
    const res = await cancelPayment(await newUser(), 2_000_000_000);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
  });

  it('refuses an order id over the largest id', async () => {
    const res = await cancelPayment(await newUser(), '2147483648');

    expect(res.statusCode).toBe(400);
  });

  it('refuses an admin and changes nothing', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'waiting');

    const res = await cancelPayment(await newUser({ role: 'ADMIN' }), orderId);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect((await orderRowOf(orderId)).status).toBe('waiting');
  });
});
