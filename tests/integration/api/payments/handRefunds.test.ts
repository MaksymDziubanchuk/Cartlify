import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { settleRefundsInTransit } from '@routes/api/payments/services/settleRefundsInTransit.service.js';

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
import { latePayment, moneyOfPayment, refundOf } from '../../../helpers/lateRefund.js';
import { takeLogs } from '../../../helpers/logs.js';
import { watchMail, type SentMail } from '../../../helpers/mail.js';
import { placePaidOrder, placePaidOrderOf } from '../../../helpers/payments.js';
import { returnFlows } from '../../../helpers/returnFlows.js';
import {
  closeOpenSessions,
  craftEvent,
  deliver,
  giveRefundReference,
  payByCard,
  PENDING_REFUND_CARD,
  queueRefundOutcome,
  realStripe,
  refundAtStripe,
  refundsOf,
  settleRefund,
  stripeEvent,
  withStripeOutOfReach,
} from '../../../helpers/stripe.js';

// The refunds made by hand in the dashboard of Stripe. Stripe tells
// of them with the events of a refund without the key of the app (metadata.transfer): each is one
// line of the money journal, and what it means depends on the payment:
// A - a payment the order could not take: the line of our refund in transit takes it when it is the
//     same sum, else it is a line of its own and the app sends what is left of the payment;
// B - an order not sent, no statement, all of the payment back: the system cancels the order with a
//     statement of its own and shares the refunds made by hand among the items and the delivery,
//     which pays its rows at once as money already sent; the buyer is mailed that the order is
//     cancelled and the money sent;
// V - an order not sent, part of it back: the order is held until root decides (api/orders/
//     holds.test.ts);
// G - a statement of the order waits for its money: nothing is decided by itself, root says what the
//     refund was for (POST /api/payments/money-lines/:moneyLogId/decision): the items and the
//     delivery it gave back pay the rows of the statement first, the rest is a compensation;
// D - an order sent, delivered or cancelled with nothing waiting: root says what it was for.
// Later events of the refund (refund.updated, refund.failed) settle its line as the events of a
// refund of the app do. The functions of the database behind it are db/handRefunds.test.ts; the
// list of the refunds is api/payments/refundsList.test.ts

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
// an admin root allowed to handle the money the way root does
let manager: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];
const deps = () => ({ app, csrf, users: userIds, products });

const mockOnly = realStripe ? it.skip : it;

const flows = returnFlows({ app: () => app, csrf: () => csrf, admin: () => admin });

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

const post = (url: string, payload: Record<string, unknown>, actor: TestUser = root) =>
  app.inject({
    method: 'POST',
    url,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload,
  });

const get = (url: string, actor: TestUser = admin) =>
  app.inject({ method: 'GET', url, headers: { cookie: accessCookie(actor) } });

const mailsTo = (mails: SentMail[], email: string, part = '') =>
  mails.filter((mail) => mail.to.includes(email) && mail.subject.includes(part));

// a buyer of their own, so the mails of a test are its own
async function newBuyer(locale?: string) {
  const user = await createUser({ name: 'Anna Koval', ...(locale ? { locale } : {}) });
  userIds.push(user.id);
  return user;
}

// an order of two units at 10 (no delivery to pay: a total of 20) that Stripe took the money for,
// not sent yet or sent
async function paidOrder(opts: { stage?: 'paid' | 'shipped'; card?: string } = {}) {
  const buyer = await newBuyer();
  const product = await createProduct({ price: 10, stock: 10 });
  products.push(product);
  const placed = await placePaidOrder(app, csrf, buyer, product, { quantity: 2, ...opts });
  return { ...placed, buyer, product };
}

// an admin made a statement for both units of a sent order and took the goods in: its rows wait
// for their money (20)
async function waitingStatement(orderId: number) {
  const item = await asAdmin((tx) =>
    tx.orderItem.findFirstOrThrow({ where: { orderId }, select: { id: true } }),
  );
  const card = await flows.adminStatement(orderId, item.id, 2);
  await flows.setGoods(card, 2, 'to_stock');
  return { returnId: card.id, rowId: card.items[0]!.id };
}

// money given back in the dashboard of Stripe, and the event Stripe sends of it delivered
async function refundByHand(paymentId: string, cents?: number) {
  const refund = await refundAtStripe(paymentId, cents === undefined ? {} : { amount: cents });
  const res = await deliver(app, await stripeEvent('refund.created', refund.id));
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ received: true });
  return refund;
}

// a later event of a refund, as Stripe recorded it
async function tell(type: 'refund.updated' | 'refund.failed', refundId: string) {
  const res = await deliver(app, await stripeEvent(type, refundId));
  expect(res.statusCode).toBe(200);
  return res;
}

// the line of a refund made by hand, by its id at Stripe
const handLineOf = async (paymentId: string, refundId: string) =>
  (await moneyOfPayment(paymentId)).find(
    (line) => line.event === 'money.refund' && line.refundId === refundId,
  )!;

const orderOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true, holds: true, returnStatus: true },
    }),
  );

const statementsOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.orderReturn.findMany({
      where: { orderId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        source: true,
        basis: true,
        reason: true,
        closedAt: true,
        refundedTotal: true,
      },
    }),
  );

