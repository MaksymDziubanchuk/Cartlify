import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import type Stripe from 'stripe';

import { rejectedBy } from '../../../../../../helpers/errors.js';
import { importWithEnv } from '../../../../../../helpers/freshImport.js';

type ProviderModule = typeof import('@routes/api/payments/providers/stripe/stripe.provider.js');
type StripeClient = (typeof import('@config/stripe.js'))['default'];

// the site the return pages are on and the money of the pages, the modules read them at import
const CONFIG = {
  WEB_ORIGIN: 'https://shop.example.com',
  STRIPE_CURRENCY: ' EUR ',
};

let module: ProviderModule;
let stripe: StripeClient;

beforeAll(async () => {
  module = await importWithEnv<ProviderModule>(
    '@routes/api/payments/providers/stripe/stripe.provider.js',
    CONFIG,
  );
  // the same module registry, so this is the client the provider uses
  stripe = (await import('@config/stripe.js')).default;
});

afterEach(() => {
  jest.restoreAllMocks();
});

const session = (patch: Partial<Stripe.Checkout.Session> = {}) =>
  ({
    id: 'cs_test_1',
    mode: 'payment',
    status: 'open',
    payment_status: 'unpaid',
    url: 'https://checkout.stripe.test/c/pay/cs_test_1',
    expires_at: 1_780_000_000,
    metadata: { entityType: 'order', entityId: '12', userId: '3' },
    ...patch,
  }) as Stripe.Checkout.Session;

// a failure of the network, the way the stripe sdk gives it after its own retries
const connectionError = () =>
  Object.assign(new Error('no connection'), { type: 'StripeConnectionError' });

