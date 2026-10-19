import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { placeOrder } from '../../../helpers/orders.js';
import { CHECKOUT_URL, openPaymentPage, orderStateOf } from '../../../helpers/payments.js';
import {
  closeOpenSessions,
  describeWithStripe,
  expireSession,
  openForeignSession,
  payCheckoutSession,
  stripeRequestsDuring,
  withStripeOutOfReach,
} from '../../../helpers/stripe.js';

// GET /api/payments/checkout/sessions/:sessionId: the page the buyer comes back to after Stripe
// asks how the payment page of the order stands. The pages are real ones of the test sandbox

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

const getPage = (user: TestUser | null, sessionId: string) =>
  app.inject({
    method: 'GET',
    url: `${CHECKOUT_URL}/${encodeURIComponent(sessionId)}`,
    headers: user ? { cookie: accessCookie(user) } : {},
  });

// a buyer with an order waiting for its payment and the payment page the app opened for it
async function orderWithPage() {
  const user = await newUser();
  const product = await createProduct({ price: 25.5, stock: 5 });
  products.push(product);
  const orderId = await placeOrder(app, csrf, user, product, 'waiting');
  const sessionId = await openPaymentPage(app, csrf, user, orderId);
  return { user, orderId, sessionId };
}

// the form of a checkout session id at Stripe, made up
const unknownSessionId = () =>
  `cs_test_${'a1B2c3D4e5'.repeat(6)}${Math.random().toString(36).slice(2, 8)}`;

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

describe('GET /api/payments/checkout/sessions/:sessionId', () => {
  describe('refuses before Stripe', () => {
    // a request without a session is a guest, the way every route of a buyer answers one
    it('answers INSUFFICIENT_ROLE to a guest', async () => {
      const res = await getPage(null, unknownSessionId());

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    });

    it.each(['ADMIN', 'ROOT'] as const)('answers INSUFFICIENT_ROLE to %s', async (role) => {
      const res = await getPage(await newUser({ role }), unknownSessionId());

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    });

    // only an id of a Stripe checkout page goes on to Stripe
    it.each(['not-a-page', 'pi_test_123', 'cs_test_with spaces'])(
      'answers VALIDATION_ERROR for the id %p',
      async (sessionId) => {
        const user = await newUser();
        let res: Awaited<ReturnType<typeof getPage>> | undefined;

        const requests = await stripeRequestsDuring(async () => {
          res = await getPage(user, sessionId);
        });

        expect(res!.statusCode).toBe(400);
        expect(res!.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
        expect(requests).toEqual([]);
      },
    );

    // a real failed connection, it needs no key
    it('answers PAYMENT_PROVIDER_UNAVAILABLE when Stripe cannot be reached', async () => {
      const user = await newUser();

      const res = await withStripeOutOfReach(() => getPage(user, unknownSessionId()));

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ errorCode: 'PAYMENT_PROVIDER_UNAVAILABLE' });
      expect(
        takeLogs({ msg: 'request failed', errorCode: 'PAYMENT_PROVIDER_UNAVAILABLE' }),
      ).toHaveLength(1);
    });
  });

  describeWithStripe('at Stripe', () => {
    it('shows the open page of the order until the reservation ends', async () => {
      const { user, orderId, sessionId } = await orderWithPage();

      const res = await getPage(user, sessionId);

      expect(res.statusCode).toBe(200);
      const order = await orderStateOf(orderId);
      expect(res.json()).toEqual({
        checkoutSession: {
          sessionId,
          url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//),
          mode: 'payment',
          status: 'open',
          paymentStatus: 'unpaid',
          expiresAt: order!.reservationExpiresAt!.toISOString(),
        },
      });
    });

    // the buyer is back before the webhook came: the page shows the money is taken
    it('shows a paid page as complete and paid', async () => {
      const { user, sessionId } = await orderWithPage();
      await payCheckoutSession(sessionId);

      const res = await getPage(user, sessionId);

      expect(res.statusCode).toBe(200);
      expect(res.json().checkoutSession).toMatchObject({
        sessionId,
        status: 'complete',
        paymentStatus: 'paid',
      });
    });

    it('shows a closed page as expired', async () => {
      const { user, sessionId } = await orderWithPage();
      await expireSession(sessionId);

      const res = await getPage(user, sessionId);

      expect(res.statusCode).toBe(200);
      expect(res.json().checkoutSession).toMatchObject({
        sessionId,
        status: 'expired',
        paymentStatus: 'unpaid',
      });
    });

    it('answers ORDER_NOT_FOUND for the page of another user', async () => {
      const { sessionId } = await orderWithPage();

      const res = await getPage(await newUser(), sessionId);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
    });

    it('answers CHECKOUT_SESSION_NOT_FOUND for a page Stripe does not know', async () => {
      const res = await getPage(await newUser(), unknownSessionId());

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'CHECKOUT_SESSION_NOT_FOUND' });
    });

    // the test key reads only the test mode, a live id is unknown to it the same way
    it('answers CHECKOUT_SESSION_NOT_FOUND for an id of the live mode', async () => {
      const res = await getPage(
        await newUser(),
        unknownSessionId().replace('cs_test_', 'cs_live_'),
      );

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'CHECKOUT_SESSION_NOT_FOUND' });
    });

    // the sandbox and the account are shared with other tools: their pages are no orders here
    it('answers CHECKOUT_SESSION_NOT_FOUND for a page that is not of an order', async () => {
      const foreign = await openForeignSession();

      const res = await getPage(await newUser(), foreign.id);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'CHECKOUT_SESSION_NOT_FOUND' });
    });
  });
});
