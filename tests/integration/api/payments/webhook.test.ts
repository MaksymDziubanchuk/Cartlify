import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';

import { startApp, stopApp } from '../../../helpers/app.js';
import { takeLogs } from '../../../helpers/logs.js';
import { craftEvent, deliver, signatureOf, WEBHOOK_URL } from '../../../helpers/stripe.js';

// POST /api/payments/stripe/webhook, what any event goes through: the Stripe signature, the body, the
// events the app does not handle. Nothing here needs Stripe itself, an event is signed with the
// test webhook secret the way Stripe signs it. Payments, refunds and closed pages are in
// webhookPaid, webhookRefund and webhookExpired

let app: FastifyInstance;

// an event the app takes and does nothing with
const ignoredEvent = () => craftEvent('customer.created', { id: 'cus_test_1', object: 'customer' });

// a checkout page that is not one of the app: no order in its metadata
const foreignPage = (overrides: Record<string, unknown> = {}) => ({
  id: 'cs_test_foreign',
  object: 'checkout.session',
  mode: 'payment',
  status: 'complete',
  payment_status: 'paid',
  amount_total: 1000,
  currency: 'eur',
  payment_intent: 'pi_test_foreign',
  metadata: {},
  ...overrides,
});

const post = (payload: string, headers: Record<string, string>) =>
  app.inject({ method: 'POST', url: WEBHOOK_URL, headers, payload });

beforeAll(async () => {
  app = await startApp();
});

afterAll(async () => {
  await stopApp();
});

