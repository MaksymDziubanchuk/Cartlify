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
import { latePayment, moneyOfPayment } from '../../helpers/lateRefund.js';
import { watchMail, type SentMail } from '../../helpers/mail.js';
import { placePaidOrder, placePaidOrderOf } from '../../helpers/payments.js';
import { journeyOf, mailTo, mailsTo, statementCodeIn } from '../../helpers/returnJourney.js';
import {
  closeDispute,
  closeOpenSessions,
  deliver,
  disputeEvent,
  disputeOf,
  endDispute,
  openDispute,
  realStripe,
  refundsOf,
  withStripeOutOfReach,
} from '../../helpers/stripe.js';
import { settleRefundsInTransit } from '@routes/api/payments/services/settleRefundsInTransit.service.js';

// A dispute of a payment at the bank, each step with what its actor sees: Stripe tells the app of every step of it, and the app follows the
// dispute by itself. An order not sent is held while it is open; the person who answers finds the
// dispute among those to answer and a draft of the evidence in the dashboard of Stripe, submits it,
// and the bank decides: for the shop the order goes, for the buyer the system cancels it and the
// buyer is told what the bank gave back. A statement whose money waits under a dispute goes on
// where it stopped once the shop won (its goods came back by a parcel: the admin sends the money). A
// dispute lost on an order sent leaves what the bank took to root, who says what it was for: the
// goods (a statement takes it first, the rows it pays whole at once) or a loss of the shop. An inquiry of the bank holds
// the order without money; PayPal opens a dispute for each claim, the order waits for the last one.
// The buyer hears nothing of a dispute itself. The rules of each step are the tests of the routes
// (api/payments/disputes.test.ts); the disputes are made by the Stripe mock (the sandbox opens one
// only for a test card of its own)

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

const describeMock = realStripe ? describe.skip : describe;

// the alerts of the admins: a case is found in the list an alert names, narrowed to the order or
// the buyer of the test (the alerts are shared by every file that runs at the same time)
const alerts = alertsOf({ app: () => app, csrf: () => csrf });
const listedIn = async (kind: string, narrow: Record<string, number>) =>
  (await alerts.listOf(admin, kind, narrow)).items as Array<
    { id: number } & Record<string, unknown>
  >;

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

type MoneyLine = { event: string; purpose: string; part: string; amount: number };

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

// Stripe tells the app of a step of the dispute
async function tell(type: string, disputeId: string) {
  const res = await deliver(app, await disputeEvent(type, disputeId));
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ received: true });
}

// the bank opens a dispute of the payment (a chargeback takes the money from the balance at once,
// an inquiry takes nothing); the id of the dispute at Stripe
async function bankDisputes(paymentId: string, opening: Parameters<typeof openDispute>[1] = {}) {
  const disputeId = openDispute(paymentId, opening);
  await tell('charge.dispute.created', disputeId);
  if ((opening.status ?? 'needs_response') === 'needs_response') {
    await tell('charge.dispute.funds_withdrawn', disputeId);
  }
  return disputeId;
}

// the person who answers submits the evidence in the dashboard of Stripe and the bank decides
async function bankDecides(paymentId: string, disputeId: string, outcome: 'won' | 'lost') {
  await closeDispute(paymentId, outcome);
  await tell('charge.dispute.updated', disputeId);
  await tell('charge.dispute.closed', disputeId);
  if (outcome === 'won') await tell('charge.dispute.funds_reinstated', disputeId);
}

// the bank ends a dispute of PayPal or an inquiry, and Stripe tells of it
async function bankEnds(disputeId: string, end: Parameters<typeof endDispute>[1]) {
  endDispute(disputeId, end);
  await tell('charge.dispute.closed', disputeId);
  if (end === 'won') await tell('charge.dispute.funds_reinstated', disputeId);
}

async function orderCardOf(orderId: number) {
  const res = await j.get(admin, `/api/orders/${orderId}`);
  expect(res.statusCode).toBe(200);
  return res.json();
}