const auditOf = (orderId: number, event: string) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'order', entityId: orderId, event },
      select: { actorId: true, actorRole: true, meta: true },
    }),
  );

// root (or another actor) says what a line of money given back by hand was for
const decide = (moneyLogId: number, body: Record<string, unknown>, actor: TestUser = root) =>
  post(`/api/payments/money-lines/${moneyLogId}/decision`, body, actor);

// the item of an order of one product
const itemOf = async (orderId: number) =>
  (
    await asAdmin((tx) =>
      tx.orderItem.findFirstOrThrow({ where: { orderId }, select: { id: true } }),
    )
  ).id;

const decisionOf = (moneyLogId: number) =>
  asAdmin((tx) =>
    tx.moneyLog.findFirstOrThrow({
      where: { id: moneyLogId },
      select: { returnId: true, moneyUse: true, meta: true },
    }),
  );

const refundsListOf = async (query: string) => {
  const res = await get(`/api/payments/refunds?${query}`);
  expect(res.statusCode).toBe(200);
  return res.json().items as Array<Record<string, unknown>>;
};

const CANCELLED_SUBJECT = 'is cancelled and your money is sent back';

describe('a refund made by hand of a payment the order could not take (A)', () => {
  // the app asked for the refund and got no answer, then an admin gave the money back in the
  // dashboard: the refund made by hand is the one of the line in transit, nothing is sent twice
  it('is the refund of the line in transit of the same sum: the line takes it, the buyer is mailed once', async () => {
    const late = await latePayment(deps());
    await withStripeOutOfReach(() => deliver(app, late.event));
    const before = await moneyOfPayment(late.paymentId);
    expect(before.at(-1)).toMatchObject({ state: 'in_transit', refundId: null });
    const mails = watchMail();

    const byHand = await refundByHand(late.paymentId);

    expect(await moneyOfPayment(late.paymentId)).toEqual([
      before[0],
      expect.objectContaining({
        id: before[1]!.id,
        purpose: 'late_payment',
        amount: '-51.00',
        state: 'sent',
        refundId: byHand.id,
        byDashboard: true,
      }),
    ]);
    expect(mailsTo(mails, late.user.email, 'We sent your payment for order #')).toHaveLength(1);
    expect(await refundsOf(late.paymentId)).toHaveLength(1);
  });

  // the refund of the app failed, an admin gave part of the money back by hand: what is left of the
  // payment is the app's to send, under a key of its own
  mockOnly(
    'is a line of its own when it is part of the payment, and the app sends what is left',
    async () => {
      queueRefundOutcome({ status: 'failed', reason: 'unknown' });
      const late = await latePayment(deps());
      await deliver(app, late.event);
      const mails = watchMail();

      const byHand = await refundByHand(late.paymentId, 2000);

      const lines = await moneyOfPayment(late.paymentId);
      expect(lines.slice(3)).toEqual([
        expect.objectContaining({
          event: 'money.refund',
          purpose: 'hand',
          amount: '-20.00',
          refundId: byHand.id,
          byDashboard: true,
          state: 'sent',
        }),
        expect.objectContaining({
          event: 'money.refund',
          purpose: 'late_payment',
          amount: '-31.00',
          state: 'sent',
          transferKey: `refund:${late.paymentId}:3100`,
        }),
      ]);
      const refunds = await refundsOf(late.paymentId);
      expect(refunds.map((one) => one.amount).sort((a, b) => a - b)).toEqual([2000, 3100, 5100]);
      const told = mailsTo(mails, late.user.email, 'We sent your payment for order #');
      expect(told).toHaveLength(1);
      expect(told[0]!.text).toContain('€31.00');
    },
  );

  it('writes nothing again for another delivery of the event', async () => {
    const late = await latePayment(deps());
    await withStripeOutOfReach(() => deliver(app, late.event));
    const byHand = await refundByHand(late.paymentId);
    const lines = await moneyOfPayment(late.paymentId);
    const mails = watchMail();

    await deliver(app, await stripeEvent('refund.created', byHand.id));

    expect(await moneyOfPayment(late.paymentId)).toEqual(lines);
    expect(mails).toEqual([]);
  });
});