describe('POST /api/payments/stripe/webhook', () => {
  it('acknowledges an event it does not handle', async () => {
    const res = await deliver(app, ignoredEvent());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
  });

  it('takes the content type Stripe sends with its charset', async () => {
    const payload = JSON.stringify(ignoredEvent());

    const res = await post(payload, {
      'content-type': 'application/json; charset=utf-8',
      'stripe-signature': signatureOf(payload),
    });

    expect(res.statusCode).toBe(200);
  });

  describe('the signature', () => {
    it('answers 400 without the signature header', async () => {
      const res = await post(JSON.stringify(ignoredEvent()), {
        'content-type': 'application/json',
      });

      expect(res.statusCode).toBe(400);
    });

    it('answers STRIPE_SIGNATURE_INVALID for a signature made with another secret', async () => {
      const res = await deliver(app, ignoredEvent(), { secret: 'whsec_another_account' });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ errorCode: 'STRIPE_SIGNATURE_INVALID' });
    });

    it('answers STRIPE_SIGNATURE_INVALID for a body changed after signing', async () => {
      const signed = JSON.stringify(ignoredEvent());
      const changed = signed.replace('cus_test_1', 'cus_test_2');

      const res = await post(changed, {
        'content-type': 'application/json',
        'stripe-signature': signatureOf(signed),
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ errorCode: 'STRIPE_SIGNATURE_INVALID' });
    });

    // an event caught on the way must not be delivered again later
    it('answers STRIPE_SIGNATURE_INVALID for a signature older than five minutes', async () => {
      const res = await deliver(app, ignoredEvent(), {
        timestamp: Math.floor(Date.now() / 1000) - 301,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ errorCode: 'STRIPE_SIGNATURE_INVALID' });
    });

    it('answers STRIPE_SIGNATURE_INVALID for a header that is no signature', async () => {
      const res = await post(JSON.stringify(ignoredEvent()), {
        'content-type': 'application/json',
        'stripe-signature': 'not-a-signature',
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ errorCode: 'STRIPE_SIGNATURE_INVALID' });
    });

    // a server without the secret takes no event: Stripe gets an error and delivers it again
    it('answers 500 and logs STRIPE_WEBHOOK_SECRET_MISSING without the webhook secret', async () => {
      const secret = env.STRIPE_WEBHOOK_SECRET;
      const payload = JSON.stringify(ignoredEvent());
      const signature = signatureOf(payload);
      env.STRIPE_WEBHOOK_SECRET = '';

      try {
        const res = await post(payload, {
          'content-type': 'application/json',
          'stripe-signature': signature,
        });

        expect(res.statusCode).toBe(500);
        expect(res.json()).toMatchObject({ errorCode: 'INTERNAL_ERROR' });
        expect(
          takeLogs({ msg: 'request failed', reason: 'STRIPE_WEBHOOK_SECRET_MISSING' }),
        ).toHaveLength(1);
      } finally {
        env.STRIPE_WEBHOOK_SECRET = secret;
      }
    });
  });

  describe('the body', () => {
    it('answers STRIPE_RAW_BODY_REQUIRED for an empty body', async () => {
      const res = await post('', {
        'content-type': 'application/json',
        'stripe-signature': signatureOf(''),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'STRIPE_RAW_BODY_REQUIRED' });
    });

    it('answers REQUEST_BODY_INVALID_JSON for a body that is not json', async () => {
      const res = await post('not json', {
        'content-type': 'application/json',
        'stripe-signature': signatureOf('not json'),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'REQUEST_BODY_INVALID_JSON' });
    });

    it('answers STRIPE_EVENT_OBJECT_INVALID for a checkout event about another object', async () => {
      const res = await deliver(
        app,
        craftEvent('checkout.session.completed', { id: 'pi_test_1', object: 'payment_intent' }),
      );

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'STRIPE_EVENT_OBJECT_INVALID' });
    });
  });

  // the sandbox and the account are shared with other tools: an error answer about their pages
  // would make Stripe deliver the event again for days and at last turn the endpoint off. The
  // money of such a page is not touched, webhookRefund.test.ts pays one for real
  describe('a page that is not of an order', () => {
    const skipped = () =>
      takeLogs({ msg: 'stripe event of a page that is not an order was skipped' });

    it.each([
      ['checkout.session.completed', foreignPage()],
      ['checkout.session.async_payment_succeeded', foreignPage()],
      ['checkout.session.expired', foreignPage({ status: 'expired', payment_status: 'unpaid' })],
      [
        'checkout.session.async_payment_failed',
        foreignPage({ payment_status: 'unpaid', metadata: { entityType: 'subscription' } }),
      ],
    ])('acknowledges %s and says why it did nothing', async (type, page) => {
      const event = craftEvent(type, page);

      const res = await deliver(app, event);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true, skipped: 'NOT_AN_ORDER' });
      expect(skipped()).toEqual([
        expect.objectContaining({ eventId: event.id, eventType: type, sessionId: page.id }),
      ]);
    });

    // an order id the app never writes: no order can be meant by it
    it.each(['abc', '0', '1.5', '-3', '2147483648', ''])(
      'acknowledges a paid page with the order id %p',
      async (entityId) => {
        const page = foreignPage({ metadata: { entityType: 'order', entityId } });

        const res = await deliver(app, craftEvent('checkout.session.completed', page));

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ received: true, skipped: 'NOT_AN_ORDER' });
        expect(skipped()).toHaveLength(1);
      },
    );
  });

  // Stripe delivers from a few addresses, a busy hour of sales comes from one of them; the
  // signature keeps strangers out, a refusal would hold back payments the buyers already made
  it('lets Stripe deliver past the request limit of an address', async () => {
    const remoteAddress = '203.0.113.7';
    for (let i = 0; i < 100; i++) {
      await app.inject({ method: 'GET', url: '/api/auth/csrf', remoteAddress });
    }

    const res = await deliver(app, ignoredEvent(), { remoteAddress });

    expect(res.statusCode).toBe(200);
  });

  // stripe is one of the payment providers: its events come under its name, the path of a main
  // provider is gone, so a webhook endpoint left on it fails loudly at stripe
  it('answers 404 to an event on the old path', async () => {
    const payload = JSON.stringify(ignoredEvent());

    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': signatureOf(payload) },
      payload,
    });

    expect(res.statusCode).toBe(404);
  });

  // only the webhook is let through: the other routes keep the limit
  it('keeps the request limit of the other routes', async () => {
    const remoteAddress = '203.0.113.8';
    // the limit of the tests (RATE_LIMIT_MAX of tests/setup/integration.setup.ts)
    const limit = Number(process.env.RATE_LIMIT_MAX);
    expect(limit).toBeGreaterThan(0);
    for (let i = 0; i < limit; i++) {
      await app.inject({ method: 'GET', url: '/api/auth/csrf', remoteAddress });
    }

    const limited = await app.inject({ method: 'GET', url: '/api/auth/csrf', remoteAddress });

    expect(limited.statusCode).toBe(429);
  });
});