// root says what the money of the bank was for, as root reads it in the card of the dispute
async function rootDecides(lineId: number, items: Record<string, unknown>[], note: string) {
  const res = await j.post(root, `/api/payments/money-lines/${lineId}/decision`, { items, note });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function disputeCardOf(id: number) {
  const res = await j.get(admin, `/api/payments/disputes/${id}`);
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function disputesListed(orderId: number, query = '') {
  const res = await j.get(admin, `/api/payments/disputes?orderId=${orderId}&${query}`);
  expect(res.statusCode).toBe(200);
  return res.json().items as { id: number; stripeId: string; status: string }[];
}

async function statementCardOf(returnId: number) {
  const res = await j.get(admin, `/api/returns/${returnId}`);
  expect(res.statusCode).toBe(200);
  return res.json();
}

const ship = (orderId: number) =>
  j.patch(admin, `/api/orders/${orderId}/status`, { status: 'shipped' });

const toBuyer = (mails: SentMail[], buyer: TestUser) => mailsTo(mails, buyer.email, '');

const glanceOf = (lines: MoneyLine[]) =>
  lines.map((line) => [line.event, line.purpose, line.part, line.amount]);

describeMock('a dispute of an order not sent', () => {
  it('holds the order, drafts the evidence for the person who answers, and once the bank decides for the buyer the order is cancelled and the buyer told', async () => {
    const { buyer, product, orderId, paymentId } = await paidOrder();
    const before = (await stockOf(product)).stock;
    const mails = watchMail();

    const disputeId = await bankDisputes(paymentId);

    // the admin cannot send the order: the dispute holds it
    const refused = await ship(orderId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      errorCode: 'ORDER_ON_HOLD',
      details: { orderId, holds: ['dispute'] },
    });

    // the card of the order names the dispute, the card of the dispute what the bank took
    const card = await orderCardOf(orderId);
    expect(card.holds).toEqual([expect.objectContaining({ reason: 'dispute' })]);
    const dispute = await disputeCardOf(card.holds[0].ref);
    expect(dispute).toMatchObject({
      stripeId: disputeId,
      status: 'needs_response',
      open: true,
      withdrawn: 20,
      submissionCount: 0,
      evidenceDueBy: expect.any(String),
      draftedAt: expect.any(String),
      order: { id: orderId, status: 'paid' },
      returns: [],
    });
    // the person who answers finds it in the alert of the disputes to answer; the order it holds is
    // not among the paid orders the admins are to send
    expect((await listedIn('disputes_to_answer', { orderId })).map((one) => one.id)).toEqual([
      dispute.id,
    ]);
    expect(await listedIn('paid_orders_waiting', { userId: buyer.id })).toEqual([]);

    // the person who answers finds the draft of the evidence in the dashboard of Stripe
    const atStripe = await disputeOf(disputeId);
    expect(atStripe.evidence.product_description).toContain(`Order #${orderId}`);
    expect(atStripe.evidence.customer_email_address).toBe(buyer.email);
    expect(atStripe.evidence.uncategorized_text).toContain('The order was not sent.');

    // the buyer hears nothing of the dispute and sees the order paid
    expect(toBuyer(mails, buyer)).toEqual([]);
    expect((await j.get(buyer, `/api/orders/${orderId}`)).json()).toMatchObject({
      status: 'paid',
      paymentCheck: false,
    });

    await bankDecides(paymentId, disputeId, 'lost');

    // the buyer is told the order is cancelled after the decision of the bank, which gave the money
    const told = mailTo(
      mails,
      buyer.email,
      `Order #${orderId} is cancelled after the decision of your bank`,
    );
    expect(told.text).toContain('gave you back €20.00.');
    expect(told.text).not.toContain('We sent you the rest');
    expect(toBuyer(mails, buyer)).toHaveLength(1);
    const seen = (await j.get(buyer, `/api/orders/${orderId}`)).json();
    expect(seen.status).toBe('cancelled');
    expect(seen.withdrawals).toEqual([expect.objectContaining({ refundedTotal: 20 })]);

    // the admin sees the dispute lost and the statement of the system that cancelled the order
    expect(await disputeCardOf(dispute.id)).toMatchObject({
      status: 'lost',
      open: false,
      order: { id: orderId, status: 'cancelled', holds: [] },
      returns: [
        expect.objectContaining({
          reason: 'dispute_lost',
          refundedTotal: 20,
          closedAt: expect.any(String),
        }),
      ],
    });
    expect(await listedIn('disputes_to_answer', { orderId })).toEqual([]);
    expect((await listedIn('disputes_lost', { orderId })).map((one) => one.id)).toEqual([
      dispute.id,
    ]);
    expect(glanceOf((await orderCardOf(orderId)).money)).toEqual([
      ['money.payment', 'order', 'goods', 20],
      ['money.dispute_withdrawn', 'dispute', 'whole', -20],
      ['money.refund', 'return', 'goods', -20],
      ['money.refund', 'return', 'covered', 20],
    ]);

    // the goods are back on the shelf; Stripe was asked for no refund, the bank gave the money
    expect((await stockOf(product)).stock).toBe(before + 2);
    expect(await refundsOf(paymentId)).toEqual([]);
  });

  it('lets the order go once the bank decides for the shop, and the buyer hears only that it is shipped', async () => {
    const { buyer, orderId, paymentId } = await paidOrder();
    const mails = watchMail();
    const disputeId = await bankDisputes(paymentId);
    const [held] = (await orderCardOf(orderId)).holds;
    expect(held).toMatchObject({ reason: 'dispute' });

    await bankDecides(paymentId, disputeId, 'won');

    // the dispute is won, nothing holds the order: the admin finds it among the paid orders to send
    expect(await disputeCardOf(held.ref)).toMatchObject({
      status: 'won',
      open: false,
      order: { id: orderId, status: 'paid', holds: [] },
    });
    expect(
      (await listedIn('paid_orders_waiting', { userId: buyer.id })).map((one) => one.id),
    ).toEqual([orderId]);
    expect(await listedIn('disputes_lost', { orderId })).toEqual([]);
    const shipped = await j.patch(admin, `/api/orders/${orderId}/status`, {
      status: 'shipped',
      shipment: { carrier: 'Nova Poshta', trackingNumber: '20450000000021' },
    });
    expect(shipped.statusCode).toBe(200);
    expect(toBuyer(mails, buyer).map((mail) => mail.subject)).toEqual([
      expect.stringContaining(`Order #${orderId} is shipped`),
    ]);

    // the money: the bank took it and gave it back
    expect(glanceOf((await orderCardOf(orderId)).money)).toEqual([
      ['money.payment', 'order', 'goods', 20],
      ['money.dispute_withdrawn', 'dispute', 'whole', -20],
      ['money.dispute_reinstated', 'dispute', 'whole', 20],
    ]);
    expect(await refundsOf(paymentId)).toEqual([]);
  });

  it('holds the order for an inquiry of the bank that takes no money, and lets it go when the inquiry closes', async () => {
    const { buyer, orderId, paymentId } = await paidOrder();
    const mails = watchMail();
    const disputeId = await bankDisputes(paymentId, { status: 'warning_needs_response' });

    const card = await orderCardOf(orderId);
    expect(card.holds).toEqual([expect.objectContaining({ reason: 'dispute' })]);
    expect(await disputeCardOf(card.holds[0].ref)).toMatchObject({
      status: 'warning_needs_response',
      open: true,
      withdrawn: 0,
      draftedAt: expect.any(String),
      money: [],
    });
    expect((await disputesListed(orderId, 'toAnswer=true')).map((one) => one.stripeId)).toEqual([
      disputeId,
    ]);
    expect((await ship(orderId)).statusCode).toBe(409);

    await bankEnds(disputeId, 'warning_closed');

    expect((await ship(orderId)).statusCode).toBe(200);
    expect(glanceOf((await orderCardOf(orderId)).money)).toEqual([
      ['money.payment', 'order', 'goods', 20],
    ]);
    expect(toBuyer(mails, buyer).map((mail) => mail.subject)).toEqual([
      expect.stringContaining(`Order #${orderId} is shipped`),
    ]);
  });

  // PayPal opens a dispute for each claim of the buyer
  it('holds an order paid by PayPal until the last of the disputes of its payment ends', async () => {
    const { orderId, paymentId } = await paidOrder();
    const first = await bankDisputes(paymentId, { method: 'paypal', amount: 1000 });
    const second = await bankDisputes(paymentId, { method: 'paypal', amount: 1000 });
    expect((await orderCardOf(orderId)).holds).toEqual([
      expect.objectContaining({ reason: 'dispute' }),
      expect.objectContaining({ reason: 'dispute' }),
    ]);

    // the first ends for the shop: the second still holds the order
    await bankEnds(first, 'won');
    const still = await ship(orderId);
    expect(still.statusCode).toBe(409);
    expect(still.json()).toMatchObject({ details: { orderId, holds: ['dispute'] } });

    await bankEnds(second, 'won');
    expect((await ship(orderId)).statusCode).toBe(200);
    expect((await disputesListed(orderId)).map((one) => [one.stripeId, one.status]).sort()).toEqual(
      [
        [first, 'won'],
        [second, 'won'],
      ].sort(),
    );
  });
});

describeMock('a dispute while a statement of the order waits for its money', () => {
  // the order went, the buyer withdrew from it and the admin took the goods in; the bank opened a
  // dispute of the payment meanwhile: the money of the statement waits for the bank
  async function statementUnderDispute() {
    const order = await paidOrder();
    expect((await ship(order.orderId)).statusCode).toBe(200);
    const mails = watchMail();
    expect((await j.post(order.buyer, `/api/orders/${order.orderId}/withdrawal`)).statusCode).toBe(
      201,
    );
    const code = statementCodeIn(
      mailTo(mails, order.buyer.email, `Withdrawal from order #${order.orderId}`),
    );
    const [found] = (await j.get(admin, `/api/returns?q=${code}`)).json().items;
    const returnId = found.id as number;
    const [row] = (await statementCardOf(returnId)).items;
    expect(
      (
        await j.post(admin, `/api/returns/${returnId}/receive`, {
          parcel: { buyerPaid: 0 },
          results: [{ itemId: row.id, quantity: 2, goods: 'to_stock' }],
        })
      ).statusCode,
    ).toBe(200);

    const disputeId = await bankDisputes(order.paymentId);

    // the admin cannot send the money: the card says a dispute is open
    const refused = await j.post(admin, `/api/returns/${returnId}/refund`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ errorCode: 'RETURN_REFUND_DISPUTED' });
    expect(await statementCardOf(returnId)).toMatchObject({
      disputeOpen: true,
      refundedTotal: 0,
      closedAt: null,
    });
    // the dispute to answer says a statement of the order is open
    expect(await disputesListed(order.orderId, 'toAnswer=true')).toEqual([
      expect.objectContaining({ stripeId: disputeId, returnOpen: true }),
    ]);
    return { ...order, mails, returnId, disputeId, row };
  }

  // the goods came back by a parcel the admin took in: the money is the admin's to send, as before
  // the dispute
  it('lets the admin send the money of the statement once the shop won, and the buyer is told', async () => {
    const { buyer, orderId, paymentId, mails, returnId, disputeId } = await statementUnderDispute();

    await bankDecides(paymentId, disputeId, 'won');

    expect(await refundsOf(paymentId)).toEqual([]);
    expect(await statementCardOf(returnId)).toMatchObject({ disputeOpen: false, closedAt: null });
    const sent = await j.post(admin, `/api/returns/${returnId}/refund`);
    expect(sent.statusCode).toBe(200);

    expect(mailTo(mails, buyer.email, `Return of order #${orderId} is closed`).text).toContain(
      'We sent you €20.00.',
    );
    expect(await statementCardOf(returnId)).toMatchObject({
      disputeOpen: false,
      refundedTotal: 20,
      closedAt: expect.any(String),
    });
    expect((await refundsOf(paymentId)).map((one) => one.amount)).toEqual([2000]);
  });

  // the bank took all of the payment and no other money of the buyer moved before it: the app shares
  // it among the goods by itself
  it('is shared by itself once the shop lost all of the payment: the money of the bank pays the statement at once, asking Stripe for nothing', async () => {
    const { buyer, orderId, paymentId, mails, returnId, disputeId } = await statementUnderDispute();

    await bankDecides(paymentId, disputeId, 'lost');

    // nothing waits for root: the alert of the money of the bank to decide has none of it
    expect((await alerts.listOf(root, 'bank_money_to_decide', { orderId })).items).toEqual([]);

    // the mail of the end says the bank gave the money, not the shop
    const end = mailTo(mails, buyer.email, `Return of order #${orderId} is closed`);
    expect(end.text).toContain('gave you back €20.00.');
    expect(end.text).not.toContain('We sent you');
    expect(await statementCardOf(returnId)).toMatchObject({
      disputeOpen: false,
      refundedTotal: 20,
      closedAt: expect.any(String),
    });
    // the money of the bank is the money of the statement, once
    const lines = (
      await j.get(admin, `/api/admin/money-log?orderId=${orderId}&sortOrder=asc&limit=100`)
    ).json().items as (MoneyLine & {
      id: number;
      returnId: number | null;
      coversId: number | null;
      moneyUse: string | null;
    })[];
    const withdrawn = lines.find((line) => line.event === 'money.dispute_withdrawn')!;
    expect(withdrawn).toMatchObject({ amount: -20, returnId: null, moneyUse: 'goods' });
    expect(lines.filter((line) => line.part === 'covered')).toEqual([
      expect.objectContaining({ amount: 20, coversId: withdrawn.id, returnId }),
    ]);
    expect(await refundsOf(paymentId)).toEqual([]);
  });
});

