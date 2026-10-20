import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  stockOf,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { allowLogs, takeLogs } from '../../../helpers/logs.js';
import { loseReservation, orderRowOf, placeOrder } from '../../../helpers/orders.js';
import {
  deleteOrderAsOwner,
  openPaymentPage,
  orderStateOf,
  payPage,
  refundAuditOf,
} from '../../../helpers/payments.js';
import {
  closeOpenSessions,
  deliver,
  describeWithStripe,
  openForeignSession,
  refundAtStripe,
  refundsOf,
  payCheckoutSession,
  stripeEvent,
  withStripeOutOfReach,
} from '../../../helpers/stripe.js';

// POST /api/payments/stripe/webhook with a payment the order cannot take: the stock is gone, another
// payment paid it, the items changed, the order is gone. The money goes back in full at Stripe
// for real and the refund is recorded in the admin audit log for the buyer, once per payment.
// The buyer paid a page of the test sandbox with a test card, the test delivers the event

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];
// an order keeps its product, so these products stay; the test database goes after the run
const products: TestProduct[] = [];

// a buyer whose order of 2 waits for its payment on a page the app opened
async function orderWithPage() {
  const user = await createUser();
  userIds.push(user.id);
  const product = await createProduct({ price: 25.5, stock: 5 });
  products.push(product);
  const orderId = await placeOrder(app, csrf, user, product, 'waiting', 2);
  const sessionId = await openPaymentPage(app, csrf, user, orderId);
  return { user, product, orderId, sessionId };
}

const setStock = (productId: number, stock: number) =>
  asAdmin((tx) => tx.product.update({ where: { id: productId }, data: { stock } }));

// the reservation timer took the stock back and somebody bought it, then the buyer paid the page
async function paymentAfterTheStockIsGone() {
  const order = await orderWithPage();
  await loseReservation(order.orderId);
  await setStock(order.product.id, 1);
  const paid = await payPage(order.sessionId);
  return { ...order, ...paid };
}

const confirmAgain = (user: TestUser, orderId: number) =>
  app.inject({
    method: 'POST',
    url: '/api/orders/current/confirm',
    headers: withCsrf(csrf, accessCookie(user)),
    payload: { orderId },
  });

// the record of the refund, as the admin audit log keeps it for the buyer
const refundRecord = (
  user: TestUser,
  change: { reason: string; paymentId: string; refundId: unknown },
) =>
  expect.objectContaining({
    actorId: user.id,
    actorRole: 'USER',
    meta: [
      {
        field: 'refund',
        old: null,
        new: {
          initiator: 'system',
          amount: '51.00',
          currency: 'eur',
          provider: 'stripe',
          ...change,
        },
      },
    ],
  });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);

  // the test environment has no SendGrid key: a paid order logs that its mail was not sent,
  // webhookPaid.test.ts checks the line
  allowLogs({ msg: 'order paid mail was not sent', reason: 'SENDGRID_API_KEY_REQUIRED' });
});

