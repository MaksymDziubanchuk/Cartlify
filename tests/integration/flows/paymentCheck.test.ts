import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { alertsOf } from '../../helpers/alerts.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  stockOf,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { watchMail, type SentMail } from '../../helpers/mail.js';
import { placePaidOrder } from '../../helpers/payments.js';
import { journeyOf, mailTo, mailsTo } from '../../helpers/returnJourney.js';
import {
  closeOpenSessions,
  craftEvent,
  deliver,
  earlyFraudWarningOf,
  paymentReviewOf,
  refundsOf,
} from '../../helpers/stripe.js';

// A check of a payment Stripe asks the shop for, each step with what its actor sees:
// an early warning of fraud of the network
// of the card holds an order not sent until root decides to send it or to cancel it; a review of the
// payment holds it until Stripe closes the review. The buyer is told once that the payment is
// checked before the order goes and sees the order so, never a word of fraud (a warning can be
// wrong); after the decision the usual mails follow. The rules of each step are the tests of the
// routes (api/payments/fraudWarnings.test.ts, api/payments/reviews.test.ts,
// api/orders/holds.test.ts)

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];
const j = journeyOf(
  () => app,
  () => csrf,
);

// what waits for root, or for the admins to send, is found in the list an alert names, narrowed to
// the buyer of the test (the alerts are shared by every file that runs at the same time)
const alerts = alertsOf({ app: () => app, csrf: () => csrf });
const listedIn = async (actor: TestUser, kind: string, buyer: TestUser) =>
  (await alerts.listOf(actor, kind, { userId: buyer.id })).items.map((row) => row.id);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  userIds.push(admin.id, root.id);
});

