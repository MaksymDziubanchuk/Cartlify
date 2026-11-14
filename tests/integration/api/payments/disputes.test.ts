import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import appStripe from '@config/stripe.js';
import { settleRefundsInTransit } from '@routes/api/payments/services/settleRefundsInTransit.service.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
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
import { latePayment, moneyOfPayment } from '../../../helpers/lateRefund.js';
import { takeLogs } from '../../../helpers/logs.js';
import { watchMail, type SentMail } from '../../../helpers/mail.js';
import { inOwnerTx } from '../../../helpers/ownerDb.js';
import { placePaidOrder } from '../../../helpers/payments.js';
import { returnFlows } from '../../../helpers/returnFlows.js';
import {
  closeOpenSessions,
  deliver,
  disputeEvent,
  disputeOf,
  endDispute,
  openDispute,
  outOfReachDuring,
  payByCard,
  realStripe,
  refundsOf,
  stripeRequestsDuring,
  withStripeOutOfReach,
} from '../../../helpers/stripe.js';

// The disputes of a payment at the bank. Every event of a dispute makes the app read the dispute from Stripe
// and follow its state (sync_payment_dispute, db/disputes.test.ts), so the order and the number of
// the events do not matter: an open dispute holds an order not sent and gets a draft of the evidence
// once (a person submits it in the dashboard); its money is a line of the money journal for each move
// of the balance; a dispute won lets the order go and the money of a statement that waited is sent
// by the app; a dispute lost on an order not sent cancels it by a statement of the system and the
// rest of the payment goes back; a lost dispute of a statement that waits pays it with the money the
// bank gave. The buyer is not mailed that a dispute opened or was won. The disputes are made by the
// Stripe mock (the sandbox makes a chargeback only for a test card of its own)

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];
const deps = () => ({ app, csrf, users: userIds, products });

const mockOnly = realStripe ? it.skip : it;
const describeMock = realStripe ? describe.skip : describe;

const flows = returnFlows({ app: () => app, csrf: () => csrf, admin: () => admin });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  userIds.push(admin.id, root.id);
});

afterEach(() => {
  jest.restoreAllMocks();
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

const get = (url: string, actor: TestUser | null = admin) =>
  app.inject({
    method: 'GET',
    url,
    ...(actor ? { headers: { cookie: accessCookie(actor) } } : {}),
  });

const mailsTo = (mails: SentMail[], email: string) =>
  mails.filter((mail) => mail.to.includes(email));

// an order of two units at 10, a total of 20, paid by a card, not sent yet or sent
async function paidOrder(stage: 'paid' | 'shipped' = 'paid') {
  const buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(buyer.id);
  const product = await createProduct({ price: 10, stock: 10, name: 'Desk lamp' });
  products.push(product);
  const placed = await placePaidOrder(app, csrf, buyer, product, { quantity: 2, stage });
  return { ...placed, buyer, product };
}

// an event of the dispute, around the dispute as Stripe has it now, delivered
async function tell(type: string, disputeId: string) {
  const res = await deliver(app, await disputeEvent(type, disputeId));
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ received: true });
  return res;
}

// the bank opens a dispute and Stripe sends its events
async function disputed(paymentId: string, opening: Parameters<typeof openDispute>[1] = {}) {
  const disputeId = openDispute(paymentId, opening);
  await tell('charge.dispute.created', disputeId);
  if ((opening.status ?? 'needs_response') === 'needs_response') {
    await tell('charge.dispute.funds_withdrawn', disputeId);
  }
  return disputeId;
}

// the bank ends it and Stripe sends its events
async function ended(disputeId: string, end: Parameters<typeof endDispute>[1]) {
  endDispute(disputeId, end);
  await tell('charge.dispute.closed', disputeId);
  if (end === 'won') await tell('charge.dispute.funds_reinstated', disputeId);
}

const rowOf = (stripeId: string) =>
  asAdmin((tx) => tx.paymentDispute.findUnique({ where: { stripeId } }));

const orderOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, holds: true } }),
  );

const statementsOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.orderReturn.findMany({
      where: { orderId },
      orderBy: { id: 'asc' },
      select: { id: true, source: true, reason: true, closedAt: true, refundedTotal: true },
    }),
  );

