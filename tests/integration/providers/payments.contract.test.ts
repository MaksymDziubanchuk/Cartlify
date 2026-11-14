import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { REFUND_FAILURES } from '@helpers/returns.js';
import { paymentProviders } from '@providers/payments/index.js';
import { isAppError } from '@utils/errors.js';

import { startApp, stopApp } from '../../helpers/app.js';
import { rejectedBy } from '../../helpers/errors.js';
import { paymentHarness } from '../../helpers/providers.js';

import type { FastifyInstance } from 'fastify';
import type { PaymentPageOrder } from '@providers/payments/index.js';

// The contract of a payment provider: what the rest of the app counts on, whoever takes the money
// (src/providers/payments/types.ts). Every provider of the registry goes through the same tests,
// made to answer by its entry in tests/helpers/providers.ts (its mock, or the real service when the
// run takes it); a new provider passes them without tests of its own.

// a confirmed order a page is opened for; its numbers are the test's own, the provider does not
// read the database
const orderOf = (orderId: number): PaymentPageOrder => ({
  orderId,
  userId: 7,
  total: 12.5,
  reservationExpiresAt: new Date(Date.now() + 15 * 60_000),
  pageClosedAt: null,
  items: [{ name: 'Contract test item', unitPrice: 6.25, quantity: 2 }],
  deliveryPrice: 0,
  shipping: null,
  customerEmail: 'buyer@example.com',
  locale: 'en',
});

// a page carries the name of the shop and keeps the minutes of the shop: the settings the server
// starts with; the events of a provider come to its own routes of the server
let app: FastifyInstance;

beforeAll(async () => {
  app = await startApp();
});

afterAll(async () => {
  await stopApp();
});

const codeOf = (err: unknown) => (isAppError(err) ? err.errorCode : String(err));

// an order id of its own for each test, far from the ids of the database of the tests
const newOrderId = () => 900_000 + Math.floor(Math.random() * 99_000);

describe.each(paymentProviders.map((provider) => [provider.name, provider] as const))(
  'the payment provider %s',
  (name, provider) => {
    const harness = paymentHarness[name];

    it('opens the page of an order, tells it is not paid yet and closes it', async () => {
      const orderId = newOrderId();
      const opened = await provider.openPaymentPage(orderOf(orderId));
      harness.keepPage(opened.pageId);

      expect(opened.pageId).toEqual(expect.any(String));
      expect(opened.checkoutSession).toMatchObject({
        provider: name,
        sessionId: opened.pageId,
        url: expect.stringMatching(/^https:\/\//),
        status: 'open',
        paymentStatus: 'unpaid',
      });

      expect(await provider.readPaidPage(opened.pageId)).toEqual({
        state: 'unpaid',
        pageId: opened.pageId,
        orderId,
      });

      expect(await provider.closePaymentPage(opened.pageId)).toEqual({ state: 'closed' });
      // a page closed before is closed still
      expect(await provider.closePaymentPage(opened.pageId)).toEqual({ state: 'closed' });
    });

    it('gives the same page back to the same order and reservation', async () => {
      const order = orderOf(newOrderId());
      const first = await provider.openPaymentPage(order);
      harness.keepPage(first.pageId);

      const again = await provider.openPaymentPage(order);

      expect(again.pageId).toBe(first.pageId);
      await provider.closePaymentPage(first.pageId);
    });

    it('gives money of a payment back and finds the refund by the key of the transfer', async () => {
      const paymentId = await harness.payment(2000);
      const transfer = {
        orderId: newOrderId(),
        paymentId,
        amount: '5.00',
        key: `contract:${randomUUID()}`,
      };
      const { key } = transfer;

      const answer = await provider.refundPayment(transfer);

      expect(answer).toMatchObject({ status: 'succeeded', refundId: expect.any(String) });

      // the same transfer asked again is the same refund, never a second one
      const repeated = await provider.refundPayment(transfer);
      expect(repeated.refundId).toBe(answer.refundId);

      expect(await provider.findRefund({ paymentId, key })).toMatchObject({
        refundId: answer.refundId,
        status: 'succeeded',
      });
      expect(await provider.findRefund({ paymentId, key: `contract:${randomUUID()}` })).toBeNull();

      const refunds = await provider.listRefunds(paymentId);
      expect(refunds).toEqual([
        expect.objectContaining({
          refundId: answer.refundId,
          amount: '5.00',
          transferKey: key,
          status: 'succeeded',
          createdAt: expect.any(Date),
        }),
      ]);

      expect(await provider.getRefund(answer.refundId!)).toMatchObject({
        refundId: answer.refundId,
        status: 'succeeded',
      });
    });

    const refuses = harness.refuseNextRefund ? it : it.skip;
    refuses(
      'answers a refund it refused with the reason in our words, without throwing',
      async () => {
        const paymentId = await harness.payment(2000);
        harness.refuseNextRefund!();

        const answer = await provider.refundPayment({
          orderId: newOrderId(),
          paymentId,
          amount: '5.00',
          key: `contract:${randomUUID()}`,
        });

        expect(answer.status).toBe('failed');
        expect(REFUND_FAILURES).toContain(answer.failure);
        expect(answer.failureText).toEqual(expect.any(String));
      },
    );

    it('answers a refund it could not be asked for as pending, without an id', async () => {
      const paymentId = await harness.payment(2000);

      const answer = await harness.outOfReach(() =>
        provider.refundPayment({
          orderId: newOrderId(),
          paymentId,
          amount: '5.00',
          key: `contract:${randomUUID()}`,
        }),
      );

      expect(answer).toEqual({ refundId: null, status: 'pending', bankReference: null });
    });

    it('says it cannot be reached when it is asked about a refund or a page', async () => {
      const paymentId = await harness.payment(2000);
      const made = await provider.refundPayment({
        orderId: newOrderId(),
        paymentId,
        amount: '5.00',
        key: `contract:${randomUUID()}`,
      });

      const asked = await harness.outOfReach(async () => ({
        refund: await rejectedBy(() => provider.getRefund(made.refundId!)),
        list: await rejectedBy(() => provider.listRefunds(paymentId)),
        page: await rejectedBy(() => provider.readPaidPage(`${made.refundId}`)),
      }));

      expect(codeOf(asked.refund)).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      expect(codeOf(asked.list)).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      expect(codeOf(asked.page)).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    });

    // anybody can post to the path of its events: only what the provider signed is taken
    it('refuses an event nobody signed on every path its events come to', async () => {
      expect(provider.callbackPaths.length).toBeGreaterThan(0);

      for (const url of provider.callbackPaths) {
        const res = await app.inject({
          method: 'POST',
          url,
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ id: `contract-${randomUUID()}`, type: 'payment.paid' }),
        });

        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).toBeLessThan(500);
      }
    });
  },
);