afterAll(async () => {
  try {
    await closeOpenSessions();
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describeWithStripe('POST /api/payments/stripe/webhook: a payment the order cannot take', () => {
  it('returns a late payment in full when the stock is gone', async () => {
    const { user, product, orderId, paymentId, event } = await paymentAfterTheStockIsGone();

    const res = await deliver(app, event);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    const refunds = await refundsOf(paymentId);
    expect(refunds).toEqual([expect.objectContaining({ amount: 5100, currency: 'eur' })]);
    expect(await orderStateOf(orderId)).toMatchObject({
      status: 'unconfirmed',
      confirmed: false,
      paymentProvider: null,
      paymentId: null,
    });
    expect(await stockOf(product.id)).toEqual({ stock: 1, reservedStock: 0 });
    expect(await refundAuditOf(orderId)).toEqual([
      refundRecord(user, {
        reason: 'OUT_OF_STOCK',
        paymentId,
        refundId: refunds[0]!.id,
      }),
    ]);
  });

  // the buyer paid the page of an earlier confirmation as well, in another tab
  it.each([
    ['paid', 'ALREADY_PAID_OTHER_PAYMENT'],
    ['delivered', 'ALREADY_PAID_OTHER_PAYMENT'],
  ] as const)('returns a second payment of an order %s by another page', async (stage, reason) => {
    const { user, orderId, sessionId: firstPage } = await orderWithPage();
    await loseReservation(orderId);
    expect((await confirmAgain(user, orderId)).statusCode).toBe(200);
    const secondPage = await openPaymentPage(app, csrf, user, orderId);
    const second = await payPage(secondPage);
    expect((await deliver(app, second.event)).statusCode).toBe(200);
    if (stage === 'delivered') {
      await asAdmin((tx) =>
        tx.order.update({ where: { id: orderId }, data: { status: 'delivered' } }),
      );
    }
    const first = await payPage(firstPage);

    const res = await deliver(app, first.event);

    expect(res.statusCode).toBe(200);
    expect(await refundsOf(first.paymentId)).toEqual([expect.objectContaining({ amount: 5100 })]);
    expect(await refundsOf(second.paymentId)).toEqual([]);
    expect(await orderStateOf(orderId)).toMatchObject({
      status: stage,
      paymentProvider: 'stripe',
      paymentId: second.paymentId,
    });
    expect(await refundAuditOf(orderId)).toEqual([
      refundRecord(user, {
        reason,
        paymentId: first.paymentId,
        refundId: expect.any(String),
      }),
    ]);
  });

  // the reservation was gone and the buyer added an item, then paid the old page
  it('returns a payment that does not match the items of the order', async () => {
    const { user, product, orderId, sessionId } = await orderWithPage();
    await loseReservation(orderId);
    const added = await app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/items`,
      headers: withCsrf(csrf, accessCookie(user)),
      payload: { productId: product.id, quantity: 1 },
    });
    expect(added.statusCode).toBe(200);
    const { paymentId, event } = await payPage(sessionId);

    const res = await deliver(app, event);

    expect(res.statusCode).toBe(200);
    expect(await refundsOf(paymentId)).toEqual([expect.objectContaining({ amount: 5100 })]);
    expect(await orderStateOf(orderId)).toMatchObject({
      status: 'unconfirmed',
      paymentProvider: null,
      paymentId: null,
    });
    const { items } = await orderRowOf(orderId);
    expect(items.reduce((sum, item) => sum + item.quantity, 0)).toBe(3);
    expect(await refundAuditOf(orderId)).toEqual([
      refundRecord(user, {
        reason: 'AMOUNT_MISMATCH',
        paymentId,
        refundId: expect.any(String),
      }),
    ]);
  });

  // the order is deleted (the account went, for example), the page names the buyer
  it('returns the payment of an order that is gone and records it for its buyer', async () => {
    const { user, orderId, sessionId } = await orderWithPage();
    await loseReservation(orderId);
    await deleteOrderAsOwner(user, orderId);
    const { paymentId, event } = await payPage(sessionId);

    const res = await deliver(app, event);

    expect(res.statusCode).toBe(200);
    expect(await refundsOf(paymentId)).toEqual([expect.objectContaining({ amount: 5100 })]);
    expect(await refundAuditOf(orderId)).toEqual([
      refundRecord(user, {
        reason: 'ORDER_NOT_FOUND',
        paymentId,
        refundId: expect.any(String),
      }),
    ]);
  });

  it('returns the money once and records it once when Stripe delivers the event again', async () => {
    const { orderId, paymentId, event } = await paymentAfterTheStockIsGone();

    await deliver(app, event);
    const again = await deliver(app, event);

    expect(again.statusCode).toBe(200);
    expect(await refundsOf(paymentId)).toHaveLength(1);
    expect(await refundAuditOf(orderId)).toHaveLength(1);
  });

  // an admin gave the money back in the Stripe dashboard before the event came
  it('records a payment Stripe gave back already', async () => {
    const { user, orderId, paymentId, event } = await paymentAfterTheStockIsGone();
    await refundAtStripe(paymentId);

    const res = await deliver(app, event);

    expect(res.statusCode).toBe(200);
    expect(await refundsOf(paymentId)).toHaveLength(1);
    expect(await refundAuditOf(orderId)).toEqual([
      refundRecord(user, { reason: 'OUT_OF_STOCK', paymentId, refundId: null }),
    ]);
  });

  // an error answer makes Stripe deliver the event again, the money must not stay taken
  it('asks Stripe again on the next delivery when the refund fails', async () => {
    const { orderId, paymentId, event } = await paymentAfterTheStockIsGone();

    const failed = await withStripeOutOfReach(() => deliver(app, event));

    expect(failed.statusCode).toBe(500);
    expect(takeLogs({ msg: 'request failed', reason: 'STRIPE_REFUND_FAILED' })).toHaveLength(1);
    expect(await refundsOf(paymentId)).toEqual([]);
    expect(await refundAuditOf(orderId)).toEqual([]);

    const again = await deliver(app, event);

    expect(again.statusCode).toBe(200);
    expect(await refundsOf(paymentId)).toHaveLength(1);
    expect(await refundAuditOf(orderId)).toHaveLength(1);
  });

  // a page opened before the buyer was kept in the metadata, for an order that is gone
  it('returns the money and warns when nobody is there to record it for', async () => {
    const page = await openForeignSession({
      amount: 5100,
      metadata: { entityType: 'order', entityId: '2000000000' },
    });
    const paymentId = await payCheckoutSession(page.id);
    const event = await stripeEvent('checkout.session.completed', page.id);

    const res = await deliver(app, event);

    expect(res.statusCode).toBe(200);
    expect(await refundsOf(paymentId)).toEqual([expect.objectContaining({ amount: 5100 })]);
    expect(takeLogs({ msg: 'stripe refund has no audit record: order owner is unknown' })).toEqual([
      expect.objectContaining({ orderId: 2_000_000_000, provider: 'stripe', paymentId }),
    ]);
  });

  // a page of another tool in the same Stripe account, paid there: its money is none of the app's,
  // a refund would take back a payment of somebody else
  it.each([
    ['no metadata', undefined],
    ['a broken order id', { entityType: 'order', entityId: '12abc' }],
  ])('leaves the money of a paid page with %s alone', async (_case, metadata) => {
    const page = await openForeignSession({ amount: 5100, ...(metadata ? { metadata } : {}) });
    const paymentId = await payCheckoutSession(page.id);
    const event = await stripeEvent('checkout.session.completed', page.id);

    const res = await deliver(app, event);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, skipped: 'NOT_AN_ORDER' });
    expect(await refundsOf(paymentId)).toEqual([]);
    expect(takeLogs({ msg: 'stripe event of a page that is not an order was skipped' })).toEqual([
      expect.objectContaining({ sessionId: page.id, eventType: 'checkout.session.completed' }),
    ]);
  });
});