afterAll(async () => {
  try {
    await closeOpenSessions();
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

// a buyer of the test and an order of two units at 10 (no delivery to pay: 20 in all) that Stripe
// took the money for; not sent yet
async function paidOrder() {
  const buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(buyer.id);
  const product = await createProduct({ price: 10, stock: 10, name: `Desk lamp ${buyer.id}` });
  products.push(product);
  const placed = await placePaidOrder(app, csrf, buyer, product, { quantity: 2 });
  return { ...placed, buyer, product };
}

// Stripe tells the app of a check of the payment
async function tell(type: string, object: unknown) {
  const res = await deliver(app, craftEvent(type, object));
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ received: true });
}

const CHECK = 'We are checking the payment for order #';

const toBuyer = (mails: SentMail[], buyer: TestUser) => mailsTo(mails, buyer.email, '');

const buyerCardOf = async (buyer: TestUser, orderId: number) =>
  (await j.get(buyer, `/api/orders/${orderId}`)).json();

// the buyer is told the payment is checked, and sees the order so; the admin cannot send it
async function heldForCheck(
  order: Awaited<ReturnType<typeof paidOrder>>,
  mails: SentMail[],
  reason: string,
) {
  const told = mailTo(mails, order.buyer.email, `${CHECK}${order.orderId}`);
  expect(told.text).toContain('Before we send the order, we check the payment once more.');
  expect(`${told.subject}\n${told.text}\n${told.html}`).not.toMatch(/fraud/i);
  const seen = await buyerCardOf(order.buyer, order.orderId);
  expect(seen).toMatchObject({ status: 'paid', paymentCheck: true });
  expect(JSON.stringify(seen)).not.toMatch(/fraud/i);

  const ship = await j.patch(admin, `/api/orders/${order.orderId}/status`, { status: 'shipped' });
  expect(ship.statusCode).toBe(409);
  expect(ship.json()).toMatchObject({
    errorCode: 'ORDER_ON_HOLD',
    details: { orderId: order.orderId, holds: [reason] },
  });
}

describe('an early warning of fraud of an order not sent', () => {
  // the network of the card warns, the buyer is told the payment is checked; root finds the order
  // among those a warning holds
  async function warned() {
    const order = await paidOrder();
    const mails = watchMail();
    await tell('radar.early_fraud_warning.created', await earlyFraudWarningOf(order.paymentId));

    await heldForCheck(order, mails, 'fraud_warning');
    expect(await listedIn(root, 'fraud_warnings', order.buyer)).toEqual([order.orderId]);
    // the order it holds is not among the paid orders the admins are to send
    expect(await listedIn(admin, 'paid_orders_waiting', order.buyer)).toEqual([]);
    return { ...order, mails };
  }

  it('is sent when root says so: the check is over and the buyer gets the mail of the sending', async () => {
    const { buyer, orderId, paymentId, mails } = await warned();

    const decided = await j.post(root, `/api/orders/${orderId}/holds/fraud_warning/decision`, {
      decision: 'ship',
      note: 'The buyer confirmed the order by phone.',
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ status: 'paid', holds: [] });
    expect((await buyerCardOf(buyer, orderId)).paymentCheck).toBe(false);
    expect(await listedIn(root, 'fraud_warnings', buyer)).toEqual([]);

    // the admin finds it among the paid orders to send
    expect(await listedIn(admin, 'paid_orders_waiting', buyer)).toEqual([orderId]);
    const shipped = await j.patch(admin, `/api/orders/${orderId}/status`, {
      status: 'shipped',
      shipment: { carrier: 'Nova Poshta', trackingNumber: '20450000000031' },
    });
    expect(shipped.statusCode).toBe(200);
    expect(toBuyer(mails, buyer).map((mail) => mail.subject)).toEqual([
      expect.stringContaining(`${CHECK}${orderId}`),
      expect.stringContaining(`Order #${orderId} is shipped`),
    ]);
    expect(await refundsOf(paymentId)).toEqual([]);
  });

  it('is cancelled when root says so: all of the money goes back with the usual mails, still without a word of fraud', async () => {
    const { buyer, product, orderId, paymentId, mails } = await warned();
    const before = (await stockOf(product)).stock;

    const decided = await j.post(root, `/api/orders/${orderId}/holds/fraud_warning/decision`, {
      decision: 'cancel',
      note: 'The owner of the card says it was stolen.',
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ status: 'cancelled', holds: [] });
    expect(await listedIn(root, 'fraud_warnings', buyer)).toEqual([]);

    // the statement of the shop, then its money in all
    mailTo(mails, buyer.email, `Return of order #${orderId} registered`);
    expect(mailTo(mails, buyer.email, `Return of order #${orderId} is closed`).text).toContain(
      'We sent you €20.00.',
    );
    const told = toBuyer(mails, buyer);
    expect(told).toHaveLength(3);
    for (const mail of told) expect(`${mail.subject}\n${mail.text}`).not.toMatch(/fraud|stolen/i);

    const seen = await buyerCardOf(buyer, orderId);
    expect(seen).toMatchObject({ status: 'cancelled', paymentCheck: false });
    expect(seen.withdrawals).toEqual([expect.objectContaining({ refundedTotal: 20 })]);
    expect((await refundsOf(paymentId)).map((one) => one.amount)).toEqual([2000]);
    expect((await stockOf(product)).stock).toBe(before + 2);
  });
});

describe('an early warning of fraud of an order already sent', () => {
  it('holds nothing and tells the buyer nothing; root finds the order marked among those warned after they went', async () => {
    const order = await paidOrder();
    const { buyer, orderId, paymentId } = order;
    expect(
      (await j.patch(admin, `/api/orders/${orderId}/status`, { status: 'shipped' })).statusCode,
    ).toBe(200);
    const mails = watchMail();

    await tell('radar.early_fraud_warning.created', await earlyFraudWarningOf(paymentId));

    // the order went already: nothing to hold, no mail, the buyer sees it as before
    expect(toBuyer(mails, buyer)).toEqual([]);
    expect(await buyerCardOf(buyer, orderId)).toMatchObject({
      status: 'shipped',
      paymentCheck: false,
    });

    // root finds it among the orders sent that got a warning, the card of the order marks it
    expect(await listedIn(root, 'fraud_warnings_shipped', buyer)).toEqual([orderId]);
    expect(await listedIn(root, 'fraud_warnings', buyer)).toEqual([]);
    const card = (await j.get(root, `/api/orders/${orderId}`)).json();
    expect(card).toMatchObject({ status: 'shipped', holds: [], fraudWarnedAt: expect.any(String) });
    expect(await refundsOf(paymentId)).toEqual([]);
  });
});

describe('a review of the payment by Stripe', () => {
  it('holds the order while it is open, tells the buyer once, and lets the order go when Stripe approves it', async () => {
    const order = await paidOrder();
    const { buyer, orderId, paymentId } = order;
    const mails = watchMail();
    const review = await paymentReviewOf(paymentId);

    await tell('review.opened', review);
    await heldForCheck(order, mails, 'payment_review');
    // root sees the order among those a review of Stripe holds
    expect(await listedIn(root, 'payment_reviews', buyer)).toEqual([orderId]);

    // the shop approves the payment in the dashboard of Stripe: the order may go
    await tell(
      'review.closed',
      await paymentReviewOf(paymentId, { id: review.id, closedReason: 'approved' }),
    );
    expect((await buyerCardOf(buyer, orderId)).paymentCheck).toBe(false);
    expect(await listedIn(root, 'payment_reviews', buyer)).toEqual([]);
    expect(await listedIn(admin, 'paid_orders_waiting', buyer)).toEqual([orderId]);
    const shipped = await j.patch(admin, `/api/orders/${orderId}/status`, { status: 'shipped' });
    expect(shipped.statusCode).toBe(200);
    expect(toBuyer(mails, buyer).map((mail) => mail.subject)).toEqual([
      expect.stringContaining(`${CHECK}${orderId}`),
      expect.stringContaining(`Order #${orderId} is shipped`),
    ]);
  });
});