describe('a refund made by hand of all of an order that was not sent (B)', () => {
  it('cancels the order by a statement of the system that takes the refund as money sent, and mails the buyer', async () => {
    const order = await paidOrder();
    const stockBefore = (await stockOf(order.product))!.stock;
    const mails = watchMail();

    const byHand = await refundByHand(order.paymentId);

    expect(await orderOf(order.orderId)).toMatchObject({ status: 'cancelled', holds: [] });
    const [statement, ...others] = await statementsOf(order.orderId);
    expect(others).toEqual([]);
    expect(statement).toMatchObject({
      source: 'system',
      basis: 'other',
      reason: 'stripe_refund',
      closedAt: expect.any(Date),
    });
    expect(statement!.refundedTotal.toFixed(2)).toBe('20.00');
    expect((await stockOf(order.product))!.stock).toBe(stockBefore + 2);

    const hand = await handLineOf(order.paymentId, byHand.id);
    expect(hand).toMatchObject({ purpose: 'hand', amount: '-20.00', state: 'sent' });
    // the refund is of the order: the system gave all of it to the goods
    const itemId = await itemOf(order.orderId);
    expect(await decisionOf(hand.id)).toEqual({
      returnId: null,
      moneyUse: 'goods',
      meta: [expect.objectContaining({ orderItemId: itemId, quantity: 2, amount: 20 })],
    });
    const lines = await asAdmin((tx) =>
      tx.moneyLog.findMany({
        where: { returnId: statement!.id },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          purpose: true,
          part: true,
          amount: true,
          coversId: true,
          transferKey: true,
          state: true,
        },
      }),
    );
    expect(lines.map((line) => ({ ...line, amount: line.amount.toFixed(2) }))).toEqual([
      expect.objectContaining({
        purpose: 'return',
        part: 'goods',
        amount: '-20.00',
        transferKey: null,
        state: 'sent',
      }),
      expect.objectContaining({
        purpose: 'return',
        part: 'covered',
        amount: '20.00',
        coversId: hand.id,
        state: 'sent',
      }),
    ]);
    // Stripe was asked for nothing: the money went back by hand
    expect((await refundsOf(order.paymentId)).map((one) => one.id)).toEqual([byHand.id]);

    // the system statement has a mail of its own instead of the mails of a statement of the shop
    expect(mails.filter((mail) => mail.to.includes(order.buyer.email))).toEqual([
      expect.objectContaining({ subject: expect.stringContaining(CANCELLED_SUBJECT) }),
    ]);
    const [mail] = mails;
    expect(mail!.subject).toContain(`#${order.orderId}`);
    expect(mail!.text).toContain('€20.00');
  });

  it('takes every refund made by hand that together gave all of it back', async () => {
    const order = await paidOrder();

    const first = await refundByHand(order.paymentId, 1500);
    expect(await orderOf(order.orderId)).toMatchObject({ status: 'paid' });
    const second = await refundByHand(order.paymentId, 500);

    expect(await orderOf(order.orderId)).toMatchObject({ status: 'cancelled', holds: [] });
    const [statement] = await statementsOf(order.orderId);
    expect(statement).toMatchObject({ reason: 'stripe_refund', closedAt: expect.any(Date) });
    expect(statement!.refundedTotal.toFixed(2)).toBe('20.00');
    for (const refund of [first, second]) {
      expect(await handLineOf(order.paymentId, refund.id)).toMatchObject({
        purpose: 'hand',
        state: 'sent',
      });
    }
    const shared = await asAdmin((tx) =>
      tx.moneyLog.findMany({
        where: { paymentId: order.paymentId, purpose: 'hand' },
        orderBy: { id: 'asc' },
        select: { returnId: true, moneyUse: true, meta: true },
      }),
    );
    // each went to the goods by its sum
    expect(shared).toEqual([
      { returnId: null, moneyUse: 'goods', meta: [expect.objectContaining({ amount: 15 })] },
      { returnId: null, moneyUse: 'goods', meta: [expect.objectContaining({ amount: 5 })] },
    ]);
  });

  it('cancels once and mails once for another delivery of the event', async () => {
    const order = await paidOrder();
    const byHand = await refundByHand(order.paymentId);
    const lines = await moneyOfPayment(order.paymentId);
    const mails = watchMail();

    await deliver(app, await stripeEvent('refund.created', byHand.id));

    expect(await statementsOf(order.orderId)).toHaveLength(1);
    expect(await moneyOfPayment(order.paymentId)).toEqual(lines);
    expect(mails).toEqual([]);
  });

  it('mails the buyer in their language', async () => {
    const buyer = await newBuyer('uk');
    const product = await createProduct({ price: 10, stock: 10 });
    products.push(product);
    const { orderId, paymentId } = await placePaidOrder(app, csrf, buyer, product, { quantity: 2 });
    const mails = watchMail();

    await refundByHand(paymentId);

    const [mail] = mailsTo(mails, buyer.email);
    expect(mail!.subject).toContain(`Замовлення #${orderId} скасовано`);
  });
});

describe('a refund made by hand of part of an order that was not sent (V)', () => {
  it('holds the order for root and makes no statement', async () => {
    const order = await paidOrder();
    const mails = watchMail();

    const byHand = await refundByHand(order.paymentId, 500);

    const line = await handLineOf(order.paymentId, byHand.id);
    expect(line).toMatchObject({
      purpose: 'hand',
      amount: '-5.00',
      state: 'sent',
      byDashboard: true,
    });
    expect(await orderOf(order.orderId)).toMatchObject({
      status: 'paid',
      holds: [{ reason: 'hand_refund', since: expect.any(String), ref: line.id }],
    });
    expect(await statementsOf(order.orderId)).toEqual([]);
    expect(mails).toEqual([]);
  });

  // no money went: root has nothing to decide, the order is sent as any other
  mockOnly('lets the order go when the refund fails', async () => {
    const order = await paidOrder();
    const byHand = await refundByHand(order.paymentId, 500);
    expect((await orderOf(order.orderId)).holds).toHaveLength(1);

    settleRefund(byHand.id, { status: 'failed', reason: 'expired_or_canceled_card' });
    await tell('refund.failed', byHand.id);

    expect(await orderOf(order.orderId)).toMatchObject({ status: 'paid', holds: [] });
  });
});

