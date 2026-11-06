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
      locale: 'en',
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
    const args = { orderId: 12, paymentId: 'pi_test_1', amount: '12.50', key: 'refund:abc' };

    it('refunds the PaymentIntent for the amount in cents, with the key of the transfer', async () => {
      const create = jest
        .spyOn(stripe.refunds, 'create')
        .mockResolvedValue({ id: 're_test_1', status: 'succeeded' } as never);

      expect(await module.stripeProvider.refundPayment(args)).toEqual({
        refundId: 're_test_1',
        status: 'succeeded',
      });
      expect(create).toHaveBeenCalledWith(
        {
          payment_intent: 'pi_test_1',
          amount: 1250,
          metadata: { entityType: 'order', entityId: '12', transfer: 'refund:abc' },
        },
        { idempotencyKey: 'refund:abc' },
      );
    });

    // cents without float math
    it.each([
      ['0.01', 1],
      ['0.10', 10],
      ['5', 500],
      ['5.5', 550],
      ['1234.56', 123456],
    ])('sends %s as %i cents', async (amount, cents) => {
      const create = jest
        .spyOn(stripe.refunds, 'create')
        .mockResolvedValue({ id: 're_test_c', status: 'succeeded' } as never);

      await module.stripeProvider.refundPayment({ ...args, amount });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: cents }),
        expect.anything(),
      );
    });

    it.each(['', '0', '0.00', '-1', '1.234', 'ten', '1e3'])(
      'refuses the amount "%s" before asking stripe',
      async (amount) => {
        const create = jest.spyOn(stripe.refunds, 'create');

        expect(
          await rejectedBy(() => module.stripeProvider.refundPayment({ ...args, amount })),
        ).toMatchObject({ details: { reason: 'STRIPE_REFUND_AMOUNT_INVALID' } });
        expect(create).not.toHaveBeenCalled();
      },
    );

    // a refund on its way counts as pending: the bank of the card takes a few days
    it.each([
      ['succeeded', 'succeeded'],
      ['pending', 'pending'],
      ['requires_action', 'pending'],
    ])('takes a refund stripe answers as %s for %s', async (status, expected) => {
      jest.spyOn(stripe.refunds, 'create').mockResolvedValue({ id: 're_test_2', status } as never);

      expect(await module.stripeProvider.refundPayment(args)).toEqual({
        refundId: 're_test_2',
        status: expected,
      });
    });

    // the money did not go back; the reason in our words, and the words of stripe beside it
    it.each([
      ['lost_or_stolen_card', 'card_unavailable'],
      ['expired_or_canceled_card', 'card_unavailable'],
      ['insufficient_funds', 'shop_balance'],
      ['charge_for_pending_refund_disputed', 'disputed'],
      ['declined', 'unknown'],
      ['merchant_request', 'unknown'],
      ['unknown', 'unknown'],
    ])('reads the failure %s as %s', async (reason, failure) => {
      jest
        .spyOn(stripe.refunds, 'create')
        .mockResolvedValue({ id: 're_test_3', status: 'failed', failure_reason: reason } as never);

      expect(await module.stripeProvider.refundPayment(args)).toEqual({
        refundId: 're_test_3',
        status: 'failed',
        failure,
        failureText: reason,
      });
    });

    it.each(['failed', 'canceled'])(
      'reads a refund stripe answers as %s with no reason as failed',
      async (status) => {
        jest
          .spyOn(stripe.refunds, 'create')
          .mockResolvedValue({ id: 're_test_4', status } as never);

        expect(await module.stripeProvider.refundPayment(args)).toEqual({
          refundId: 're_test_4',
          status: 'failed',
          failure: 'unknown',
          failureText: status,
        });
      },
    );

    it('says the money is back already when the charge was refunded before', async () => {
      jest.spyOn(stripe.refunds, 'create').mockRejectedValue(
        Object.assign(new Error('Charge ch_1 has already been refunded.'), {
          type: 'StripeInvalidRequestError',
          code: 'charge_already_refunded',
        }) as never,
      );

      expect(await module.stripeProvider.refundPayment(args)).toEqual({
        refundId: null,
        status: 'failed',
        failure: 'unknown',
        failureText: 'Charge ch_1 has already been refunded.',
        alreadyRefunded: true,
      });
    });

    it('reads a refusal of the request (more than is left, no such payment) as a failure with the words of stripe', async () => {
      jest
        .spyOn(stripe.refunds, 'create')
        .mockRejectedValue(
          Object.assign(
            new Error(
              'Refund amount ($20.00) is greater than unrefunded amount on charge ($12.50).',
            ),
            { type: 'StripeInvalidRequestError' },
          ) as never,
        );

      expect(await module.stripeProvider.refundPayment(args)).toEqual({
        refundId: null,
        status: 'failed',
        failure: 'unknown',
        failureText: 'Refund amount ($20.00) is greater than unrefunded amount on charge ($12.50).',
      });
    });

    // a charge the buyer disputed at the bank: the bank gives the money back, never the shop
    it('reads a refusal for a disputed charge as disputed', async () => {
      jest.spyOn(stripe.refunds, 'create').mockRejectedValue(
        Object.assign(new Error('Charge ch_1 has been charged back.'), {
          type: 'StripeInvalidRequestError',
          code: 'charge_disputed',
        }) as never,
      );

      expect(await module.stripeProvider.refundPayment(args)).toEqual({
        refundId: null,
        status: 'failed',
        failure: 'disputed',
        failureText: 'Charge ch_1 has been charged back.',
      });
    });

    // no answer is no failure: the same key asks again and gets the one refund. A request of the same
    // key still running at stripe (409) is no answer either: it may still make the refund
    it.each([
      ['the network', connectionError()],
      ['a server error', Object.assign(new Error('boom'), { type: 'StripeAPIError' })],
      ['a rate limit', Object.assign(new Error('slow'), { type: 'StripeRateLimitError' })],
      ['an error nobody knows', new Error('what')],
      [
        'the same key in use',
        Object.assign(new Error('There is currently another in-progress request using this key.'), {
          type: 'StripeInvalidRequestError',
          statusCode: 409,
          code: 'idempotency_key_in_use',
        }),
      ],
    ])('keeps the refund pending when stripe does not answer: %s', async (_what, err) => {
      jest.spyOn(stripe.refunds, 'create').mockRejectedValue(err as never);

      expect(await module.stripeProvider.refundPayment(args)).toEqual({
        refundId: null,
        status: 'pending',
      });
    });
  });

  describe('findRefund', () => {
    const args = { paymentId: 'pi_test_1', key: 'refund:abc' };

    it('finds the refund that carries the key of the transfer, among the refunds of the payment', async () => {
      const list = jest.spyOn(stripe.refunds, 'list').mockResolvedValue({
        data: [
          { id: 're_other', status: 'succeeded', metadata: { transfer: 'refund:other' } },
          { id: 're_mine', status: 'pending', metadata: { transfer: 'refund:abc' } },
        ],
      } as never);

      expect(await module.stripeProvider.findRefund(args)).toEqual({
        refundId: 're_mine',
        status: 'pending',
      });
      expect(list).toHaveBeenCalledWith({ payment_intent: 'pi_test_1', limit: 100 });
    });

    it('answers none when no refund carries the key', async () => {
      jest.spyOn(stripe.refunds, 'list').mockResolvedValue({
        data: [{ id: 're_other', status: 'succeeded', metadata: {} }],
      } as never);

      expect(await module.stripeProvider.findRefund(args)).toBeNull();
    });

    it('fails with PAYMENT_PROVIDER_UNAVAILABLE when stripe cannot be reached', async () => {
      jest.spyOn(stripe.refunds, 'list').mockRejectedValue(connectionError() as never);

      expect(await rejectedBy(() => module.stripeProvider.findRefund(args))).toMatchObject({
        statusCode: 503,
        errorCode: 'PAYMENT_PROVIDER_UNAVAILABLE',
      });
    });
  });

  describe('getRefund', () => {
    it.each([
      [
        { id: 're_t', status: 'succeeded' },
        { refundId: 're_t', status: 'succeeded' },
      ],
      [
        { id: 're_t', status: 'pending' },
        { refundId: 're_t', status: 'pending' },
      ],
      [
        { id: 're_t', status: 'failed', failure_reason: 'expired_or_canceled_card' },
        {
          refundId: 're_t',
          status: 'failed',
          failure: 'card_unavailable',
          failureText: 'expired_or_canceled_card',
        },
      ],
    ])('asks stripe where the refund stands: %j', async (refund, expected) => {
      const retrieve = jest.spyOn(stripe.refunds, 'retrieve').mockResolvedValue(refund as never);

      expect(await module.stripeProvider.getRefund('re_t')).toEqual(expected);
      expect(retrieve).toHaveBeenCalledWith('re_t');
    });

    it('fails with PAYMENT_PROVIDER_UNAVAILABLE when stripe cannot be reached', async () => {
      jest.spyOn(stripe.refunds, 'retrieve').mockRejectedValue(connectionError() as never);

      expect(await rejectedBy(() => module.stripeProvider.getRefund('re_t'))).toMatchObject({
        statusCode: 503,
        errorCode: 'PAYMENT_PROVIDER_UNAVAILABLE',
      });
    });

    it('fails with STRIPE_REFUND_NOT_FOUND for a refund stripe does not know', async () => {
      jest.spyOn(stripe.refunds, 'retrieve').mockRejectedValue(
        Object.assign(new Error("No such refund: 're_x'"), {
          type: 'StripeInvalidRequestError',
          code: 'resource_missing',
          statusCode: 404,
        }) as never,
      );

      expect(await rejectedBy(() => module.stripeProvider.getRefund('re_x'))).toMatchObject({
        details: { reason: 'STRIPE_REFUND_NOT_FOUND', refundId: 're_x' },
      });
    });
  });
});