const disputeLinesOf = (paymentId: string) =>
  asAdmin(async (tx) =>
    (
      await tx.moneyLog.findMany({
        where: { paymentId, purpose: 'dispute' },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          event: true,
          amount: true,
          returnId: true,
          moneyUse: true,
          stripeTxId: true,
        },
      })
    ).map((line) => ({ ...line, amount: line.amount.toFixed(2) })),
  );

// the draft of the evidence goes once: the requests that put evidence on a dispute
const draftsIn = (requests: { method?: string; path?: string }[]) =>
  requests.filter((one) => one.method === 'POST' && /^\/v1\/disputes\/du_/.test(one.path ?? ''));

describeMock('a dispute of an order not sent', () => {
  it('holds the order, writes the money the bank took and puts a draft of the evidence, without a mail', async () => {
    const order = await paidOrder();
    const mails = watchMail();

    const disputeId = await disputed(order.paymentId);

    const row = await rowOf(disputeId);
    expect(row).toMatchObject({
      provider: 'stripe',
      paymentId: order.paymentId,
      orderId: order.orderId,
      userId: order.buyer.id,
      status: 'needs_response',
      reason: 'fraudulent',
      submissionCount: 0,
      isChargeRefundable: false,
      closedAt: null,
      draftedAt: expect.any(Date),
    });
    expect(row!.evidenceDueBy).toEqual(expect.any(Date));
    expect(await orderOf(order.orderId)).toMatchObject({
      status: 'paid',
      holds: [{ reason: 'dispute', since: expect.any(String), ref: row!.id }],
    });
    expect(await disputeLinesOf(order.paymentId)).toEqual([
      expect.objectContaining({
        event: 'money.dispute_withdrawn',
        amount: '-20.00',
        returnId: null,
      }),
    ]);
    const atStripe = await disputeOf(disputeId);
    expect(atStripe.status).toBe('needs_response');
    expect(atStripe.evidence_details.submission_count).toBe(0);
    expect(atStripe.evidence.product_description).toContain(`Order #${order.orderId}`);
    expect(atStripe.evidence.product_description).toContain('2 x Desk lamp');
    expect(atStripe.evidence.customer_email_address).toBe(order.buyer.email);
    expect(atStripe.evidence.uncategorized_text).toContain('The order was not sent.');
    expect(mailsTo(mails, order.buyer.email)).toEqual([]);
  });

  it('follows the state of Stripe whatever the order and the number of the events: one row, one line, one draft', async () => {
    const order = await paidOrder();
    const disputeId = openDispute(order.paymentId);

    const requests = await stripeRequestsDuring(async () => {
      await tell('charge.dispute.funds_withdrawn', disputeId);
      await tell('charge.dispute.created', disputeId);
      await tell('charge.dispute.created', disputeId);
      await tell('charge.dispute.updated', disputeId);
    });

    expect(draftsIn(requests)).toHaveLength(1);
    expect(await disputeLinesOf(order.paymentId)).toHaveLength(1);
    const rows = await asAdmin((tx) =>
      tx.paymentDispute.findMany({ where: { paymentId: order.paymentId } }),
    );
    expect(rows).toHaveLength(1);
  });

  it('puts the draft at the next event when Stripe could not take it, and logs it', async () => {
    const order = await paidOrder();
    const disputeId = openDispute(order.paymentId);
    outOfReachDuring(appStripe.disputes, 'update');

    await tell('charge.dispute.created', disputeId);

    expect(takeLogs({ msg: 'the draft of the evidence of a dispute was not put' })).toEqual([
      expect.objectContaining({ disputeId }),
    ]);
    expect((await rowOf(disputeId))!.draftedAt).toBeNull();

    jest.restoreAllMocks();
    await tell('charge.dispute.funds_withdrawn', disputeId);

    expect((await rowOf(disputeId))!.draftedAt).toEqual(expect.any(Date));
    expect((await disputeOf(disputeId)).evidence.product_description).toContain(
      `Order #${order.orderId}`,
    );
  });

  it('lets the order go when the shop wins, with the money back on the balance, and mails nothing', async () => {
    const order = await paidOrder();
    const disputeId = await disputed(order.paymentId);
    const mails = watchMail();

    await ended(disputeId, 'won');

    expect(await rowOf(disputeId)).toMatchObject({ status: 'won', closedAt: expect.any(Date) });
    expect(await orderOf(order.orderId)).toEqual({ status: 'paid', holds: [] });
    expect(
      (await disputeLinesOf(order.paymentId)).map((line) => [line.event, line.amount]),
    ).toEqual([
      ['money.dispute_withdrawn', '-20.00'],
      ['money.dispute_reinstated', '20.00'],
    ]);
    expect(await statementsOf(order.orderId)).toEqual([]);
    expect(mailsTo(mails, order.buyer.email)).toEqual([]);
  });

  // the goods are still in the shop: the money of the cancel goes by itself, the dispute only
  // stopped it
  it('sends by itself the money of a cancel of the shop the dispute stopped, once the shop won', async () => {
    const order = await paidOrder();
    const disputeId = await disputed(order.paymentId);
    const item = await asAdmin((tx) =>
      tx.orderItem.findFirstOrThrow({ where: { orderId: order.orderId }, select: { id: true } }),
    );
    const made = await flows.post('/api/returns', {
      orderId: order.orderId,
      items: [{ orderItemId: item.id, quantity: 2 }],
      basis: 'other',
      reason: 'shop_cancel',
    });
    expect(made.statusCode).toBe(201);
    // the transfer of the cancel waits for the bank
    expect(takeLogs({ msg: 'return refund was not started' })).toEqual([
      expect.objectContaining({ code: 'RETURN_REFUND_DISPUTED' }),
    ]);
    expect(await refundsOf(order.paymentId)).toEqual([]);

    await ended(disputeId, 'won');

    expect((await refundsOf(order.paymentId)).map((one) => one.amount)).toEqual([2000]);
    const [statement] = await statementsOf(order.orderId);
    expect(statement).toMatchObject({ reason: 'shop_cancel', closedAt: expect.any(Date) });
    expect(statement!.refundedTotal.toFixed(2)).toBe('20.00');
  });

  it('cancels the order by a statement of the system when the bank gave back all of it, and mails the buyer once', async () => {
    const order = await paidOrder();
    const stockBefore = (await stockOf(order.product))!.stock;
    const disputeId = await disputed(order.paymentId);
    const mails = watchMail();

    await ended(disputeId, 'lost');

    expect(await orderOf(order.orderId)).toEqual({ status: 'cancelled', holds: [] });
    const [statement, ...others] = await statementsOf(order.orderId);
    expect(others).toEqual([]);
    expect(statement).toMatchObject({
      source: 'system',
      reason: 'dispute_lost',
      closedAt: expect.any(Date),
    });
    expect(statement!.refundedTotal.toFixed(2)).toBe('20.00');
    expect((await stockOf(order.product))!.stock).toBe(stockBefore + 2);
    // what the bank took is of the order, shared among its items by the system
    expect(await disputeLinesOf(order.paymentId)).toEqual([
      expect.objectContaining({ amount: '-20.00', returnId: null, moneyUse: 'goods' }),
    ]);
    // the bank gave the buyer all of it: Stripe is asked for nothing
    expect(await refundsOf(order.paymentId)).toEqual([]);
    const told = mailsTo(mails, order.buyer.email);
    expect(told).toHaveLength(1);
    expect(told[0]!.subject).toContain(
      `Order #${order.orderId} is cancelled after the decision of your bank`,
    );
    expect(told[0]!.text).toContain('gave you back €20.00.');
    expect(told[0]!.text).not.toContain('We sent you the rest');

    // the same end told again: nothing more
    await tell('charge.dispute.closed', disputeId);
    expect(await statementsOf(order.orderId)).toHaveLength(1);
    expect(mailsTo(mails, order.buyer.email)).toHaveLength(1);
  });

  it('asks for the rest of the payment when the bank gave back part of it', async () => {
    const order = await paidOrder();
    const disputeId = await disputed(order.paymentId, { amount: 1500 });

    await ended(disputeId, 'lost');

    const [statement] = await statementsOf(order.orderId);
    expect(statement).toMatchObject({ reason: 'dispute_lost' });
    expect(await orderOf(order.orderId)).toMatchObject({ status: 'cancelled' });
    const parts = await asAdmin((tx) =>
      tx.moneyLog.findMany({
        where: { returnId: statement!.id, event: 'money.refund' },
        orderBy: { id: 'asc' },
        select: { part: true, amount: true, transferKey: true },
      }),
    );
    expect(parts.map((part) => [part.part, part.amount.toFixed(2)])).toEqual([
      ['goods', '-20.00'],
      ['covered', '15.00'],
    ]);
    expect(parts.every((part) => part.transferKey !== null)).toBe(true);
  });

  // a cancel of the shop for one of the two units waits for the bank; the bank gives the buyer 15 of
  // the 20: the cancel of the system takes the other unit (all that is left), the order is cancelled
  // and not to be sent, and each statement takes its share of the money of the bank first
  it('cancels the rest of the order while a statement of part of it waits, both taking the money of the bank first', async () => {
    const order = await paidOrder();
    const disputeId = await disputed(order.paymentId, { amount: 1500 });
    const item = await asAdmin((tx) =>
      tx.orderItem.findFirstOrThrow({ where: { orderId: order.orderId }, select: { id: true } }),
    );
    const made = await flows.post('/api/returns', {
      orderId: order.orderId,
      items: [{ orderItemId: item.id, quantity: 1 }],
      basis: 'other',
      reason: 'shop_cancel',
    });
    expect(made.statusCode).toBe(201);
    expect(takeLogs({ msg: 'return refund was not started' })).toEqual([
      expect.objectContaining({ code: 'RETURN_REFUND_DISPUTED' }),
    ]);

    await ended(disputeId, 'lost');

    expect(await orderOf(order.orderId)).toEqual({ status: 'cancelled', holds: [] });
    const [shopCancel, system, ...others] = await statementsOf(order.orderId);
    expect(others).toEqual([]);
    // the bank gave 15: the unit of the cancel of the shop took 10 of it at once
    expect(shopCancel).toMatchObject({ reason: 'shop_cancel', closedAt: expect.any(Date) });
    expect(shopCancel!.refundedTotal.toFixed(2)).toBe('10.00');
    // the cancel of the system took the other unit, its transfer the 5 left of the bank first
    expect(system).toMatchObject({ source: 'system', reason: 'dispute_lost' });
    const parts = await asAdmin((tx) =>
      tx.moneyLog.findMany({
        where: { returnId: system!.id, event: 'money.refund' },
        orderBy: { id: 'asc' },
        select: { part: true, amount: true },
      }),
    );
    expect(parts.map((part) => [part.part, part.amount.toFixed(2)])).toEqual([
      ['goods', '-10.00'],
      ['covered', '5.00'],
    ]);
  });

  it('holds and drafts for an inquiry of the bank, writes no money, and lets the order go when it closes', async () => {
    const order = await paidOrder();
    const disputeId = await disputed(order.paymentId, { status: 'warning_needs_response' });

    expect(await rowOf(disputeId)).toMatchObject({
      status: 'warning_needs_response',
      draftedAt: expect.any(Date),
    });
    expect((await orderOf(order.orderId)).holds).toEqual([
      expect.objectContaining({ reason: 'dispute' }),
    ]);
    expect(await disputeLinesOf(order.paymentId)).toEqual([]);

    await ended(disputeId, 'warning_closed');

    expect(await orderOf(order.orderId)).toEqual({ status: 'paid', holds: [] });
    expect(await statementsOf(order.orderId)).toEqual([]);
  });

  // PayPal makes a dispute for each claim of the buyer: the order is held until the last one ends
  it('holds the order until the last of several disputes of the payment ends', async () => {
    const order = await paidOrder();
    const first = await disputed(order.paymentId, { method: 'paypal', amount: 1000 });
    const second = await disputed(order.paymentId, { method: 'paypal', amount: 1000 });

    expect((await orderOf(order.orderId)).holds).toHaveLength(2);

    await ended(first, 'won');
    expect((await orderOf(order.orderId)).holds).toEqual([
      expect.objectContaining({ reason: 'dispute', ref: (await rowOf(second))!.id }),
    ]);

    await ended(second, 'won');
    expect(await orderOf(order.orderId)).toEqual({ status: 'paid', holds: [] });
  });
});