describe('a refund made by hand while a statement of the order waits for its money (G)', () => {
  async function waiting(cents = 1000) {
    const order = await paidOrder({ stage: 'shipped' });
    const statement = await waitingStatement(order.orderId);
    const byHand = await refundByHand(order.paymentId, cents);
    const line = await handLineOf(order.paymentId, byHand.id);
    return { ...order, ...statement, byHand, line, itemId: await itemOf(order.orderId) };
  }

  it('is not decided by itself: root is asked to say what it was for, the statement waits', async () => {
    const order = await waiting();

    expect(order.line).toMatchObject({ purpose: 'hand', amount: '-10.00' });
    expect((await statementsOf(order.orderId))[0]!.refundedTotal.toFixed(2)).toBe('0.00');
    expect(await refundsListOf(`state=unassigned&orderId=${order.orderId}`)).toEqual([
      expect.objectContaining({ id: order.line.id, need: 'explain', returnId: null }),
    ]);
    const refused = await post(`/api/returns/${order.returnId}/refund`, {}, admin);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ errorCode: 'RETURN_HAND_REFUND_PENDING' });
  });

  it('is given to a unit by root: the transfer of the statement takes it first and asks Stripe for the rest', async () => {
    const order = await waiting();

    const res = await decide(order.line.id, {
      items: [{ orderItemId: order.itemId, quantity: 1, amount: 10 }],
      note: '  The buyer was paid for one lamp  ',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      moneyLogId: order.line.id,
      orderId: order.orderId,
      use: 'goods',
      distributed: '10.00',
      rest: '0.00',
      // the row is of two units: one unit does not pay it whole
      covered: [],
      note: 'The buyer was paid for one lamp',
    });
    expect(await auditOf(order.orderId, 'payment.money_decision')).toEqual([
      {
        actorId: root.id,
        actorRole: 'ROOT',
        meta: [
          { field: 'moneyLogId', old: null, new: order.line.id },
          { field: 'use', old: null, new: 'goods' },
          {
            field: 'items',
            old: null,
            new: [{ orderItemId: order.itemId, quantity: 1, amount: 10 }],
          },
          { field: 'delivery', old: null, new: 0 },
          { field: 'rest', old: null, new: '0.00' },
          { field: 'note', old: null, new: 'The buyer was paid for one lamp' },
        ],
      },
    ]);
    expect(await refundsListOf(`state=unassigned&orderId=${order.orderId}`)).toEqual([]);

    const refunded = await post(`/api/returns/${order.returnId}/refund`, {}, admin);

    expect(refunded.statusCode).toBe(200);
    const refunds = await refundsOf(order.paymentId);
    expect(refunds.map((one) => one.amount).sort((a, b) => a - b)).toEqual([1000, 1000]);
    const [statement] = await statementsOf(order.orderId);
    expect(statement!.refundedTotal.toFixed(2)).toBe('20.00');
    expect(statement!.closedAt).toEqual(expect.any(Date));
    const covered = await asAdmin((tx) =>
      tx.moneyLog.findMany({
        where: { returnId: order.returnId, part: 'covered' },
        select: { amount: true, coversId: true },
      }),
    );
    expect(covered.map((line) => [line.amount.toFixed(2), line.coversId])).toEqual([
      ['10.00', order.line.id],
    ]);
  });

  // all of the payment with no other money before it: the system shares it among the items and the
  // delivery by itself, root decides nothing
  it('is shared by itself when it gives all of the payment back: the rows are paid at once, nothing asked of Stripe, and the buyer is mailed', async () => {
    const mails = watchMail();
    const order = await waiting(2000);

    const shared = await asAdmin((tx) =>
      tx.moneyLog.findUniqueOrThrow({ where: { id: order.line.id }, select: { moneyUse: true } }),
    );
    expect(shared.moneyUse).toBe('goods');
    const again = await decide(order.line.id, { items: [], note: 'Too late' });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ errorCode: 'MONEY_DECISION_DONE' });
    expect((await refundsOf(order.paymentId)).map((one) => one.id)).toEqual([order.byHand.id]);
    const [statement] = await statementsOf(order.orderId);
    expect(statement!.refundedTotal.toFixed(2)).toBe('20.00');
    expect(statement!.closedAt).toEqual(expect.any(Date));
    // the statement is over: its closing mail tells the money
    const told = mailsTo(mails, order.buyer.email, 'is closed');
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toContain('€20.00');
  });

  // a statement of a lamp and a book, both taken in; the refund was for the lamp: the decision pays
  // the row of the lamp at once and the statement waits for the book
  it('pays the row it gives all of at once and tells the buyer the money is already with them, the rest of the statement waits', async () => {
    const buyer = await newBuyer();
    const lamp = await createProduct({ price: 10, stock: 10 });
    const book = await createProduct({ price: 10, stock: 10 });
    products.push(lamp, book);
    const { orderId, paymentId } = await placePaidOrderOf(
      app,
      csrf,
      buyer,
      [
        { item: lamp, quantity: 1 },
        { item: book, quantity: 1 },
      ],
      { stage: 'shipped' },
    );
    const items = await asAdmin((tx) =>
      tx.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' }, select: { id: true } }),
    );
    const made = await post(
      '/api/returns',
      {
        orderId,
        items: items.map((one) => ({ orderItemId: one.id, quantity: 1 })),
        basis: 'other',
        reason: 'defect',
      },
      admin,
    );
    expect(made.statusCode).toBe(201);
    const card = made.json() as { id: number; items: { id: number; orderItemId: number }[] };
    const received = await post(
      `/api/returns/${card.id}/receive`,
      {
        parcel: { buyerPaid: 0 },
        results: card.items.map((one) => ({ itemId: one.id, quantity: 1, goods: 'to_stock' })),
      },
      admin,
    );
    expect(received.statusCode).toBe(200);
    const byHand = await refundByHand(paymentId, 1000);
    const line = await handLineOf(paymentId, byHand.id);
    const lampRow = card.items.find((one) => one.orderItemId === items[0]!.id)!;
    const mails = watchMail();

    const res = await decide(line.id, {
      items: [{ orderItemId: items[0]!.id, quantity: 1, amount: 10 }],
      note: 'The refund was for the lamp',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ covered: [{ returnId: card.id, itemIds: [lampRow.id] }] });
    const [statement] = await statementsOf(orderId);
    expect(statement!.refundedTotal.toFixed(2)).toBe('10.00');
    expect(statement!.closedAt).toBeNull();
    const told = mailsTo(mails, buyer.email, 'is already with you');
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toContain('You already have €10.00 back');
    expect(told[0]!.text).toContain('We sent you €10.00 of it earlier.');
    expect((await refundsOf(paymentId)).map((one) => one.id)).toEqual([byHand.id]);

    // the book goes by Stripe as always
    const refunded = await post(`/api/returns/${card.id}/refund`, {}, admin);
    expect(refunded.statusCode).toBe(200);
    expect((await refundsOf(paymentId)).map((one) => one.amount).sort()).toEqual([1000, 1000]);
    expect((await statementsOf(orderId))[0]!.closedAt).toEqual(expect.any(Date));
  });

  // the transfer of 20 took the 10 root gave to a unit first and asked the card for 10: the card
  // refused 10, the other 10 are with the buyer
  mockOnly(
    'tells the buyer only what the card did not take when the transfer that took it first fails',
    async () => {
      const order = await waiting();
      const decided = await decide(order.line.id, {
        items: [{ orderItemId: order.itemId, quantity: 1, amount: 10 }],
        note: 'The buyer was paid for one lamp',
      });
      expect(decided.statusCode).toBe(200);
      queueRefundOutcome({ status: 'failed', reason: 'expired_or_canceled_card' });
      const mails = watchMail();

      const res = await post(`/api/returns/${order.returnId}/refund`, {}, admin);

      expect(res.statusCode).toBe(200);
      const told = mailsTo(mails, order.buyer.email, 'We could not return the money');
      expect(told).toHaveLength(1);
      expect(told[0]!.text).toContain('€10.00');
      expect(told[0]!.text).not.toContain('€20.00');
    },
  );

  it('is a compensation by root: the statement goes on as always', async () => {
    const order = await waiting();

    const res = await decide(order.line.id, { items: [], note: 'A gesture for the late parcel' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ use: 'compensation', distributed: '0.00', rest: '10.00' });
    expect(await decisionOf(order.line.id)).toEqual({
      returnId: null,
      moneyUse: 'compensation',
      meta: [],
    });
    expect(await refundsListOf(`state=unassigned&orderId=${order.orderId}`)).toEqual([]);
    // the rows still owe all of their money, and the gesture took 10 of the 20 of the payment: the
    // card tells it, 20 due and 10 left of the payment
    expect((await statementsOf(order.orderId))[0]!.refundedTotal.toFixed(2)).toBe('0.00');
    expect((await get(`/api/returns/${order.returnId}`)).json().moneyLeft).toEqual({
      rows: 20,
      delivery: 0,
      wayBack: 0,
      total: 20,
      due: 20,
      covered: 0,
      paymentLeft: 10,
      short: true,
    });
  });
});

