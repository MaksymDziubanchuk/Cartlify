import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { giveMoneyRight } from '../../../helpers/moneyManager.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  stockOf,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { watchMail } from '../../../helpers/mail.js';
import { holdForReview, warnOfFraud } from '../../../helpers/orders.js';
import { placePaidOrder } from '../../../helpers/payments.js';
import {
  closeOpenSessions,
  deliver,
  refundAtStripe,
  refundsOf,
  stripeEvent,
} from '../../../helpers/stripe.js';

// POST /api/orders/:orderId/holds/:reason/decision: root decides on what holds a paid order from
// its sending and is root's to let go: a refund made
// by hand in the dashboard of Stripe of part of the order (hand_refund) and an early warning of fraud
// of the network of the card (fraud_warning). ship: the hold goes and the order may be sent (a refund
// made by hand becomes a compensation); cancel: root cancels the whole order by a statement of the
// shop, the refunds made by hand are shared among the items and the delivery (its transfer takes them
// as money sent first), and the rest goes back through Stripe with the usual mails of a cancel by the
// shop. A dispute and a review of Stripe are let go by
// the system only. The function of the database is db/orderHolds.test.ts

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
// an admin root allowed to handle the money the way root does
let manager: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  manager = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id, root.id, manager.id);
  await giveMoneyRight(root.id, manager.id);
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

const decide = (
  orderId: number,
  reason: string,
  body: Record<string, unknown>,
  actor: TestUser = root,
) =>
  app.inject({
    method: 'POST',
    url: `/api/orders/${orderId}/holds/${reason}/decision`,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload: body,
  });

// a paid order of two units at 10, a total of 20, that waits to be sent
async function paidOrder() {
  const buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(buyer.id);
  const product = await createProduct({ price: 10, stock: 10 });
  products.push(product);
  const placed = await placePaidOrder(app, csrf, buyer, product, { quantity: 2 });
  return { ...placed, buyer, product };
}

// an admin gave part of the money back in the dashboard of Stripe: the order is held for root
async function partlyRefundedByHand() {
  const order = await paidOrder();
  const refund = await refundAtStripe(order.paymentId, { amount: 500 });
  const res = await deliver(app, await stripeEvent('refund.created', refund.id));
  expect(res.statusCode).toBe(200);
  const line = await asAdmin((tx) =>
    tx.moneyLog.findFirstOrThrow({
      where: { refundId: refund.id, event: 'money.refund' },
      select: { id: true },
    }),
  );
  return { ...order, refund, lineId: line.id };
}

const orderOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, holds: true } }),
  );

const auditOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'order', entityId: orderId, event: 'order.hold_decide' },
      select: { actorId: true, actorRole: true, meta: true },
    }),
  );

const statementsOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.orderReturn.findMany({
      where: { orderId },
      select: { id: true, source: true, reason: true, closedAt: true, refundedTotal: true },
    }),
  );

describe('root decides on a refund made by hand of part of an order', () => {
  it('ships: the hold goes and the refund is a compensation', async () => {
    const order = await partlyRefundedByHand();

    const res = await decide(order.orderId, 'hand_refund', {
      decision: 'ship',
      note: '  The buyer was paid back for a scratch  ',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: order.orderId, status: 'paid', holds: [] });
    const line = await asAdmin((tx) =>
      tx.moneyLog.findUniqueOrThrow({
        where: { id: order.lineId },
        select: { moneyUse: true, meta: true, returnId: true },
      }),
    );
    expect(line).toEqual({ moneyUse: 'compensation', meta: [], returnId: null });
    expect(await auditOf(order.orderId)).toEqual([
      {
        actorId: root.id,
        actorRole: 'ROOT',
        meta: [
          { field: 'reason', old: null, new: 'hand_refund' },
          { field: 'decision', old: null, new: 'ship' },
          { field: 'moneyLogIds', old: null, new: [order.lineId] },
          { field: 'note', old: null, new: 'The buyer was paid back for a scratch' },
        ],
      },
    ]);
    expect(await statementsOf(order.orderId)).toEqual([]);
    expect(await refundsOf(order.paymentId)).toHaveLength(1);
  });

  it('cancels: a statement of the shop takes the whole order and the refund, the rest goes back through Stripe', async () => {
    const order = await partlyRefundedByHand();
    const stockBefore = (await stockOf(order.product))!.stock;
    const mails = watchMail();

    const res = await decide(order.orderId, 'hand_refund', {
      decision: 'cancel',
      note: 'The buyer asked to cancel',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: order.orderId, status: 'cancelled', holds: [] });
    const [statement, ...others] = await statementsOf(order.orderId);
    expect(others).toEqual([]);
    expect(statement).toMatchObject({ source: 'admin', reason: 'shop_cancel' });
    expect(statement!.refundedTotal.toFixed(2)).toBe('20.00');
    const line = await asAdmin((tx) =>
      tx.moneyLog.findUniqueOrThrow({
        where: { id: order.lineId },
        select: { moneyUse: true, meta: true, returnId: true },
      }),
    );
    // 5 of an order of 20: all of it went to the goods, and the transfer of the cancel took it first
    expect(line).toEqual({
      moneyUse: 'goods',
      meta: [expect.objectContaining({ amount: 5 })],
      returnId: null,
    });
    // the refund made by hand and the rest of the app
    const refunds = await refundsOf(order.paymentId);
    expect(refunds.map((one) => one.amount).sort((a, b) => a - b)).toEqual([500, 1500]);
    expect((await stockOf(order.product))!.stock).toBe(stockBefore + 2);
    expect(await auditOf(order.orderId)).toEqual([
      expect.objectContaining({
        meta: expect.arrayContaining([
          { field: 'decision', old: null, new: 'cancel' },
          { field: 'returnId', old: null, new: statement!.id },
        ]),
      }),
    ]);
    // the usual mails of a cancel by the shop: the statement, and its money
    const subjects = mails
      .filter((mail) => mail.to.includes(order.buyer.email))
      .map((mail) => mail.subject);
    expect(subjects).toEqual([
      expect.stringContaining(`Return of order #${order.orderId} registered`),
      expect.stringContaining(`#${order.orderId}`),
    ]);
  });
});