describeMock('a dispute of a statement that waits for its money', () => {
  // an admin made a statement for both units of the sent order and took the goods in; the bank
  // opened a dispute meanwhile, so its money waits (RETURN_REFUND_DISPUTED)
  async function waiting(opening: Parameters<typeof openDispute>[1] = {}) {
    const order = await paidOrder('shipped');
    const item = await asAdmin((tx) =>
      tx.orderItem.findFirstOrThrow({ where: { orderId: order.orderId }, select: { id: true } }),
    );
    const card = await flows.adminStatement(order.orderId, item.id, 2);
    await flows.setGoods(card, 2, 'to_stock');
    const disputeId = await disputed(order.paymentId, opening);
    const blocked = await flows.post(`/api/returns/${card.id}/refund`, {});
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ errorCode: 'RETURN_REFUND_DISPUTED' });
    return { ...order, returnId: card.id, itemId: item.id, disputeId };
  }

  // root says what the bank took was for: the units of the order it gave back
  const decided = async (lineId: number, itemId: number, quantity: number, amount: number) => {
    const res = await flows.post(
      `/api/payments/money-lines/${lineId}/decision`,
      { items: [{ orderItemId: itemId, quantity, amount }], note: 'The bank paid for the lamps.' },
      root,
    );
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // the statement goes on where the dispute stopped it: its goods came back by a parcel, so its money
  // is the admin's to send
  it('lets the admin send the money of the statement once the shop won, and sends nothing by itself', async () => {
    const order = await waiting();
    const mails = watchMail();

    await ended(order.disputeId, 'won');

    expect(await refundsOf(order.paymentId)).toEqual([]);
    expect(mailsTo(mails, order.buyer.email)).toEqual([]);
    const sent = await flows.post(`/api/returns/${order.returnId}/refund`, {});
    expect(sent.statusCode).toBe(200);
    expect((await refundsOf(order.paymentId)).map((one) => one.amount)).toEqual([2000]);
    const [statement] = await statementsOf(order.orderId);
    expect(statement!.refundedTotal.toFixed(2)).toBe('20.00');
    expect(statement!.closedAt).toEqual(expect.any(Date));
    expect(mailsTo(mails, order.buyer.email)).toHaveLength(1);
  });

  // the bank holds what it took while the dispute goes on, and gives it back when the shop wins:
  // there is nothing to decide yet
  it('lets root decide on what the bank took only once the dispute is lost (MONEY_DECISION_DISPUTE_NOT_LOST)', async () => {
    const order = await waiting({ amount: 1200 });
    const [line] = await disputeLinesOf(order.paymentId);

    const res = await flows.post(
      `/api/payments/money-lines/${line!.id}/decision`,
      {
        items: [{ orderItemId: order.itemId, quantity: 1, amount: 10 }],
        note: 'The bank paid for a lamp.',
      },
      root,
    );

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'MONEY_DECISION_DISPUTE_NOT_LOST' });
  });

  // the bank took part of the payment: root says what it was for, the units of the order it gave back
  it('waits for root when the shop lost part of the payment on an order sent: the transfers of the order wait, the card says why', async () => {
    const order = await waiting({ amount: 1200 });
    const mails = watchMail();

    await ended(order.disputeId, 'lost');

    // what the bank took is of the order and waits for root: the transfers of the order with it
    const [line] = await disputeLinesOf(order.paymentId);
    expect(line).toMatchObject({ amount: '-12.00', returnId: null, moneyUse: null });
    const held = await flows.post(`/api/returns/${order.returnId}/refund`, {});
    expect(held.statusCode).toBe(409);
    expect(held.json()).toMatchObject({ errorCode: 'RETURN_BANK_MONEY_PENDING' });
    expect(mailsTo(mails, order.buyer.email)).toEqual([]);
    // the money of the statement waits for root, not for the shop: it is not late meanwhile
    const heldList = async (moneyHeld: boolean) =>
      (
        (await get(`/api/returns?orderId=${order.orderId}&moneyHeld=${moneyHeld}`)).json() as {
          items: { id: number }[];
        }
      ).items.map((one) => one.id);
    expect(await heldList(true)).toEqual([order.returnId]);
    expect(await heldList(false)).toEqual([]);
    // the card says why, and what the statement owes: 8 is left for the provider
    const waitingCard = (await get(`/api/returns/${order.returnId}`)).json();
    expect(waitingCard).toMatchObject({
      bankMoneyPending: true,
      moneyLeft: { total: 20, due: 20, covered: 0, paymentLeft: 8, short: true },
    });

    // the 12 pay part of the row of 20: nothing is paid at once, the money waits no more
    expect(await decided(line!.id, order.itemId, 2, 12)).toMatchObject({
      use: 'goods',
      covered: [],
    });
    expect((await get(`/api/returns/${order.returnId}`)).json()).toMatchObject({
      bankMoneyPending: false,
    });
  });

  // the bank took all of the payment and no other money of the buyer moved before it: the app shares
  // it among the goods by itself
  it('is shared by itself when the bank took all of the payment: the money of the bank pays the statement at once, asking Stripe for nothing', async () => {
    const order = await waiting();
    const mails = watchMail();

    await ended(order.disputeId, 'lost');

    const [line] = await disputeLinesOf(order.paymentId);
    expect(line).toMatchObject({ amount: '-20.00', returnId: null, moneyUse: 'goods' });
    expect(await refundsOf(order.paymentId)).toEqual([]);
    const [statement] = await statementsOf(order.orderId);
    expect(statement!.refundedTotal.toFixed(2)).toBe('20.00');
    expect(statement!.closedAt).toEqual(expect.any(Date));
    expect((await get(`/api/returns/${order.returnId}`)).json()).toMatchObject({
      bankMoneyPending: false,
      moneyLeft: { total: 0, due: 0 },
    });
    // the mail of the end says the bank gave the money, not the shop
    const [end] = mailsTo(mails, order.buyer.email);
    expect(end!.subject).toContain('is closed');
    expect(end!.text).toContain(
      `Your bank decided the dispute about your payment for order #${order.orderId} for you and ` +
        'gave you back €20.00.',
    );
    expect(end!.text).not.toContain('We sent you');
  });

  // the bank gave part of it and Stripe took no refund of the rest of a payment charged back (the
  // mock refuses it; whether the sandbox does is still to be seen), so root sent the rest another
  // way: the mail of the end tells each source as the buyer finds it
  it('tells the buyer what the bank gave and the rest root sent another way, by its way and its day', async () => {
    const order = await waiting({ amount: 1200 });
    await ended(order.disputeId, 'lost');
    const [line] = await disputeLinesOf(order.paymentId);
    // the 12 pay part of the row of 20: nothing is paid at once
    expect(await decided(line!.id, order.itemId, 2, 12)).toMatchObject({ covered: [] });
    const mails = watchMail();
    const [{ now }] = await asAdmin(
      (tx) => tx.$queryRaw<{ now: Date }[]>`select (now() at time zone 'UTC') as now`,
    );

    const sent = await flows.post(
      `/api/returns/${order.returnId}/refund/outside`,
      {
        method: 'bank_transfer',
        note: 'Sent to the account the buyer wrote by mail.',
        at: now!.toISOString(),
      },
      root,
    );

    expect(sent.statusCode).toBe(200);
    const [statement] = await statementsOf(order.orderId);
    expect(statement!.refundedTotal.toFixed(2)).toBe('20.00');
    expect(statement!.closedAt).toEqual(expect.any(Date));
    const [end] = mailsTo(mails, order.buyer.email);
    expect(end!.subject).toContain('is closed');
    expect(end!.text).toContain(
      `Your bank decided the dispute about your payment for order #${order.orderId} for you and ` +
        'gave you back €12.00.',
    );
    expect(end!.text).toMatch(/We sent you €8\.00 by a bank transfer on \d{1,2} \w+ \d{4}\./);
    expect(end!.text).not.toContain('It goes back the way you paid.');
  });
});