describe('a refund made by hand while a statement whose money goes by itself waits for it', () => {
  // the buyer withdraws all of an order not sent after part of it went back by hand: the money of the
  // withdrawal waits for root; once root says what the refund was, it goes by itself
  mockOnly(
    'sends the money of the statement by itself once root decided, what root gave the goods first',
    async () => {
      const order = await paidOrder();
      const byHand = await refundByHand(order.paymentId, 500);
      const line = await handLineOf(order.paymentId, byHand.id);
      const withdrawn = await post(`/api/orders/${order.orderId}/withdrawal`, {}, order.buyer);
      expect(withdrawn.statusCode).toBe(201);
      expect(takeLogs({ msg: 'return refund was not started' })).toEqual([
        expect.objectContaining({ code: 'RETURN_HAND_REFUND_PENDING' }),
      ]);
      expect((await refundsOf(order.paymentId)).map((one) => one.amount)).toEqual([500]);

      const decided = await decide(line.id, {
        items: [{ orderItemId: await itemOf(order.orderId), quantity: 1, amount: 5 }],
        note: 'For a unit.',
      });

      expect(decided.statusCode).toBe(200);
      expect(
        (await refundsOf(order.paymentId)).map((one) => one.amount).sort((a, b) => a - b),
      ).toEqual([500, 1500]);
    },
  );
});