describe('root decides on an early warning of fraud', () => {
  it('ships: the hold goes, nothing else', async () => {
    const order = await paidOrder();
    await warnOfFraud(order.orderId);

    const res = await decide(order.orderId, 'fraud_warning', { decision: 'ship', note: 'Checked' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'paid', holds: [] });
    expect(await refundsOf(order.paymentId)).toEqual([]);
    expect(await auditOf(order.orderId)).toEqual([
      expect.objectContaining({
        meta: [
          { field: 'reason', old: null, new: 'fraud_warning' },
          { field: 'decision', old: null, new: 'ship' },
          { field: 'moneyLogIds', old: null, new: [] },
          { field: 'note', old: null, new: 'Checked' },
        ],
      }),
    ]);
  });

  it('cancels: a statement of the shop takes the whole order and all of the money goes back', async () => {
    const order = await paidOrder();
    await warnOfFraud(order.orderId);
    const mails = watchMail();

    const res = await decide(order.orderId, 'fraud_warning', {
      decision: 'cancel',
      note: 'The card was stolen',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'cancelled', holds: [] });
    expect((await refundsOf(order.paymentId)).map((one) => one.amount)).toEqual([2000]);
    const [statement] = await statementsOf(order.orderId);
    expect(statement).toMatchObject({ reason: 'shop_cancel' });
    const texts = mails
      .filter((mail) => mail.to.includes(order.buyer.email))
      .map((mail) => `${mail.subject}\n${mail.text}`);
    expect(texts).toHaveLength(2);
    for (const text of texts) expect(text).not.toMatch(/fraud/i);
  });

  it('keeps the other holds of the order', async () => {
    const order = await paidOrder();
    await warnOfFraud(order.orderId);
    const reviewId = await holdForReview(order.orderId);

    const res = await decide(order.orderId, 'fraud_warning', { decision: 'ship', note: 'Checked' });

    expect(res.statusCode).toBe(200);
    expect((await orderOf(order.orderId)).holds).toEqual([
      { reason: 'payment_review', since: expect.any(String), ref: reviewId },
    ]);
  });
});

describe('what root may not decide', () => {
  it('lets root and an admin root allowed: an admin without the right and the buyer are refused', async () => {
    const order = await paidOrder();
    await warnOfFraud(order.orderId);

    for (const actor of [admin, order.buyer]) {
      const res = await decide(
        order.orderId,
        'fraud_warning',
        { decision: 'ship', note: 'x' },
        actor,
      );
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        errorCode: actor === admin ? 'MONEY_MANAGER_REQUIRED' : 'INSUFFICIENT_ROLE',
      });
    }
    expect((await orderOf(order.orderId)).holds).toHaveLength(1);

    const byManager = await decide(
      order.orderId,
      'fraud_warning',
      { decision: 'ship', note: 'Checked with the buyer by phone' },
      manager,
    );
    expect(byManager.statusCode).toBe(200);
    expect((await orderOf(order.orderId)).holds).toEqual([]);
  });

  it('refuses a reason that does not hold the order, or an order that is not there (ORDER_HOLD_NOT_FOUND)', async () => {
    const order = await paidOrder();
    await warnOfFraud(order.orderId);

    const notHeld = await decide(order.orderId, 'hand_refund', { decision: 'ship', note: 'x' });
    const noOrder = await decide(2_147_483_000, 'fraud_warning', { decision: 'ship', note: 'x' });

    for (const res of [notHeld, noOrder]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'ORDER_HOLD_NOT_FOUND' });
    }
    expect(await auditOf(order.orderId)).toEqual([]);
  });

  it('refuses a note of spaces only (ORDER_HOLD_NOTE_REQUIRED)', async () => {
    const order = await paidOrder();
    await warnOfFraud(order.orderId);

    const res = await decide(order.orderId, 'fraud_warning', { decision: 'ship', note: '   ' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_HOLD_NOTE_REQUIRED' });
  });

  // a dispute and a review of Stripe are the system's to let go
  it.each([
    ['dispute', { decision: 'ship', note: 'x' }],
    ['payment_review', { decision: 'ship', note: 'x' }],
    ['fraud_warning', { decision: 'keep', note: 'x' }],
    ['fraud_warning', { decision: 'ship' }],
    ['fraud_warning', { decision: 'ship', note: 'x'.repeat(501) }],
  ])('refuses %s with %j (VALIDATION_ERROR)', async (reason, body) => {
    const order = await paidOrder();
    await warnOfFraud(order.orderId);

    const res = await decide(order.orderId, reason, body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});
