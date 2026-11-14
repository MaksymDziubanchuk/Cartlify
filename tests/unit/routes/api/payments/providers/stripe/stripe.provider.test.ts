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

// an object stripe has no record of
const missing = (message: string) =>
  Object.assign(new Error(message), {
    type: 'StripeInvalidRequestError',
    code: 'resource_missing',
    statusCode: 404,
  });

// a refusal of the request itself, with the code stripe gives it
const refusal = (message: string, code?: string, param?: string) =>
  Object.assign(new Error(message), {
    type: 'StripeInvalidRequestError',
    statusCode: 400,
    ...(code ? { code } : {}),
    ...(param ? { param } : {}),
  });

// a refund the way stripe lists it, a card refund that succeeded unless the patch says otherwise
const stripeRefund = (patch: Record<string, unknown> = {}) => ({
  id: 're_test_1',
  object: 'refund',
  amount: 1250,
  currency: 'eur',
  created: 1_780_000_000,
  status: 'succeeded',
  reason: null,
  metadata: {},
  payment_intent: 'pi_test_1',
  ...patch,
});

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
        bankReference: null,
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
        bankReference: null,
      });
    });

    // the number the bank of the card knows the refund by (ARN): the buyer takes it to the bank
    it.each([
      [
        'the reference of a card refund',
        {
          card: {
            reference: '74987006278025112345678',
            reference_status: 'available',
            reference_type: 'acquirer_reference_number',
            type: 'refund',
          },
          type: 'card',
        },
        '74987006278025112345678',
      ],
      [
        'no reference while the bank of the card has none yet',
        {
          card: {
            reference_status: 'pending',
            reference_type: 'acquirer_reference_number',
            type: 'refund',
          },
          type: 'card',
        },
        null,
      ],
      [
        'no reference for an empty one',
        { card: { reference: '', type: 'refund' }, type: 'card' },
        null,
      ],
      [
        'no reference for a paypal refund',
        { paypal: { network_decline_code: null }, type: 'paypal' },
        null,
      ],
      ['no reference without the details of the destination', undefined, null],
    ])('takes %s', async (_case, destination, bankReference) => {
      jest
        .spyOn(stripe.refunds, 'create')
        .mockResolvedValue(stripeRefund({ destination_details: destination }) as never);

      expect(await module.stripeProvider.refundPayment(args)).toMatchObject({
        refundId: 're_test_1',
        bankReference,
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
        bankReference: null,
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
          bankReference: null,
        });
      },
    );

    // a refusal makes no refund; the reason in our words, the words of stripe beside it. Nothing
    // left of the payment to give back (all of it, or less than asked: given back before, by the
    // app or by hand in the dashboard) is already_refunded; a charge the buyer disputed at the bank
    // is disputed, the bank gives the money back, never the shop
    it.each([
      [
        'charge_already_refunded',
        undefined,
        'Charge ch_1 has already been refunded.',
        'already_refunded',
      ],
      [
        undefined,
        'amount',
        'Refund amount (€20.00) is greater than unrefunded amount on charge (€12.50)',
        'already_refunded',
      ],
      [
        'charge_disputed',
        undefined,
        'Charge ch_1 has been charged back; cannot issue a refund.',
        'disputed',
      ],
      ['resource_missing', 'payment_intent', "No such payment_intent: 'pi_test_1'", 'unknown'],
      [undefined, undefined, 'Invalid request', 'unknown'],
    ])(
      'reads a refusal with the code %s and the parameter %s',
      async (code, param, message, failure) => {
        jest
          .spyOn(stripe.refunds, 'create')
          .mockRejectedValue(refusal(message, code, param) as never);

        expect(await module.stripeProvider.refundPayment(args)).toEqual({
          refundId: null,
          status: 'failed',
          failure,
          failureText: message,
          bankReference: null,
        });
      },
    );

    it('keeps no more of the words of a refusal than the database does', async () => {
      jest
        .spyOn(stripe.refunds, 'create')
        .mockRejectedValue(refusal('x'.repeat(600), 'charge_already_refunded') as never);

      expect(await module.stripeProvider.refundPayment(args)).toMatchObject({
        failure: 'already_refunded',
        failureText: 'x'.repeat(500),
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
        bankReference: null,
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
        bankReference: null,
      });
      expect(list).toHaveBeenCalledWith({ payment_intent: 'pi_test_1', limit: 100 });
    });

    it('finds it on a later page of the refunds of the payment', async () => {
      const list = jest
        .spyOn(stripe.refunds, 'list')
        .mockResolvedValueOnce({
          data: [stripeRefund({ id: 're_other', metadata: { transfer: 'refund:other' } })],
          has_more: true,
        } as never)
        .mockResolvedValueOnce({
          data: [stripeRefund({ id: 're_mine', metadata: { transfer: 'refund:abc' } })],
          has_more: false,
        } as never);

      expect(await module.stripeProvider.findRefund(args)).toMatchObject({ refundId: 're_mine' });
      expect(list).toHaveBeenLastCalledWith({
        payment_intent: 'pi_test_1',
        limit: 100,
        starting_after: 're_other',
      });
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
        { refundId: 're_t', status: 'succeeded', bankReference: null },
      ],
      [
        { id: 're_t', status: 'pending' },
        { refundId: 're_t', status: 'pending', bankReference: null },
      ],
      [
        { id: 're_t', status: 'failed', failure_reason: 'expired_or_canceled_card' },
        {
          refundId: 're_t',
          status: 'failed',
          failure: 'card_unavailable',
          failureText: 'expired_or_canceled_card',
          bankReference: null,
        },
      ],
      // the number of the bank comes days after the money is sent, with refund.updated
      [
        {
          id: 're_t',
          status: 'succeeded',
          destination_details: { card: { reference: 'ARN1', type: 'refund' }, type: 'card' },
        },
        { refundId: 're_t', status: 'succeeded', bankReference: 'ARN1' },
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

  describe('listRefunds', () => {
    // stripe lists the newest first, a hundred at most on a page
    it('lists every refund of the payment, page after page, the oldest first', async () => {
      const list = jest
        .spyOn(stripe.refunds, 'list')
        .mockResolvedValueOnce({
          data: [
            stripeRefund({ id: 're_3', created: 1_780_000_300 }),
            stripeRefund({ id: 're_2', created: 1_780_000_200 }),
          ],
          has_more: true,
        } as never)
        .mockResolvedValueOnce({
          data: [stripeRefund({ id: 're_1', created: 1_780_000_100 })],
          has_more: false,
        } as never);

      const refunds = await module.stripeProvider.listRefunds('pi_test_1');

      expect(refunds.map((refund) => refund.refundId)).toEqual(['re_1', 're_2', 're_3']);
      expect(list).toHaveBeenCalledTimes(2);
      expect(list).toHaveBeenNthCalledWith(1, { payment_intent: 'pi_test_1', limit: 100 });
      expect(list).toHaveBeenNthCalledWith(2, {
        payment_intent: 'pi_test_1',
        limit: 100,
        starting_after: 're_2',
      });
    });

    it('gives each refund with its sum, its key, its reason, its time and where it stands', async () => {
      jest.spyOn(stripe.refunds, 'list').mockResolvedValue({
        data: [
          stripeRefund({
            id: 're_failed',
            amount: 100_000,
            created: 1_780_000_120,
            status: 'failed',
            failure_reason: 'lost_or_stolen_card',
          }),
          // made by hand in the dashboard: no key, and the reason picked from the list of stripe
          stripeRefund({
            id: 're_hand',
            amount: 5,
            created: 1_780_000_060,
            status: 'pending',
            reason: 'requested_by_customer',
          }),
          // ours: the key of the transfer rides in the metadata
          stripeRefund({
            id: 're_ours',
            amount: 1250,
            created: 1_780_000_000,
            metadata: { entityType: 'order', entityId: '12', transfer: 'refund:abc' },
            destination_details: { card: { reference: 'ARN1', type: 'refund' }, type: 'card' },
          }),
        ],
        has_more: false,
      } as never);

      expect(await module.stripeProvider.listRefunds('pi_test_1')).toEqual([
        {
          refundId: 're_ours',
          status: 'succeeded',
          bankReference: 'ARN1',
          amount: '12.50',
          transferKey: 'refund:abc',
          reason: null,
          createdAt: new Date(1_780_000_000_000),
        },
        {
          refundId: 're_hand',
          status: 'pending',
          bankReference: null,
          amount: '0.05',
          transferKey: null,
          reason: 'requested_by_customer',
          createdAt: new Date(1_780_000_060_000),
        },
        {
          refundId: 're_failed',
          status: 'failed',
          failure: 'card_unavailable',
          failureText: 'lost_or_stolen_card',
          bankReference: null,
          amount: '1000.00',
          transferKey: null,
          reason: null,
          createdAt: new Date(1_780_000_120_000),
        },
      ]);
    });

    // no key is a refund made by hand, whatever else its metadata holds
    it.each([
      [{ transfer: 'refund:abc' }, 'refund:abc'],
      [{ entityType: 'order', entityId: '12' }, null],
      [{ transfer: '' }, null],
      [{}, null],
      [null, null],
    ])(
      'reads the key of the transfer from the metadata %j as %p',
      async (metadata, transferKey) => {
        jest
          .spyOn(stripe.refunds, 'list')
          .mockResolvedValue({ data: [stripeRefund({ metadata })], has_more: false } as never);

        expect(await module.stripeProvider.listRefunds('pi_test_1')).toEqual([
          expect.objectContaining({ transferKey }),
        ]);
      },
    );

    it('answers none for a payment without refunds', async () => {
      jest.spyOn(stripe.refunds, 'list').mockResolvedValue({ data: [], has_more: false } as never);

      expect(await module.stripeProvider.listRefunds('pi_test_1')).toEqual([]);
    });

    // a page that says more come but brings nothing would ask stripe for ever
    it('stops at a page that brings nothing', async () => {
      const list = jest
        .spyOn(stripe.refunds, 'list')
        .mockResolvedValue({ data: [], has_more: true } as never);

      expect(await module.stripeProvider.listRefunds('pi_test_1')).toEqual([]);
      expect(list).toHaveBeenCalledTimes(1);
    });

    it('fails with PAYMENT_PROVIDER_UNAVAILABLE when stripe cannot be reached, also on a later page', async () => {
      jest
        .spyOn(stripe.refunds, 'list')
        .mockResolvedValueOnce({ data: [stripeRefund()], has_more: true } as never)
        .mockRejectedValueOnce(connectionError() as never);

      expect(await rejectedBy(() => module.stripeProvider.listRefunds('pi_test_1'))).toMatchObject({
        statusCode: 503,
        errorCode: 'PAYMENT_PROVIDER_UNAVAILABLE',
      });
    });

    it('fails with STRIPE_PAYMENT_NOT_FOUND for a payment stripe does not know', async () => {
      jest
        .spyOn(stripe.refunds, 'list')
        .mockRejectedValue(missing("No such payment_intent: 'pi_x'") as never);

      expect(await rejectedBy(() => module.stripeProvider.listRefunds('pi_x'))).toMatchObject({
        details: { reason: 'STRIPE_PAYMENT_NOT_FOUND', paymentId: 'pi_x' },
      });
    });
  });

  describe('getDispute', () => {
    // a chargeback of 10.00: the bank took the sum from the balance of the shop, stripe its fee
    const stripeDispute = (patch: Record<string, unknown> = {}) => ({
      id: 'dp_test_1',
      object: 'dispute',
      amount: 1000,
      currency: 'eur',
      created: 1_780_000_000,
      charge: 'ch_test_1',
      payment_intent: 'pi_test_1',
      reason: 'fraudulent',
      status: 'needs_response',
      is_charge_refundable: false,
      evidence_details: {
        due_by: 1_780_604_800,
        enhanced_eligibility: {},
        has_evidence: false,
        past_due: false,
        submission_count: 0,
      },
      balance_transactions: [
        {
          id: 'txn_out',
          object: 'balance_transaction',
          amount: -1000,
          fee: 2000,
          net: -3000,
          currency: 'eur',
          created: 1_780_000_005,
          type: 'adjustment',
          reporting_category: 'dispute',
        },
      ],
      ...patch,
    });

    // the balance transactions always come with the dispute, they are no field to expand
    it('reads the dispute as it stands now, with the money it took from the shop', async () => {
      const retrieve = jest
        .spyOn(stripe.disputes, 'retrieve')
        .mockResolvedValue(stripeDispute() as never);

      expect(await module.stripeProvider.getDispute('dp_test_1')).toEqual({
        id: 'dp_test_1',
        paymentId: 'pi_test_1',
        status: 'needs_response',
        reason: 'fraudulent',
        amount: '10.00',
        currency: 'eur',
        evidenceDueBy: new Date(1_780_604_800_000),
        hasEvidence: false,
        submissionCount: 0,
        isChargeRefundable: false,
        openedAt: new Date(1_780_000_000_000),
        transactions: [
          {
            id: 'txn_out',
            amount: '-10.00',
            fee: '20.00',
            currency: 'eur',
            createdAt: new Date(1_780_000_005_000),
          },
        ],
      });
      expect(retrieve).toHaveBeenCalledWith('dp_test_1');
    });

    // the sum is signed as the balance of the shop sees it and leaves the fee out: below 0 taken,
    // above 0 given back; a fee below 0 is one stripe gave back
    it('signs the money the bank gave back after a dispute the shop won', async () => {
      jest.spyOn(stripe.disputes, 'retrieve').mockResolvedValue(
        stripeDispute({
          status: 'won',
          balance_transactions: [
            { id: 'txn_out', amount: -1000, fee: 2000, currency: 'eur', created: 1_780_000_005 },
            { id: 'txn_back', amount: 1000, fee: -2000, currency: 'eur', created: 1_780_900_000 },
          ],
        }) as never,
      );

      expect((await module.stripeProvider.getDispute('dp_test_1')).transactions).toEqual([
        expect.objectContaining({ id: 'txn_out', amount: '-10.00', fee: '20.00' }),
        expect.objectContaining({ id: 'txn_back', amount: '10.00', fee: '-20.00' }),
      ]);
    });

    // an inquiry of the bank takes nothing
    it('reads an inquiry with no money moved and the evidence staged', async () => {
      jest.spyOn(stripe.disputes, 'retrieve').mockResolvedValue(
        stripeDispute({
          status: 'warning_needs_response',
          reason: 'general',
          is_charge_refundable: true,
          evidence_details: {
            due_by: null,
            has_evidence: true,
            past_due: false,
            submission_count: 1,
          },
          balance_transactions: [],
        }) as never,
      );

      expect(await module.stripeProvider.getDispute('dp_test_1')).toMatchObject({
        status: 'warning_needs_response',
        reason: 'general',
        isChargeRefundable: true,
        evidenceDueBy: null,
        hasEvidence: true,
        submissionCount: 1,
        transactions: [],
      });
    });

    it.each([
      [{ id: 'pi_expanded', object: 'payment_intent' }, 'pi_expanded'],
      [null, null],
    ])('reads the payment %j as %p', async (paymentIntent, paymentId) => {
      jest
        .spyOn(stripe.disputes, 'retrieve')
        .mockResolvedValue(stripeDispute({ payment_intent: paymentIntent }) as never);

      expect(await module.stripeProvider.getDispute('dp_test_1')).toMatchObject({ paymentId });
    });

    it.each([
      'warning_needs_response',
      'warning_under_review',
      'warning_closed',
      'needs_response',
      'under_review',
      'won',
      'lost',
      'prevented',
    ])('takes the status %s', async (status) => {
      jest.spyOn(stripe.disputes, 'retrieve').mockResolvedValue(stripeDispute({ status }) as never);

      expect(await module.stripeProvider.getDispute('dp_test_1')).toMatchObject({ status });
    });

    it('refuses a status stripe added later', async () => {
      jest
        .spyOn(stripe.disputes, 'retrieve')
        .mockResolvedValue(stripeDispute({ status: 'needs_more_info' }) as never);

      expect(await rejectedBy(() => module.stripeProvider.getDispute('dp_test_1'))).toMatchObject({
        details: {
          reason: 'STRIPE_DISPUTE_STATUS_UNKNOWN',
          disputeId: 'dp_test_1',
          status: 'needs_more_info',
        },
      });
    });

    it('fails with PAYMENT_PROVIDER_UNAVAILABLE when stripe cannot be reached', async () => {
      jest.spyOn(stripe.disputes, 'retrieve').mockRejectedValue(connectionError() as never);

      expect(await rejectedBy(() => module.stripeProvider.getDispute('dp_test_1'))).toMatchObject({
        statusCode: 503,
        errorCode: 'PAYMENT_PROVIDER_UNAVAILABLE',
      });
    });

    it('fails with STRIPE_DISPUTE_NOT_FOUND for a dispute stripe does not know', async () => {
      jest
        .spyOn(stripe.disputes, 'retrieve')
        .mockRejectedValue(missing("No such dispute: 'dp_x'") as never);

      expect(await rejectedBy(() => module.stripeProvider.getDispute('dp_x'))).toMatchObject({
        details: { reason: 'STRIPE_DISPUTE_NOT_FOUND', disputeId: 'dp_x' },
      });
    });

    it('lets another failure through as it is', async () => {
      const failure = refusal('bad request');
      jest.spyOn(stripe.disputes, 'retrieve').mockRejectedValue(failure as never);

      expect(await rejectedBy(() => module.stripeProvider.getDispute('dp_test_1'))).toBe(failure);
    });
  });

  describe('putDisputeEvidence', () => {
    it('puts the evidence given as a draft in the words of stripe and never submits it', async () => {
      const update = jest
        .spyOn(stripe.disputes, 'update')
        .mockResolvedValue({ id: 'dp_test_1', object: 'dispute' } as never);

      expect(
        await module.stripeProvider.putDisputeEvidence('dp_test_1', {
          productDescription: 'Order #12: Desk lamp x 1',
          shippingCarrier: 'Nova Poshta',
          shippingTrackingNumber: '20450000000000',
        }),
      ).toEqual({ status: 'put' });
      expect(update).toHaveBeenCalledWith('dp_test_1', {
        evidence: {
          product_description: 'Order #12: Desk lamp x 1',
          shipping_carrier: 'Nova Poshta',
          shipping_tracking_number: '20450000000000',
        },
        submit: false,
      });
    });

    it.each([
      ['productDescription', 'product_description'],
      ['customerName', 'customer_name'],
      ['customerEmailAddress', 'customer_email_address'],
      ['shippingAddress', 'shipping_address'],
      ['shippingCarrier', 'shipping_carrier'],
      ['shippingTrackingNumber', 'shipping_tracking_number'],
      ['shippingDate', 'shipping_date'],
      ['refundPolicyDisclosure', 'refund_policy_disclosure'],
      ['refundRefusalExplanation', 'refund_refusal_explanation'],
      ['uncategorizedText', 'uncategorized_text'],
    ])('sends %s as %s', async (ours, theirs) => {
      const update = jest
        .spyOn(stripe.disputes, 'update')
        .mockResolvedValue({ id: 'dp_test_1' } as never);

      await module.stripeProvider.putDisputeEvidence(
        'dp_test_1',
        Object.fromEntries([[ours, 'the text']]),
      );

      expect(update).toHaveBeenCalledWith('dp_test_1', {
        evidence: { [theirs]: 'the text' },
        submit: false,
      });
    });

    // a person submitted evidence in the dashboard first, or the bank decided already: the draft
    // has no place any more, which is no failure of the app
    it('answers a refusal of stripe with its words', async () => {
      jest
        .spyOn(stripe.disputes, 'update')
        .mockRejectedValue(refusal('This dispute is already closed.') as never);

      expect(
        await module.stripeProvider.putDisputeEvidence('dp_test_1', { uncategorizedText: 'x' }),
      ).toEqual({ status: 'refused', refusalText: 'This dispute is already closed.' });
    });

    it('fails with PAYMENT_PROVIDER_UNAVAILABLE when stripe cannot be reached', async () => {
      jest.spyOn(stripe.disputes, 'update').mockRejectedValue(connectionError() as never);

      expect(
        await rejectedBy(() =>
          module.stripeProvider.putDisputeEvidence('dp_test_1', { uncategorizedText: 'x' }),
        ),
      ).toMatchObject({ statusCode: 503, errorCode: 'PAYMENT_PROVIDER_UNAVAILABLE' });
    });

    it('fails with STRIPE_DISPUTE_NOT_FOUND for a dispute stripe does not know', async () => {
      jest
        .spyOn(stripe.disputes, 'update')
        .mockRejectedValue(missing("No such dispute: 'dp_x'") as never);

      expect(
        await rejectedBy(() =>
          module.stripeProvider.putDisputeEvidence('dp_x', { uncategorizedText: 'x' }),
        ),
      ).toMatchObject({ details: { reason: 'STRIPE_DISPUTE_NOT_FOUND', disputeId: 'dp_x' } });
    });

    it('lets another failure through as it is', async () => {
      const failure = Object.assign(new Error('bad key'), { type: 'StripeAuthenticationError' });
      jest.spyOn(stripe.disputes, 'update').mockRejectedValue(failure as never);

      expect(
        await rejectedBy(() =>
          module.stripeProvider.putDisputeEvidence('dp_test_1', { uncategorizedText: 'x' }),
        ),
      ).toBe(failure);
    });
  });

  // the page is read the way its payment event is (paymentPageReadingOf, stripeCheckout.helper)
  describe('readPaidPage', () => {
    it('reads the page at stripe the way its payment event is read', async () => {
      const retrieve = jest.spyOn(stripe.checkout.sessions, 'retrieve').mockResolvedValue(
        session({
          status: 'complete',
          payment_status: 'paid',
          payment_intent: 'pi_test_1',
          amount_total: 1999,
          currency: 'eur',
        }) as never,
      );

      expect(await module.stripeProvider.readPaidPage('cs_test_1')).toEqual({
        state: 'paid',
        pageId: 'cs_test_1',
        orderId: 12,
        userId: 3,
        paymentId: 'pi_test_1',
        amount: '19.99',
        currency: 'eur',
      });
      expect(retrieve).toHaveBeenCalledWith('cs_test_1');
    });

    it('fails with PAYMENT_PROVIDER_UNAVAILABLE when stripe cannot be reached', async () => {
      jest
        .spyOn(stripe.checkout.sessions, 'retrieve')
        .mockRejectedValue(connectionError() as never);

      expect(await rejectedBy(() => module.stripeProvider.readPaidPage('cs_test_1'))).toMatchObject(
        { statusCode: 503, errorCode: 'PAYMENT_PROVIDER_UNAVAILABLE' },
      );
    });

    // stripe answers 404 without a code for a checkout session it does not have
    it('fails with STRIPE_CHECKOUT_SESSION_NOT_FOUND for a page stripe does not know', async () => {
      jest.spyOn(stripe.checkout.sessions, 'retrieve').mockRejectedValue(
        Object.assign(new Error('No such checkout.session: cs_test_x'), {
          type: 'StripeInvalidRequestError',
          statusCode: 404,
        }) as never,
      );

      expect(await rejectedBy(() => module.stripeProvider.readPaidPage('cs_test_x'))).toMatchObject(
        {
          details: { reason: 'STRIPE_CHECKOUT_SESSION_NOT_FOUND', sessionId: 'cs_test_x' },
        },
      );
    });

    it('lets another failure through as it is', async () => {
      const failure = Object.assign(new Error('bad key'), { type: 'StripeAuthenticationError' });
      jest.spyOn(stripe.checkout.sessions, 'retrieve').mockRejectedValue(failure as never);

      expect(await rejectedBy(() => module.stripeProvider.readPaidPage('cs_test_1'))).toBe(failure);
    });
  });
});