describeMock('a dispute of an order already sent', () => {
  // the order went before the bank opened the dispute: nothing is held, the person who answers
  // finds it among the disputes to answer, and what the bank decides is money of the shop only
  async function sentAndDisputed(opening: Parameters<typeof bankDisputes>[1] = {}) {
    const order = await paidOrder();
    expect((await ship(order.orderId)).statusCode).toBe(200);
    const mails = watchMail();
    const disputeId = await bankDisputes(order.paymentId, opening);

    expect((await orderCardOf(order.orderId)).holds).toEqual([]);
    const [toAnswer, ...others] = await listedIn('disputes_to_answer', { orderId: order.orderId });
    expect(others).toEqual([]);
    expect(toAnswer).toMatchObject({ stripeId: disputeId, returnOpen: false, late: false });
    expect(await disputeCardOf(toAnswer!.id)).toMatchObject({
      open: true,
      withdrawn: (opening.amount ?? 2000) / 100,
      draftedAt: expect.any(String),
      order: { id: order.orderId, status: 'shipped', holds: [] },
      returns: [],
    });
    expect((await disputeOf(disputeId)).evidence.uncategorized_text).not.toContain(
      'The order was not sent.',
    );
    return { ...order, mails, disputeId, rowId: toAnswer!.id };
  }

  // the bank took 15 of the 20: what it takes of all of a payment with nothing before is shared among
  // the goods by itself (the dispute while a statement waits, above)
  it('lost: root says the money the bank gave the buyer was a loss of the shop, the order stays as it went', async () => {
    const { buyer, orderId, paymentId, mails, disputeId, rowId } = await sentAndDisputed({
      amount: 1500,
    });

    await bankDecides(paymentId, disputeId, 'lost');

    expect(await listedIn('disputes_to_answer', { orderId })).toEqual([]);
    expect((await listedIn('disputes_lost', { orderId })).map((one) => one.id)).toEqual([rowId]);
    const [taken] = (await disputeCardOf(rowId)).money;
    expect(taken).toMatchObject({ moneyUse: null });
    expect(
      await rootDecides(taken.id, [], 'The buyer kept the goods: the money is lost.'),
    ).toMatchObject({ use: 'loss', distributed: '0.00', rest: '15.00', covered: [] });
    expect((await disputeCardOf(rowId)).money).toEqual([
      expect.objectContaining({ moneyUse: 'loss' }),
    ]);
    const card = await orderCardOf(orderId);
    expect(card).toMatchObject({ status: 'shipped', holds: [] });
    expect(glanceOf(card.money)).toEqual([
      ['money.payment', 'order', 'goods', 20],
      ['money.dispute_withdrawn', 'dispute', 'whole', -15],
    ]);
    // no statement, no refund of Stripe, no word to the buyer
    expect(card.returns).toEqual([]);
    expect(await refundsOf(paymentId)).toEqual([]);
    expect(toBuyer(mails, buyer)).toEqual([]);
  });

  // the bank took 10 of the 20 for the lamp; root says so, and the buyer later sends the lamp and the
  // book back: the money of the bank pays the lamp, the shop the book (Stripe refuses a refund of a
  // payment charged back, so root sends that way another way)
  it('lost on part of it: root gives the money of the bank to the lamp, a later return of the lamp and the book takes it first', async () => {
    const buyer = await createUser({ name: 'Anna Koval' });
    userIds.push(buyer.id);
    const lamp = await createProduct({ price: 10, stock: 10, name: `Desk lamp ${buyer.id}` });
    const book = await createProduct({ price: 10, stock: 10, name: `Notebook ${buyer.id}` });
    products.push(lamp, book);
    const { orderId, paymentId } = await placePaidOrderOf(app, csrf, buyer, [
      { item: lamp, quantity: 1 },
      { item: book, quantity: 1 },
    ]);
    expect((await ship(orderId)).statusCode).toBe(200);
    const mails = watchMail();
    const disputeId = await bankDisputes(paymentId, { amount: 1000 });
    await bankDecides(paymentId, disputeId, 'lost');

    // root finds the dispute in the alert of the money of the bank that waits for a decision, and
    // gives what the bank took to the lamp
    const [lost] = (await alerts.listOf(root, 'bank_money_to_decide', { orderId })).items;
    expect(lost).toMatchObject({ stripeId: disputeId });
    const [taken] = (await disputeCardOf(lost!.id)).money;
    expect(taken).toMatchObject({ amount: -10, moneyUse: null });
    const items = (await orderCardOf(orderId)).items as { id: number; product: { id: number } }[];
    const lampItem = items.find((one) => one.product.id === lamp.id)!;
    expect(
      await rootDecides(
        taken.id,
        [{ orderItemId: lampItem.id, quantity: 1, amount: 10 }],
        'The bank paid the buyer for the lamp.',
      ),
    ).toMatchObject({ use: 'goods', covered: [] });

    // the buyer sends both back and the admin takes them in
    expect((await j.post(buyer, `/api/orders/${orderId}/withdrawal`)).statusCode).toBe(201);
    const code = statementCodeIn(mailTo(mails, buyer.email, `Withdrawal from order #${orderId}`));
    const [found] = (await j.get(admin, `/api/returns?q=${code}`)).json().items;
    const returnId = found.id as number;
    const rows = (await statementCardOf(returnId)).items as { id: number; quantity: number }[];
    expect(
      (
        await j.post(admin, `/api/returns/${returnId}/receive`, {
          parcel: { buyerPaid: 0 },
          results: rows.map((one) => ({
            itemId: one.id,
            quantity: one.quantity,
            goods: 'to_stock',
          })),
        })
      ).statusCode,
    ).toBe(200);

    // the admin sends the money: Stripe refuses a refund of the payment the bank charged back
    expect((await j.post(admin, `/api/returns/${returnId}/refund`)).statusCode).toBe(200);
    expect(await statementCardOf(returnId)).toMatchObject({ refundedTotal: 0, closedAt: null });

    // root sends it another way: the money of the bank pays the lamp first, the book goes outside
    const card = await statementCardOf(returnId);
    const outside = await j.post(root, `/api/returns/${returnId}/refund/outside`, {
      method: 'bank_transfer',
      note: 'To the account the buyer wrote by mail.',
      at: card.statedAt,
    });
    expect(outside.statusCode).toBe(200);
    expect(outside.json()).toMatchObject({ refundedTotal: 20, closedAt: expect.any(String) });

    // the mail of the end tells each source
    const end = mailTo(mails, buyer.email, `Return of order #${orderId} is closed`);
    expect(end.text).toContain('gave you back €10.00.');
    expect(end.text).toMatch(/We sent you €10\.00 by a bank transfer on /);
    expect(await refundsOf(paymentId)).toEqual([]);
  });

  it('won: the bank gives the money back to the shop and nothing else changes', async () => {
    const { buyer, orderId, paymentId, mails, disputeId } = await sentAndDisputed();

    await bankDecides(paymentId, disputeId, 'won');

    expect(await listedIn('disputes_to_answer', { orderId })).toEqual([]);
    expect(await listedIn('disputes_lost', { orderId })).toEqual([]);
    const card = await orderCardOf(orderId);
    expect(card).toMatchObject({ status: 'shipped', holds: [] });
    expect(glanceOf(card.money)).toEqual([
      ['money.payment', 'order', 'goods', 20],
      ['money.dispute_withdrawn', 'dispute', 'whole', -20],
      ['money.dispute_reinstated', 'dispute', 'whole', 20],
    ]);
    expect(toBuyer(mails, buyer)).toEqual([]);
  });
});