describe('stripeProvider', () => {
  it('names itself, its money and its smallest total', () => {
    expect(module.stripeProvider).toMatchObject({
      name: 'stripe',
      label: 'Stripe',
      currency: 'eur',
      minimumTotal: 0.5,
      callbackPath: '/api/payments/stripe/webhook',
    });
  });

  describe('openPaymentPage', () => {
    const reservationExpiresAt = new Date('2026-06-01T10:15:00.000Z');
    const order = {
      orderId: 12,
      userId: 3,
      total: 19.99,
      reservationExpiresAt,
      pageClosedAt: null,
      items: [{ name: 'Desk lamp', unitPrice: 19.99, quantity: 1 }],
      // free delivery, to nowhere in particular: the line of the delivery is tested apart
      deliveryPrice: 0,
      shipping: null,
      customerEmail: 'anna@example.com',
    };

    it('opens a session with one key per order and reservation and names the provider', async () => {
      const create = jest
        .spyOn(stripe.checkout.sessions, 'create')
        .mockResolvedValue(session() as never);

      const page = await module.stripeProvider.openPaymentPage(order);

      expect(page.pageId).toBe('cs_test_1');
      expect(page.checkoutSession).toMatchObject({
        provider: 'stripe',
        sessionId: 'cs_test_1',
        status: 'open',
        paymentStatus: 'unpaid',
      });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ entityId: '12' }) }),
        { idempotencyKey: `checkout:order:12:${reservationExpiresAt.getTime()}` },
      );
    });

    it('answers PAYMENT_PROVIDER_UNAVAILABLE when stripe cannot be reached', async () => {
      jest.spyOn(stripe.checkout.sessions, 'create').mockRejectedValue(connectionError() as never);

      expect(await rejectedBy(() => module.stripeProvider.openPaymentPage(order))).toMatchObject({
        statusCode: 503,
        errorCode: 'PAYMENT_PROVIDER_UNAVAILABLE',
      });
    });

    it('lets a refusal of stripe through as it is', async () => {
      const refusal = Object.assign(new Error('bad request'), {
        type: 'StripeInvalidRequestError',
      });
      jest.spyOn(stripe.checkout.sessions, 'create').mockRejectedValue(refusal as never);

      expect(await rejectedBy(() => module.stripeProvider.openPaymentPage(order))).toBe(refusal);
    });
  });

  describe('closePaymentPage', () => {
    it('closes an open session', async () => {
      const expire = jest
        .spyOn(stripe.checkout.sessions, 'expire')
        .mockResolvedValue(session({ status: 'expired' }) as never);

      expect(await module.stripeProvider.closePaymentPage('cs_test_1')).toEqual({
        state: 'closed',
      });
      expect(expire).toHaveBeenCalledWith('cs_test_1');
    });

    // stripe refuses to expire a session that is not open: what it is now tells what happened
    it.each([
      ['a session that was closed already', { status: 'expired' }, 'closed'],
      ['a paid session', { status: 'complete', payment_status: 'paid' }, 'paid'],
      // a bank debit completes the session before the bank says yes or no
      [
        'a complete session the bank has not paid yet',
        { status: 'complete', payment_status: 'unpaid' },
        'in_progress',
      ],
    ] as const)('tells %s', async (_case, state, expected) => {
      jest
        .spyOn(stripe.checkout.sessions, 'expire')
        .mockRejectedValue(new Error('only open sessions can be expired') as never);
      jest
        .spyOn(stripe.checkout.sessions, 'retrieve')
        .mockResolvedValue(session(state as Partial<Stripe.Checkout.Session>) as never);

      expect(await module.stripeProvider.closePaymentPage('cs_test_1')).toEqual({
        state: expected,
      });
    });

    it('tells a session stripe left open, with the reason it was not closed', async () => {
      const failure = new Error('not expired');
      jest.spyOn(stripe.checkout.sessions, 'expire').mockRejectedValue(failure as never);
      jest.spyOn(stripe.checkout.sessions, 'retrieve').mockResolvedValue(session() as never);

      const closed = await module.stripeProvider.closePaymentPage('cs_test_1');

      expect(closed).toMatchObject({ state: 'open' });
      expect(closed.state === 'open' && (closed.cause as { cause?: unknown }).cause).toBe(failure);
    });

    it('answers PAYMENT_PROVIDER_UNAVAILABLE when stripe cannot be read either', async () => {
      jest.spyOn(stripe.checkout.sessions, 'expire').mockRejectedValue(connectionError() as never);
      jest
        .spyOn(stripe.checkout.sessions, 'retrieve')
        .mockRejectedValue(connectionError() as never);

      expect(
        await rejectedBy(() => module.stripeProvider.closePaymentPage('cs_test_1')),
      ).toMatchObject({ statusCode: 503, errorCode: 'PAYMENT_PROVIDER_UNAVAILABLE' });
    });
  });

  describe('refundPayment', () => {
    it('refunds the PaymentIntent of the order with one key per payment', async () => {
      const create = jest
        .spyOn(stripe.refunds, 'create')
        .mockResolvedValue({ id: 're_test_1' } as never);

      expect(
        await module.stripeProvider.refundPayment({ orderId: 12, paymentId: 'pi_test_1' }),
      ).toEqual({ refundId: 're_test_1' });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ payment_intent: 'pi_test_1' }),
        { idempotencyKey: 'refund:pi_test_1' },
      );
    });

    // a refund that is on its way counts as made: the bank of the card takes a few days
    it.each(['succeeded', 'pending'])('takes a refund stripe answers as %s', async (status) => {
      jest.spyOn(stripe.refunds, 'create').mockResolvedValue({ id: 're_test_2', status } as never);

      expect(
        await module.stripeProvider.refundPayment({ orderId: 12, paymentId: 'pi_test_2' }),
      ).toEqual({ refundId: 're_test_2' });
    });

    // the money did not go back: the order must not become cancelled as if it had
    it.each(['failed', 'canceled'])(
      'fails with STRIPE_REFUND_FAILED when stripe answers the refund as %s',
      async (status) => {
        jest
          .spyOn(stripe.refunds, 'create')
          .mockResolvedValue({ id: 're_test_3', status } as never);

        expect(
          await rejectedBy(() =>
            module.stripeProvider.refundPayment({ orderId: 12, paymentId: 'pi_test_3' }),
          ),
        ).toMatchObject({
          details: {
            reason: 'STRIPE_REFUND_FAILED',
            paymentIntentId: 'pi_test_3',
            refundId: 're_test_3',
            refundStatus: status,
          },
        });
      },
    );

    it('answers no refund for a payment stripe has refunded already', async () => {
      jest
        .spyOn(stripe.refunds, 'create')
        .mockRejectedValue(
          Object.assign(new Error('refunded'), { code: 'charge_already_refunded' }) as never,
        );

      expect(
        await module.stripeProvider.refundPayment({ orderId: 12, paymentId: 'pi_test_1' }),
      ).toEqual({ refundId: null });
    });

    it('fails with STRIPE_REFUND_FAILED when stripe refuses the refund', async () => {
      jest.spyOn(stripe.refunds, 'create').mockRejectedValue(new Error('no such payment') as never);

      expect(
        await rejectedBy(() =>
          module.stripeProvider.refundPayment({ orderId: 12, paymentId: 'pi_test_1' }),
        ),
      ).toMatchObject({
        details: { reason: 'STRIPE_REFUND_FAILED', paymentIntentId: 'pi_test_1' },
      });
    });
  });
});