describeMock('a dispute of a payment the order could not take', () => {
  // the refund of the late payment was asked while the bank opened the dispute: Stripe refused it
  // for the dispute; the shop won, so the money is the shop's again and the app sends it
  it('sends the payment back again once the shop won', async () => {
    const late = await latePayment(deps());
    await withStripeOutOfReach(() => deliver(app, late.event));
    const disputeId = await disputed(late.paymentId);
    await settleRefundsInTransit(
      { info: () => undefined, warn: () => undefined, error: () => undefined },
      { paymentId: late.paymentId, olderThanMs: 0 },
    );
    expect((await moneyOfPayment(late.paymentId)).at(-1)).toMatchObject({
      event: 'money.refund_failed',
      failure: 'disputed',
    });
    const mails = watchMail();

    await ended(disputeId, 'won');

    expect(await rowOf(disputeId)).toMatchObject({ orderId: late.orderId, status: 'won' });
    expect((await moneyOfPayment(late.paymentId)).at(-1)).toMatchObject({
      event: 'money.refund',
      purpose: 'late_payment',
      amount: '-51.00',
      state: 'sent',
      transferKey: `refund:${late.paymentId}:5100`,
    });
    expect(
      mails.filter((mail) => mail.subject.includes('We sent your payment for order #')),
    ).toHaveLength(1);
  });
});