describeMock('a dispute of a payment the order could not take', () => {
  // the buyer paid the page after the units were gone; the app asked Stripe to give the payment
  // back while the bank opened a dispute of it, and Stripe refused the refund for the dispute
  async function lateUnderDispute() {
    const late = await latePayment({ app, csrf, users: userIds, products }, { name: 'Anna Koval' });
    const mails = watchMail();
    await withStripeOutOfReach(() => deliver(app, late.event));
    const disputeId = await bankDisputes(late.paymentId);
    await settleRefundsInTransit(
      { info: () => undefined, warn: () => undefined, error: () => undefined },
      { paymentId: late.paymentId, olderThanMs: 0 },
    );
    expect((await moneyOfPayment(late.paymentId)).at(-1)).toMatchObject({
      event: 'money.refund_failed',
      failure: 'disputed',
    });

    // the person who answers finds it among the disputes to answer, marked as a late payment; the
    // refund that waits for the bank is in no alert of the failed refunds
    const [toAnswer] = await listedIn('disputes_to_answer', { orderId: late.orderId });
    expect(toAnswer).toMatchObject({ stripeId: disputeId, late: true });
    expect(await listedIn('late_refunds_failed', { userId: late.user.id })).toEqual([]);
    expect((await disputeOf(disputeId)).evidence.uncategorized_text).toContain(
      'This payment came after the order could no longer take it',
    );
    return { ...late, mails, disputeId };
  }

  it('won: the app sends the payment back by itself, and the buyer is told once', async () => {
    const { user, orderId, paymentId, mails, disputeId } = await lateUnderDispute();

    await bankDecides(paymentId, disputeId, 'won');

    expect(await listedIn('disputes_to_answer', { orderId })).toEqual([]);
    expect((await moneyOfPayment(paymentId)).at(-1)).toMatchObject({
      event: 'money.refund',
      purpose: 'late_payment',
      amount: '-51.00',
      state: 'sent',
    });
    expect(mailsTo(mails, user.email, '').map((mail) => mail.subject)).toEqual([
      expect.stringContaining(`We sent your payment for order #${orderId} back`),
    ]);
  });

  it('lost: the bank gave the money back, the app sends nothing and the late payment is over', async () => {
    const { user, orderId, paymentId, mails, disputeId } = await lateUnderDispute();

    await bankDecides(paymentId, disputeId, 'lost');

    expect(await listedIn('disputes_to_answer', { orderId })).toEqual([]);
    expect((await listedIn('disputes_lost', { orderId })).map((one) => one.stripeId)).toEqual([
      disputeId,
    ]);
    expect(await listedIn('late_refunds_failed', { userId: user.id })).toEqual([]);
    // Stripe refused the refund, so it made none
    expect(await refundsOf(paymentId)).toEqual([]);
    expect(mailsTo(mails, user.email, '')).toEqual([]);
  });
});