describe('a refund made by hand of an order that was sent, with nothing waiting (D)', () => {
  it('is for root to say what it was for, nothing else happens', async () => {
    const order = await paidOrder({ stage: 'shipped' });
    const mails = watchMail();

    const byHand = await refundByHand(order.paymentId, 500);

    const line = await handLineOf(order.paymentId, byHand.id);
    expect(await orderOf(order.orderId)).toMatchObject({ status: 'shipped', holds: [] });
    expect(await statementsOf(order.orderId)).toEqual([]);
    expect(await refundsListOf(`state=unassigned&orderId=${order.orderId}`)).toEqual([
      expect.objectContaining({ id: line.id, need: 'explain' }),
    ]);
    expect(mails).toEqual([]);

    const res = await decide(line.id, { items: [], note: 'Goodwill' });
    expect(res.statusCode).toBe(200);
    expect(await refundsListOf(`state=unassigned&orderId=${order.orderId}`)).toEqual([]);
    expect(mails).toEqual([]);
  });
});

describe('what root may not decide on a refund made by hand', () => {
  async function shippedWithRefund() {
    const order = await paidOrder({ stage: 'shipped' });
    const byHand = await refundByHand(order.paymentId, 500);
    return {
      ...order,
      line: await handLineOf(order.paymentId, byHand.id),
      itemId: await itemOf(order.orderId),
    };
  }

  it('lets root and an admin root allowed: an admin without the right and a buyer are refused', async () => {
    const order = await shippedWithRefund();

    for (const actor of [admin, order.buyer]) {
      const res = await decide(order.line.id, { items: [], note: 'x' }, actor);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        errorCode: actor === admin ? 'MONEY_MANAGER_REQUIRED' : 'INSUFFICIENT_ROLE',
      });
    }

    const byManager = await decide(
      order.line.id,
      { items: [], note: 'Goodwill for a late parcel' },
      manager,
    );
    expect(byManager.statusCode).toBe(200);
  });

  it('refuses a line that is no money given back by hand or taken by a bank (MONEY_DECISION_NOT_FOUND)', async () => {
    const order = await shippedWithRefund();
    const [payment] = await moneyOfPayment(order.paymentId);

    for (const id of [payment!.id, 2_147_483_000]) {
      const res = await decide(id, { items: [], note: 'x' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'MONEY_DECISION_NOT_FOUND' });
    }
  });

  // the money of a payment the order never took is no money of its goods: shared among the items it
  // would pay the rows of a statement of the order with the money of another payment (api/payments/refundsList.test.ts:
  // root is not asked)
  mockOnly(
    'refuses a refund made by hand of a payment the order could not take (MONEY_DECISION_NOT_FOUND)',
    async () => {
      queueRefundOutcome({ status: 'failed', reason: 'unknown' });
      const late = await latePayment(deps());
      await deliver(app, late.event);
      const byHand = await refundByHand(late.paymentId, 2000);
      const line = await handLineOf(late.paymentId, byHand.id);

      const res = await decide(line.id, {
        items: [{ orderItemId: await itemOf(late.orderId), quantity: 1, amount: 10 }],
        note: 'For a unit',
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'MONEY_DECISION_NOT_FOUND' });
    },
  );

  // a decision is redone while no statement took its shares;
  // one whose shares a statement took is refused (MONEY_DECISION_DONE: the case of the line shared
  // by itself above)
  it('redoes a decision no statement took the shares of: the journal keeps the old split by the new', async () => {
    const order = await shippedWithRefund();
    await decide(order.line.id, { items: [], note: 'Goodwill' });

    const again = await decide(order.line.id, {
      items: [{ orderItemId: order.itemId, quantity: 1, amount: 5 }],
      note: 'It was the lamp',
    });

    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ use: 'goods', distributed: '5.00', rest: '0.00' });
    const journal = await auditOf(order.orderId, 'payment.money_decision');
    expect(journal).toHaveLength(2);
    expect(journal[1]!.meta).toEqual(
      expect.arrayContaining([
        { field: 'use', old: 'compensation', new: 'goods' },
        {
          field: 'items',
          old: [],
          new: [{ orderItemId: order.itemId, quantity: 1, amount: 5 }],
        },
        { field: 'delivery', old: 0, new: 0 },
      ]),
    );
  });

  it('refuses an item of another order, or more units than it has (MONEY_DECISION_INVALID)', async () => {
    const order = await shippedWithRefund();
    const other = await paidOrder({ stage: 'shipped' });

    for (const item of [
      { orderItemId: await itemOf(other.orderId), quantity: 1, amount: 5 },
      { orderItemId: order.itemId, quantity: 3, amount: 5 },
    ]) {
      const res = await decide(order.line.id, { items: [item], note: 'x' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'MONEY_DECISION_INVALID' });
    }
    expect(await decisionOf(order.line.id)).toMatchObject({ moneyUse: null, meta: null });
  });

  it('refuses more than the units cost or than the line gave back (MONEY_DECISION_EXCEEDS)', async () => {
    const order = await shippedWithRefund();

    for (const body of [
      { items: [{ orderItemId: order.itemId, quantity: 1, amount: 11 }], note: 'x' },
      { items: [{ orderItemId: order.itemId, quantity: 1, amount: 6 }], note: 'x' },
      { items: [], delivery: 1, note: 'x' },
    ]) {
      const res = await decide(order.line.id, body);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'MONEY_DECISION_EXCEEDS' });
    }
  });

  it('refuses a note of spaces only (MONEY_DECISION_NOTE_REQUIRED)', async () => {
    const order = await shippedWithRefund();

    const res = await decide(order.line.id, { items: [], note: '   ' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'MONEY_DECISION_NOTE_REQUIRED' });
  });

  it.each([
    { items: [], note: 'x'.repeat(501) },
    { items: [] },
    { note: 'x' },
    { items: [{ orderItemId: 1, quantity: 0, amount: 1 }], note: 'x' },
    { items: [{ orderItemId: 1, quantity: 1, amount: 0 }], note: 'x' },
    { items: [{ orderItemId: 1, quantity: 1, amount: 1.234 }], note: 'x' },
    { items: [{ orderItemId: 1, quantity: 1 }], note: 'x' },
    { items: [], delivery: -1, note: 'x' },
  ])('refuses a body that is none: %j', async (body) => {
    const order = await shippedWithRefund();

    const res = await decide(order.line.id, body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it.each(['re_1', '0', '2147483648'])('refuses an id %p that is none', async (id) => {
    const res = await post(`/api/payments/money-lines/${id}/decision`, { items: [], note: 'x' });

    expect(res.statusCode).toBe(400);
  });
});

describe('the later events of a refund', () => {
  mockOnly('tell a refund made by hand that was pending sent', async () => {
    const order = await paidOrder({ stage: 'shipped', card: PENDING_REFUND_CARD });
    const byHand = await refundByHand(order.paymentId, 500);
    expect(await handLineOf(order.paymentId, byHand.id)).toMatchObject({ state: 'in_transit' });

    settleRefund(byHand.id, { status: 'succeeded' });
    await tell('refund.updated', byHand.id);

    expect(await handLineOf(order.paymentId, byHand.id)).toMatchObject({ state: 'sent' });
  });

  // the event Stripe sent of it was lost: the worker asks Stripe where a refund made by hand that is
  // still pending stands
  mockOnly('are asked of Stripe by the worker for a refund made by hand left pending', async () => {
    const order = await paidOrder({ stage: 'shipped', card: PENDING_REFUND_CARD });
    const byHand = await refundByHand(order.paymentId, 500);
    settleRefund(byHand.id, { status: 'succeeded' });

    const settled = await settleRefundsInTransit(
      { info: () => undefined, warn: () => undefined, error: () => undefined },
      { olderThanMs: 0, paymentId: order.paymentId },
    );

    expect(settled).toBe(1);
    expect(await handLineOf(order.paymentId, byHand.id)).toMatchObject({ state: 'sent' });
  });

  // the bank of the card gives the number some days after the money is sent: it is kept once, a
  // second number changes nothing
  mockOnly('write the number the bank gives a refund made by hand, once', async () => {
    const order = await paidOrder({ stage: 'shipped' });
    const byHand = await refundByHand(order.paymentId, 500);

    giveRefundReference(byHand.id, 'ARN-HAND-1');
    await tell('refund.updated', byHand.id);
    giveRefundReference(byHand.id, 'ARN-HAND-2');
    await tell('refund.updated', byHand.id);

    expect(await handLineOf(order.paymentId, byHand.id)).toMatchObject({ state: 'sent' });
    const line = await asAdmin((tx) =>
      tx.moneyLog.findFirstOrThrow({
        where: { refundId: byHand.id, event: 'money.refund' },
        select: { bankReference: true },
      }),
    );
    expect(line.bankReference).toBe('ARN-HAND-1');
  });

  mockOnly('write the number the bank gives a refund of the app on every line of it', async () => {
    const order = await paidOrder({ stage: 'shipped' });
    const statement = await waitingStatement(order.orderId);
    expect((await post(`/api/returns/${statement.returnId}/refund`, {}, admin)).statusCode).toBe(
      200,
    );
    const ours = await refundOf(order.paymentId);

    giveRefundReference(ours.id, 'ARN-OURS-1');
    await tell('refund.updated', ours.id);

    const lines = await asAdmin((tx) =>
      tx.moneyLog.findMany({
        where: { returnId: statement.returnId, event: 'money.refund' },
        select: { refundId: true, bankReference: true },
      }),
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines).toEqual(lines.map(() => ({ refundId: ours.id, bankReference: 'ARN-OURS-1' })));
  });

  // the buyer asks the bank about the money with that number: the card of the order shows it with
  // the transfer it follows
  mockOnly('show the number of the bank to the buyer in the card of the order', async () => {
    const order = await paidOrder({ stage: 'shipped' });
    const statement = await waitingStatement(order.orderId);
    expect((await post(`/api/returns/${statement.returnId}/refund`, {}, admin)).statusCode).toBe(
      200,
    );
    const ours = await refundOf(order.paymentId);
    const before = await get(`/api/orders/${order.orderId}`, order.buyer);

    giveRefundReference(ours.id, 'ARN-OURS-2');
    await tell('refund.updated', ours.id);
    const after = await get(`/api/orders/${order.orderId}`, order.buyer);

    const refundsIn = (res: { json(): unknown }) =>
      (res.json() as { withdrawals: { refunds: unknown[] }[] }).withdrawals.flatMap(
        (one) => one.refunds,
      );
    expect(refundsIn(before)).toEqual([
      expect.objectContaining({ way: 'payment', bankReference: null }),
    ]);
    expect(refundsIn(after)).toEqual([
      expect.objectContaining({ way: 'payment', bankReference: 'ARN-OURS-2' }),
    ]);
  });

  it('only log a refund that waits for an action of the buyer', async () => {
    const order = await paidOrder({ stage: 'shipped' });
    const byHand = await refundByHand(order.paymentId, 500);
    const line = await handLineOf(order.paymentId, byHand.id);
    const event = craftEvent('refund.updated', { ...byHand, status: 'requires_action' });

    const res = await deliver(app, event);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(takeLogs({ msg: 'a refund waits for an action of the buyer' })).toEqual([
      expect.objectContaining({ eventId: event.id, refundId: byHand.id }),
    ]);
    expect(await handLineOf(order.paymentId, byHand.id)).toEqual(line);
  });

  mockOnly(
    'fail a refund made by hand of a late payment: the buyer is told the money did not go',
    async () => {
      const late = await latePayment(deps());
      const byHand = await refundAtStripe(late.paymentId, { amount: 2000 });
      await deliver(app, late.event);
      const mails = watchMail();

      settleRefund(byHand.id, { status: 'failed', reason: 'expired_or_canceled_card' });
      await tell('refund.failed', byHand.id);

      const hand = await handLineOf(late.paymentId, byHand.id);
      expect((await moneyOfPayment(late.paymentId)).at(-1)).toMatchObject({
        event: 'money.refund_failed',
        purpose: 'hand',
        amount: '20.00',
        coversId: hand.id,
        failure: 'card_unavailable',
      });
      const told = mailsTo(mails, late.user.email, 'We could not send your payment back');
      expect(told).toHaveLength(1);
      expect(told[0]!.text).toContain('€20.00');
    },
  );

  mockOnly(
    'fail the refund made by hand of an order the system cancelled: the order stays cancelled, the buyer is told',
    async () => {
      const order = await paidOrder();
      const byHand = await refundByHand(order.paymentId);
      const mails = watchMail();

      settleRefund(byHand.id, { status: 'failed', reason: 'expired_or_canceled_card' });
      await tell('refund.failed', byHand.id);

      expect(await orderOf(order.orderId)).toMatchObject({ status: 'cancelled' });
      const [statement] = await statementsOf(order.orderId);
      expect(statement!.refundedTotal.toFixed(2)).toBe('0.00');
      const told = mailsTo(mails, order.buyer.email, 'We could not send your payment back');
      expect(told).toHaveLength(1);
      expect(told[0]!.text).toContain('€20.00');

      // the same failure again: nothing more
      await tell('refund.failed', byHand.id);
      expect(mailsTo(mails, order.buyer.email)).toHaveLength(1);
    },
  );

  // the money root gave to the goods paid the rows of a statement: the buyer was told it is back
  mockOnly(
    'fail a refund of all of the payment shared among the goods of a statement it paid: the statement owes it again, the buyer is told',
    async () => {
      const order = await paidOrder({ stage: 'shipped' });
      await waitingStatement(order.orderId);
      const byHand = await refundByHand(order.paymentId, 2000);
      const [paid] = await statementsOf(order.orderId);
      expect(paid!.refundedTotal.toFixed(2)).toBe('20.00');
      const mails = watchMail();

      settleRefund(byHand.id, { status: 'failed', reason: 'expired_or_canceled_card' });
      await tell('refund.failed', byHand.id);

      const [after] = await statementsOf(order.orderId);
      expect(after!.refundedTotal.toFixed(2)).toBe('0.00');
      const told = mailsTo(mails, order.buyer.email, 'We could not send your payment back');
      expect(told).toHaveLength(1);
      expect(told[0]!.text).toContain('€20.00');
    },
  );

  mockOnly('fail a refund root called a compensation: no mail, the line says it', async () => {
    const order = await paidOrder({ stage: 'shipped' });
    const byHand = await refundByHand(order.paymentId, 500);
    const line = await handLineOf(order.paymentId, byHand.id);
    await decide(line.id, { items: [], note: 'Goodwill' });
    const mails = watchMail();

    settleRefund(byHand.id, { status: 'failed', reason: 'expired_or_canceled_card' });
    await tell('refund.failed', byHand.id);

    expect((await moneyOfPayment(order.paymentId)).at(-1)).toMatchObject({
      event: 'money.refund_failed',
      coversId: line.id,
    });
    expect(mails).toEqual([]);
  });
});

describe('a refund made by hand of a payment that is none of the shop', () => {
  it('is acknowledged and named in the log, nothing is written', async () => {
    const paymentId = await payByCard(1000);
    const refund = await refundAtStripe(paymentId);
    const event = await stripeEvent('refund.created', refund.id);

    const res = await deliver(app, event);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, skipped: 'NOT_AN_ORDER' });
    expect(takeLogs({ msg: 'stripe event was skipped', skipped: 'NOT_AN_ORDER' })).toEqual([
      expect.objectContaining({ eventId: event.id, refundId: refund.id }),
    ]);
    expect(await moneyOfPayment(paymentId)).toEqual([]);
  });
});