describe('a dispute of a payment that is none of the shop', () => {
  mockOnly('is acknowledged and named in the log, nothing is written', async () => {
    const paymentId = await payByCard(1000);
    const disputeId = openDispute(paymentId);
    const event = await disputeEvent('charge.dispute.created', disputeId);

    const res = await deliver(app, event);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, skipped: 'NOT_AN_ORDER' });
    expect(takeLogs({ msg: 'stripe event was skipped', skipped: 'NOT_AN_ORDER' })).toEqual([
      expect.objectContaining({ eventId: event.id, disputeId }),
    ]);
    expect(await rowOf(disputeId)).toBeNull();
    expect(await moneyOfPayment(paymentId)).toEqual([]);
  });
});

type ListItem = Record<string, unknown> & { id: number; stripeId: string };

const listOf = async (query: string, actor: TestUser = admin) => {
  const res = await get(`/api/payments/disputes?${query}`, actor);
  expect(res.statusCode).toBe(200);
  return res.json() as {
    items: ListItem[];
    total: number;
    limit: number;
    nextCursor: string | null;
  };
};

describeMock('GET /api/payments/disputes', () => {
  it('lets admin and root, not a buyer or a visitor', async () => {
    const order = await paidOrder();

    expect((await get('/api/payments/disputes', admin)).statusCode).toBe(200);
    expect((await get('/api/payments/disputes', root)).statusCode).toBe(200);
    for (const actor of [order.buyer, null]) {
      const res = await get('/api/payments/disputes', actor);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    }
  });

  it('gives each dispute with its state, the money it took and whether a statement of the order is open', async () => {
    const order = await paidOrder();
    const disputeId = await disputed(order.paymentId);
    const row = (await rowOf(disputeId))!;

    const page = await listOf(`orderId=${order.orderId}`);

    expect(page).toEqual({
      items: [
        {
          id: row.id,
          provider: 'stripe',
          stripeId: disputeId,
          paymentId: order.paymentId,
          orderId: order.orderId,
          userId: order.buyer.id,
          late: false,
          reason: 'fraudulent',
          status: 'needs_response',
          open: true,
          evidenceDueBy: row.evidenceDueBy!.toISOString(),
          hasEvidence: true,
          submissionCount: 0,
          isChargeRefundable: false,
          withdrawn: 20,
          returnOpen: false,
          openedAt: row.openedAt.toISOString(),
          closedAt: null,
          draftedAt: row.draftedAt!.toISOString(),
          createdAt: row.createdAt.toISOString(),
          updatedAt: expect.any(String),
        },
      ],
      total: 1,
      limit: 20,
      nextCursor: null,
    });
  });

  it('narrows by the status, open, to answer and the time it closed, and puts the nearest due first by pages', async () => {
    const order = await paidOrder();
    const answered = await disputed(order.paymentId, { method: 'paypal', amount: 500 });
    const open = await disputed(order.paymentId, { method: 'paypal', amount: 500 });
    const won = await disputed(order.paymentId, { method: 'paypal', amount: 500 });
    await ended(won, 'won');
    // a person submitted the evidence of one in the dashboard, and the due days differ
    await inOwnerTx(
      async (db) => {
        // the system, as the function that follows the provider writes the rows
        await db.as({ role: 'ADMIN' });
        await db.rows(
          `update cartlify.payment_disputes set "submissionCount" = 1, status = 'under_review',
             "evidenceDueBy" = now() + interval '2 days' where "stripeId" = $1`,
          answered,
        );
        await db.rows(
          `update cartlify.payment_disputes set "evidenceDueBy" = now() + interval '5 days'
           where "stripeId" = $1`,
          open,
        );
      },
      { commit: true },
    );
    const q = `orderId=${order.orderId}`;
    const ids = (page: { items: ListItem[] }) => page.items.map((item) => item.stripeId);

    expect(ids(await listOf(q))).toEqual([answered, open, won]);
    expect(ids(await listOf(`${q}&open=true`))).toEqual([answered, open]);
    expect(ids(await listOf(`${q}&open=false`))).toEqual([won]);
    expect(ids(await listOf(`${q}&toAnswer=true`))).toEqual([open]);
    expect(ids(await listOf(`${q}&status=won,under_review`))).toEqual([answered, won]);
    expect(
      ids(await listOf(`${q}&closedFrom=${new Date(Date.now() - 60_000).toISOString()}`)),
    ).toEqual([won]);
    expect(
      (await listOf(`${q}&closedFrom=${new Date(Date.now() + 60_000).toISOString()}`)).total,
    ).toBe(0);

    const first = await listOf(`${q}&limit=2`);
    expect(ids(first)).toEqual([answered, open]);
    expect(first.total).toBe(3);
    const second = await listOf(`${q}&limit=2&cursor=${first.nextCursor}`);
    expect(ids(second)).toEqual([won]);
    expect(second.nextCursor).toBeNull();
  });

  it.each([
    ['status=lost,closed'],
    ['open=maybe'],
    ['closedFrom=yesterday'],
    ['limit=0'],
    ['orderId=0'],
    ['cursor=***'],
  ])('refuses %s (VALIDATION_ERROR)', async (query) => {
    const res = await get(`/api/payments/disputes?${query}`);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('refuses a cursor that is none of the list (CURSOR_INVALID)', async () => {
    const res = await get(`/api/payments/disputes?cursor=bm90LWEtY3Vyc29y`);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });
});

describeMock('GET /api/payments/disputes/:disputeId', () => {
  it('gives the dispute with its money, the order and the statements of the order', async () => {
    const order = await paidOrder();
    const disputeId = await disputed(order.paymentId);
    await ended(disputeId, 'lost');
    const row = (await rowOf(disputeId))!;
    const [statement] = await statementsOf(order.orderId);

    const res = await get(`/api/payments/disputes/${row.id}`, root);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: row.id,
      stripeId: disputeId,
      status: 'lost',
      open: false,
      withdrawn: 20,
      money: [
        {
          id: expect.any(Number),
          event: 'money.dispute_withdrawn',
          amount: -20,
          currency: 'eur',
          stripeTxId: expect.stringMatching(/^txn_/),
          moneyUse: 'goods',
          createdAt: expect.any(String),
        },
      ],
      order: { id: order.orderId, status: 'cancelled', total: 20, holds: [] },
      returns: [
        {
          id: statement!.id,
          code: expect.any(String),
          reason: 'dispute_lost',
          refundedTotal: 20,
          moneyLeft: null,
          closedAt: expect.any(String),
        },
      ],
    });
  });

  // what each open statement still owes, for the decision on the money of the bank
  it('tells what an open statement of the order still owes', async () => {
    const order = await paidOrder('shipped');
    const item = await asAdmin((tx) =>
      tx.orderItem.findFirstOrThrow({ where: { orderId: order.orderId }, select: { id: true } }),
    );
    const card = await flows.adminStatement(order.orderId, item.id, 2);
    await flows.setGoods(card, 2, 'to_stock');
    const disputeId = await disputed(order.paymentId);
    const row = (await rowOf(disputeId))!;

    const res = await get(`/api/payments/disputes/${row.id}`, root);

    expect(res.statusCode).toBe(200);
    expect(res.json().returns).toEqual([
      expect.objectContaining({ id: card.id, moneyLeft: 20, closedAt: null }),
    ]);
  });

  it('answers DISPUTE_NOT_FOUND for a dispute that is not there, and a buyer is refused', async () => {
    const order = await paidOrder();

    const none = await get('/api/payments/disputes/2147483000');
    const buyer = await get('/api/payments/disputes/1', order.buyer);

    expect(none.statusCode).toBe(404);
    expect(none.json()).toMatchObject({ errorCode: 'DISPUTE_NOT_FOUND' });
    expect(buyer.statusCode).toBe(403);
  });
});
