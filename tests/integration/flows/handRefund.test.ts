import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { alertsOf } from '../../helpers/alerts.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import { asAdmin } from '../../helpers/db.js';
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
import { giveMoneyRight } from '../../helpers/moneyManager.js';
import { placePaidOrder } from '../../helpers/payments.js';
import { journeyOf, mailTo, mailsTo, statementCodeIn } from '../../helpers/returnJourney.js';
import {
  closeOpenSessions,
  deliver,
  refundAtStripe,
  refundBecomes,
  REFUND_FAIL_CARD,
  realStripe,
  refundsOf,
  stripeEvent,
  stripeWait,
} from '../../helpers/stripe.js';

// Money an admin gives back by hand in the dashboard of Stripe, each step with what its actor sees:
// Stripe tells the app of the
// refund, and what comes of it depends on the order. All of the payment of an order not sent cancels
// it by a statement of the system, the buyer is mailed; when the bank of the card sends that money
// back, the buyer is told and root sends it another way (B). Part of it holds the order until root
// decides to send it or to cancel it (V). While a statement of the order waits for its money the
// transfers of the order wait for root, who says what the refund was for: the units it gave back
// are paid with it first, the rest of it is a compensation (G). A refund of an order already sent is
// root's to say what it was for (D). What root decides, an admin root gave the right of the money
// to decides as well: some of the steps are that admin's. The rules and the refusals of each step
// are the tests of the routes (api/payments/handRefunds.test.ts, api/orders/holds.test.ts)

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
// an admin root gave the right of the money
let cashier: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];
const j = journeyOf(
  () => app,
  () => csrf,
);

// a refund made by hand that fails is mock only: the sandbox fails one of REFUND_FAIL_CARD only
const mockOnly = realStripe ? it.skip : it;

// what waits for root is found in the list an alert of root names, narrowed to the order or the
// buyer of the test (the alerts are shared by every file that runs at the same time)
const alerts = alertsOf({ app: () => app, csrf: () => csrf });
const rootFinds = async <T = Refund>(kind: string, narrow: Record<string, number>) =>
  (await alerts.listOf(root, kind, narrow)).items as unknown as T[];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  cashier = await createUser({ role: 'ADMIN' });
  await giveMoneyRight(root.id, cashier.id);
  userIds.push(admin.id, root.id, cashier.id);
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

type MoneyLine = {
  id: number;
  event: string;
  purpose: string;
  part: string;
  amount: number;
  state: string | null;
};
type Hold = { reason: string; ref: number | string };
type Refund = {
  id: number;
  purpose: string;
  state: string;
  need: string | null;
  returnId: number | null;
  refundId: string | null;
  amount: number;
  failure: string | null;
  at: string;
};

// a buyer of the test and an order of two units at 10 (no delivery to pay: 20 in all) that Stripe
// took the money for, paid by the card given; not sent yet
async function paidOrder(card?: string) {
  const buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(buyer.id);
  const product = await createProduct({ price: 10, stock: 10, name: `Desk lamp ${buyer.id}` });
  products.push(product);
  const placed = await placePaidOrder(app, csrf, buyer, product, {
    quantity: 2,
    ...(card ? { card } : {}),
  });
  return { ...placed, buyer, product };
}

// an admin gives money back in the dashboard of Stripe (all that is left unless cents are given),
// and Stripe tells the app of it
async function refundInDashboard(paymentId: string, cents?: number) {
  const refund = await refundAtStripe(paymentId, cents === undefined ? {} : { amount: cents });
  const told = await deliver(app, await stripeEvent('refund.created', refund.id));
  expect(told.statusCode).toBe(200);
  return refund;
}

// the order as an admin reads it
async function orderCardOf(orderId: number) {
  const res = await j.get(admin, `/api/orders/${orderId}`);
  expect(res.statusCode).toBe(200);
  return res.json();
}

// the statement as an admin reads it
async function statementCardOf(returnId: number) {
  const res = await j.get(admin, `/api/returns/${returnId}`);
  expect(res.statusCode).toBe(200);
  return res.json();
}

// the refunds of the money journal of an order under the filters, as root lists them
async function refundsListed(orderId: number, query: string): Promise<Refund[]> {
  const res = await j.get(root, `/api/payments/refunds?orderId=${orderId}&${query}`);
  expect(res.statusCode).toBe(200);
  return res.json().items;
}

// the lines of the journal of the admins of an order for an event
async function auditOf(orderId: number, event: string) {
  const res = await j.get(
    admin,
    `/api/admin/audit-log?events=${event}&entityType=order&entityId=${orderId}`,
  );
  expect(res.statusCode).toBe(200);
  return res.json().items as unknown[];
}

const toBuyer = (mails: SentMail[], buyer: TestUser) => mailsTo(mails, buyer.email, '');

// the money of an order at a glance: the event, what it is for, the part and the sum
const glanceOf = (lines: MoneyLine[]) =>
  lines.map((line) => [line.event, line.purpose, line.part, line.amount]);

describe('all of the payment of an order not sent, given back in the dashboard (B)', () => {
  // the card of the payment is one whose bank sends a refund back: in the sandbox about two
  // minutes after it went, the mock when the test says so
  it(
    'cancels the order with its goods back on the shelf and tells the buyer; the bank sends the money back, the buyer is told, root sends it another way',
    async () => {
      const { buyer, product, orderId, paymentId } = await paidOrder(REFUND_FAIL_CARD);
      const before = (await stockOf(product)).stock;
      const mails = watchMail();

      // the buyer asked by mail to call the order off; an admin gives all of it back in the dashboard
      const byHand = await refundInDashboard(paymentId);

      // the buyer is told the order is cancelled and the money sent, and sees it so
      const cancelled = mailTo(
        mails,
        buyer.email,
        `Order #${orderId} is cancelled and your money is sent back`,
      );
      expect(cancelled.text).toContain('€20.00');
      const seen = (await j.get(buyer, `/api/orders/${orderId}`)).json();
      expect(seen).toMatchObject({ status: 'cancelled', paymentCheck: false });
      expect(seen.withdrawals).toEqual([expect.objectContaining({ refundedTotal: 20 })]);

      // the admin sees the order cancelled by a statement of the system, nothing holds it; the
      // money: paid, given back by hand, the statement paid by that money without Stripe
      const card = await orderCardOf(orderId);
      expect(card).toMatchObject({
        status: 'cancelled',
        holds: [],
        returns: [
          expect.objectContaining({
            source: 'system',
            reason: 'stripe_refund',
            closedAt: expect.any(String),
          }),
        ],
        returnUnits: expect.objectContaining({ refundedTotal: 20 }),
      });
      expect(glanceOf(card.money)).toEqual([
        ['money.payment', 'order', 'goods', 20],
        ['money.refund', 'hand', 'whole', -20],
        ['money.refund', 'return', 'goods', -20],
        ['money.refund', 'return', 'covered', 20],
      ]);
      const statementId = card.returns[0].id as number;
      // nothing is left for root: the system decided it
      expect(await refundsListed(orderId, 'state=unassigned')).toEqual([]);

      // the bank of the card sends the money back: Stripe fails the refund made by hand
      await refundBecomes(byHand.id, { status: 'failed', reason: 'expired_or_canceled_card' });
      expect((await deliver(app, await stripeEvent('refund.failed', byHand.id))).statusCode).toBe(
        200,
      );

      // the buyer is told the money did not reach them; the order stays cancelled
      const failed = mailTo(
        mails,
        buyer.email,
        `We could not send your payment back for order #${orderId}`,
      );
      expect(failed.text).toContain('€20.00');
      expect(failed.text).toContain('sent back to us by your bank');
      const unpaid = (await j.get(buyer, `/api/orders/${orderId}`)).json();
      expect(unpaid.status).toBe('cancelled');
      expect(unpaid.withdrawals).toEqual([
        expect.objectContaining({
          refundedTotal: 0,
          refunds: [expect.objectContaining({ way: 'payment', state: 'failed', amount: 20 })],
        }),
      ]);
      expect((await statementCardOf(statementId)).refundedTotal).toBe(0);

      // root finds it in the alert of the failed refunds made by hand and sends the money by a bank
      // transfer
      const [refund, ...others] = await rootFinds('hand_refunds_failed', { orderId });
      expect(others).toEqual([]);
      expect(refund).toMatchObject({
        purpose: 'hand',
        refundId: byHand.id,
        amount: 20,
        failure: 'card_unavailable',
      });
      const sent = await j.post(root, `/api/payments/refunds/${refund!.id}/outside`, {
        method: 'bank_transfer',
        note: 'To the account the buyer wrote by mail.',
        at: refund!.at,
      });
      expect(sent.statusCode).toBe(200);
      expect(mailTo(mails, buyer.email, `We sent you money for order #${orderId}`).text).toContain(
        'We sent you €20.00',
      );

      // the statement of the system has its money again, the buyer sees how it went; nothing waits
      // for root
      expect((await statementCardOf(statementId)).refundedTotal).toBe(20);
      expect((await j.get(buyer, `/api/orders/${orderId}`)).json().withdrawals).toEqual([
        expect.objectContaining({
          refundedTotal: 20,
          refunds: [
            expect.objectContaining({ way: 'payment', state: 'failed', amount: 20 }),
            expect.objectContaining({
              way: 'outside',
              method: 'bank_transfer',
              state: 'sent',
              amount: 20,
            }),
          ],
        }),
      ]);
      expect(await rootFinds('hand_refunds_failed', { orderId })).toEqual([]);
      expect(toBuyer(mails, buyer)).toHaveLength(3);

      // the goods came back on the shelf once, Stripe was asked for no refund of its own
      expect((await stockOf(product)).stock).toBe(before + 2);
      expect((await refundsOf(paymentId)).map((one) => one.id)).toEqual([byHand.id]);
    },
    stripeWait,
  );
});

describe('part of the payment of an order not sent, given back in the dashboard (V)', () => {
  // an admin gives 5 of the 20 back: the order is held for root, the buyer hears nothing; root
  // finds it among the orders a refund made by hand holds
  async function partlyGivenBack() {
    const order = await paidOrder();
    const mails = watchMail();
    const byHand = await refundInDashboard(order.paymentId, 500);

    // the admin cannot send it
    const ship = await j.patch(admin, `/api/orders/${order.orderId}/status`, {
      status: 'shipped',
    });
    expect(ship.statusCode).toBe(409);
    expect(ship.json()).toMatchObject({
      errorCode: 'ORDER_ON_HOLD',
      details: { orderId: order.orderId, holds: ['hand_refund'] },
    });

    const rows = await rootFinds<{ id: number; holds: Hold[]; money: MoneyLine[] }>(
      'hand_refunds_to_decide',
      { userId: order.buyer.id },
    );
    expect(rows.map((row) => row.id)).toEqual([order.orderId]);
    expect(toBuyer(mails, order.buyer)).toEqual([]);

    // what holds it is the refund made by hand among the money of the order
    const [row] = rows;
    expect(row!.holds).toEqual([expect.objectContaining({ reason: 'hand_refund' })]);
    expect(row!.money.find((line) => line.id === row!.holds[0]!.ref)).toMatchObject({
      event: 'money.refund',
      purpose: 'hand',
      amount: -5,
    });
    return { ...order, mails, byHand };
  }

  it('is sent when the admin with the right of the money says so: the refund is a compensation, the order goes', async () => {
    const { buyer, orderId, paymentId, mails } = await partlyGivenBack();

    const decided = await j.post(cashier, `/api/orders/${orderId}/holds/hand_refund/decision`, {
      decision: 'ship',
      note: 'Paid back for a scratch the buyer saw on the photo.',
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ status: 'paid', holds: [] });

    // the admin sends the order, the buyer is told it is on its way
    const shipped = await j.patch(admin, `/api/orders/${orderId}/status`, {
      status: 'shipped',
      shipment: { carrier: 'Nova Poshta', trackingNumber: '20450000000011' },
    });
    expect(shipped.statusCode).toBe(200);
    expect(mailTo(mails, buyer.email, `Order #${orderId} is shipped`).text).toContain(
      '20450000000011',
    );
    expect(toBuyer(mails, buyer)).toHaveLength(1);

    // nothing is left for root, the journal of the admins keeps the decision; Stripe was asked for
    // nothing more
    expect(await refundsListed(orderId, 'state=unassigned')).toEqual([]);
    expect(await auditOf(orderId, 'order.hold_decide')).toHaveLength(1);
    expect(await refundsOf(paymentId)).toHaveLength(1);
    const [hand] = await asAdmin((tx) =>
      tx.moneyLog.findMany({
        where: { paymentId, purpose: 'hand' },
        select: { moneyUse: true, meta: true, returnId: true },
      }),
    );
    expect(hand).toEqual({ moneyUse: 'compensation', meta: [], returnId: null });
  });

  mockOnly(
    'is sent when root says so, and the bank sends the refund back: root finds it and sends the 5 another way',
    async () => {
      const { buyer, orderId, mails, byHand } = await partlyGivenBack();
      const decided = await j.post(root, `/api/orders/${orderId}/holds/hand_refund/decision`, {
        decision: 'ship',
        note: 'Paid back for a scratch the buyer saw on the photo.',
      });
      expect(decided.statusCode).toBe(200);
      expect(await rootFinds('hand_refunds_to_decide', { userId: buyer.id })).toEqual([]);

      await refundBecomes(byHand.id, { status: 'failed', reason: 'expired_or_canceled_card' });
      expect((await deliver(app, await stripeEvent('refund.failed', byHand.id))).statusCode).toBe(
        200,
      );

      // root finds the compensation that did not reach the buyer and sends it by a bank transfer
      const [failed, ...others] = await rootFinds('hand_refunds_failed', { orderId });
      expect(others).toEqual([]);
      expect(failed).toMatchObject({ purpose: 'hand', refundId: byHand.id, amount: 5 });
      const sent = await j.post(root, `/api/payments/refunds/${failed!.id}/outside`, {
        method: 'bank_transfer',
        note: 'To the account the buyer wrote by mail.',
        at: failed!.at,
      });
      expect(sent.statusCode).toBe(200);
      expect(await rootFinds('hand_refunds_failed', { orderId })).toEqual([]);
      expect(mailTo(mails, buyer.email, `We sent you money for order #${orderId}`).text).toContain(
        'We sent you €5.00',
      );
      expect(glanceOf((await orderCardOf(orderId)).money)).toEqual([
        ['money.payment', 'order', 'goods', 20],
        ['money.refund', 'hand', 'whole', -5],
        ['money.refund_failed', 'hand', 'whole', 5],
        ['money.outside', 'hand', 'whole', -5],
      ]);
    },
  );

  it('is cancelled when root says so: a statement of the shop takes the whole order, Stripe sends the rest', async () => {
    const { buyer, product, orderId, paymentId, mails, byHand } = await partlyGivenBack();
    const before = (await stockOf(product)).stock;

    const decided = await j.post(root, `/api/orders/${orderId}/holds/hand_refund/decision`, {
      decision: 'cancel',
      note: 'The buyer asked to cancel the order.',
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({
      status: 'cancelled',
      holds: [],
      returns: [expect.objectContaining({ source: 'admin', reason: 'shop_cancel' })],
    });

    // the usual mails of a cancel by the shop: the statement, then its money in all
    mailTo(mails, buyer.email, `Return of order #${orderId} registered`);
    expect(mailTo(mails, buyer.email, `Return of order #${orderId} is closed`).text).toContain(
      'We sent you €20.00.',
    );
    expect(toBuyer(mails, buyer)).toHaveLength(2);

    // the buyer sees the order cancelled and all of its money back
    const seen = (await j.get(buyer, `/api/orders/${orderId}`)).json();
    expect(seen.status).toBe('cancelled');
    expect(seen.withdrawals).toEqual([expect.objectContaining({ refundedTotal: 20 })]);
    // the admin sees the money: the refund made by hand is part of the statement
    const card = await orderCardOf(orderId);
    expect(card.returnUnits).toMatchObject({ refundedTotal: 20 });

    // Stripe sent only what the refund made by hand did not; the goods are back on the shelf
    const refunds = await refundsOf(paymentId);
    expect(refunds.map((one) => one.amount).sort((a, b) => a - b)).toEqual([500, 1500]);
    expect(refunds.map((one) => one.id)).toContain(byHand.id);
    expect((await stockOf(product)).stock).toBe(before + 2);
    expect(await auditOf(orderId, 'order.hold_decide')).toHaveLength(1);
  });
});

describe('money given back in the dashboard while a statement of the order waits for its money (G)', () => {
  // the order went, the buyer withdrew from units of it on the page of the order and the admin took
  // the goods in; meanwhile an admin gave 10 back in the dashboard. The transfer of the statement
  // waits for root, who finds the refund among those to say what they were for
  async function waitingWithRefundByHand(units: number) {
    const order = await paidOrder();
    expect(
      (await j.patch(admin, `/api/orders/${order.orderId}/status`, { status: 'shipped' }))
        .statusCode,
    ).toBe(200);
    const mails = watchMail();
    const [free] = (await j.get(order.buyer, `/api/orders/${order.orderId}`)).json().withdrawable;
    const made = await j.post(order.buyer, `/api/orders/${order.orderId}/withdrawal`, {
      items: [{ orderItemId: free.orderItemId, quantity: units }],
    });
    expect(made.statusCode).toBe(201);
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
          results: [{ itemId: row.id, quantity: units, goods: 'to_stock' }],
        })
      ).statusCode,
    ).toBe(200);

    const byHand = await refundInDashboard(order.paymentId, 1000);

    // the admin cannot send the money: the card says a refund made by hand waits for root
    const refused = await j.post(admin, `/api/returns/${returnId}/refund`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ errorCode: 'RETURN_HAND_REFUND_PENDING' });
    expect(await statementCardOf(returnId)).toMatchObject({
      handRefundPending: true,
      refundedTotal: 0,
      closedAt: null,
    });

    const listed = await rootFinds('hand_refunds_to_explain', { orderId: order.orderId });
    expect(listed).toEqual([
      expect.objectContaining({
        purpose: 'hand',
        need: 'explain',
        refundId: byHand.id,
        amount: 10,
        returnId: null,
      }),
    ]);
    return { ...order, mails, returnId, row, refund: listed[0]!, byHand };
  }

  // root reads the row of the statement in its card and says the refund was for one unit of it
  const forOneUnit = (refundId: number, row: { orderItemId: number }) =>
    j.post(root, `/api/payments/money-lines/${refundId}/decision`, {
      items: [{ orderItemId: row.orderItemId, quantity: 1, amount: 10 }],
      note: 'The buyer was paid for one of the units sent back.',
    });

  it('is given to a unit by root: the transfer of the admin asks Stripe only for the rest, the statement is over', async () => {
    const { buyer, orderId, paymentId, mails, returnId, row, refund } =
      await waitingWithRefundByHand(2);

    const decided = await forOneUnit(refund.id, row);
    expect(decided.statusCode).toBe(200);
    // the row is of two units: nothing is paid at once
    expect(decided.json()).toMatchObject({ use: 'goods', covered: [] });
    expect(await refundsListed(orderId, 'state=unassigned')).toEqual([]);
    expect(await statementCardOf(returnId)).toMatchObject({ handRefundPending: false });

    // the admin sends the money as always
    const sent = await j.post(admin, `/api/returns/${returnId}/refund`);
    expect(sent.statusCode).toBe(200);

    // the buyer is told the statement is over with all of its money
    expect(mailTo(mails, buyer.email, `Return of order #${orderId} is closed`).text).toContain(
      'We sent you €20.00.',
    );
    expect(await statementCardOf(returnId)).toMatchObject({
      refundedTotal: 20,
      closedAt: expect.any(String),
    });

    // the money journal of the admins: the refund is of the order, the part it covered names it
    const lines = (
      await j.get(admin, `/api/admin/money-log?orderId=${orderId}&sortOrder=asc&limit=100`)
    ).json().items as (MoneyLine & {
      returnId: number | null;
      coversId: number | null;
      moneyUse: string | null;
    })[];
    expect(lines.find((line) => line.id === refund.id)).toMatchObject({
      returnId: null,
      moneyUse: 'goods',
    });
    expect(lines.filter((line) => line.part === 'covered')).toEqual([
      expect.objectContaining({ amount: 10, coversId: refund.id, returnId }),
    ]);

    // Stripe sent the other 10 only
    const refunds = await refundsOf(paymentId);
    expect(refunds.map((one) => one.amount)).toEqual([1000, 1000]);
    expect(await auditOf(orderId, 'payment.money_decision')).toHaveLength(1);
  });

  // the rows stay refunded, the statement owes
  // exactly the sum that failed, root sends it another way
  mockOnly(
    'is given to a unit by root, then the bank sends the refund made by hand back: the buyer is told, root sends that sum another way',
    async () => {
      const { buyer, orderId, mails, returnId, row, refund, byHand } =
        await waitingWithRefundByHand(2);
      expect((await forOneUnit(refund.id, row)).statusCode).toBe(200);
      expect((await j.post(admin, `/api/returns/${returnId}/refund`)).statusCode).toBe(200);
      expect(await statementCardOf(returnId)).toMatchObject({ refundedTotal: 20 });

      // the bank of the card sends the 10 given back by hand back
      await refundBecomes(byHand.id, { status: 'failed', reason: 'expired_or_canceled_card' });
      expect((await deliver(app, await stripeEvent('refund.failed', byHand.id))).statusCode).toBe(
        200,
      );

      // the statement owes exactly those 10; the buyer, told the statement was closed with all of the
      // money, is told they did not reach them (checked at the end, with the other mails)
      const failedMails = mailsTo(
        mails,
        buyer.email,
        `We could not send your payment back for order #${orderId}`,
      );
      expect((await statementCardOf(returnId)).refundedTotal).toBe(10);

      // root finds it in the alert of the failed refunds made by hand and sends the 10 another way
      const [failed, ...others] = await rootFinds('hand_refunds_failed', { orderId });
      expect(others).toEqual([]);
      expect(failed).toMatchObject({ id: refund.id, purpose: 'hand', amount: 10, returnId: null });
      const sent = await j.post(root, `/api/payments/refunds/${failed!.id}/outside`, {
        method: 'bank_transfer',
        note: 'To the account the buyer wrote by mail.',
        at: failed!.at,
      });
      expect(sent.statusCode).toBe(200);

      // the statement has all of its money again; the buyer is told how and when it went
      expect(await statementCardOf(returnId)).toMatchObject({
        refundedTotal: 20,
        closedAt: expect.any(String),
      });
      expect(await rootFinds('hand_refunds_failed', { orderId })).toEqual([]);
      expect(mailTo(mails, buyer.email, `We sent you money for order #${orderId}`).text).toContain(
        'We sent it by a bank transfer on ',
      );
      expect(failedMails).toHaveLength(1);
      expect(failedMails[0]!.text).toContain('€10.00');
    },
  );

  // the buyer withdrew from one unit: the refund made by hand and the statement are both within
  // what the buyer paid
  it('is a compensation by the admin with the right of the money: the statement goes on as always and Stripe sends all of it', async () => {
    const { buyer, orderId, paymentId, mails, returnId, refund } = await waitingWithRefundByHand(1);

    const explained = await j.post(cashier, `/api/payments/money-lines/${refund.id}/decision`, {
      items: [],
      note: 'A gesture for the parcel that came late.',
    });
    expect(explained.statusCode).toBe(200);
    expect(explained.json()).toMatchObject({
      moneyLogId: refund.id,
      use: 'compensation',
      rest: '10.00',
      covered: [],
    });

    // the admin sends the money as always
    const sent = await j.post(admin, `/api/returns/${returnId}/refund`);
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ refundedTotal: 10, closedAt: expect.any(String) });
    expect(mailTo(mails, buyer.email, `Return of order #${orderId} is closed`).text).toContain(
      'We sent you €10.00.',
    );
    expect(await refundsListed(orderId, 'state=unassigned')).toEqual([]);

    const refunds = await refundsOf(paymentId);
    expect(refunds.map((one) => one.amount)).toEqual([1000, 1000]);
    expect(await auditOf(orderId, 'payment.money_decision')).toHaveLength(1);
  });

  // the 10 given back by hand were a gesture: the payment holds 10 of the 20 the statement owes.
  // The transfer sends what is left of the payment, and the rest of the row goes outside the app
  it('is a compensation that leaves the payment short: Stripe sends what is left, the rest goes outside the app and the statement closes', async () => {
    const { buyer, orderId, paymentId, mails, returnId, refund } = await waitingWithRefundByHand(2);
    const explained = await j.post(root, `/api/payments/money-lines/${refund.id}/decision`, {
      items: [],
      note: 'A gesture for the parcel that came late.',
    });
    expect(explained.statusCode).toBe(200);

    // the admin with the right of the money finds the statement among those whose money does not
    // fit in the payment, and its card says how much is left of it
    const short = async () =>
      (await alerts.listOf(cashier, 'returns_money_short', { userId: buyer.id })).items.map(
        (one) => one.id,
      );
    expect(await short()).toEqual([returnId]);
    const before = (await j.get(cashier, `/api/returns/${returnId}`)).json();
    expect(before.moneyLeft).toMatchObject({ due: 20, paymentLeft: 10, short: true });

    // the admin sends the money as always: Stripe sends the 10 left of the payment, the row is
    // paid 10 of its 20
    const sent = await j.post(admin, `/api/returns/${returnId}/refund`);
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ refundedTotal: 10, closedAt: null });
    expect(sent.json().items).toEqual([
      expect.objectContaining({ amount: 20, paid: 10, money: 'not_refunded' }),
    ]);
    // the buyer is told what went now
    expect(mailTo(mails, buyer.email, `Money sent for order #${orderId}`).text).toContain(
      'We sent you €10.00',
    );
    expect(await short()).toEqual([returnId]);
    const card = (await j.get(cashier, `/api/returns/${returnId}`)).json();
    expect(card.moneyLeft).toMatchObject({ due: 10, paymentLeft: 0, short: true });

    // that admin sends the rest another way, on the day it went
    const rest = await j.post(cashier, `/api/returns/${returnId}/refund/outside`, {
      method: 'bank_transfer',
      note: 'To the account the buyer wrote by mail.',
      at: card.statedAt,
    });
    expect(rest.statusCode).toBe(200);
    expect(rest.json()).toMatchObject({ refundedTotal: 20, closedAt: expect.any(String) });
    expect(rest.json().items).toEqual([
      expect.objectContaining({ amount: 20, paid: 20, money: 'refunded' }),
    ]);
    expect(await short()).toEqual([]);

    // the buyer is told the statement is closed with all of its money, and how each part went: 10
    // the way the buyer paid, 10 by a bank transfer
    const closed = mailTo(mails, buyer.email, `Return of order #${orderId} is closed`);
    expect(closed.text).toContain('We sent you €10.00.');
    expect(closed.text).toContain('It goes back the way you paid.');
    expect(closed.text).toContain('bank transfer');
    // Stripe sent the gesture and what was left of the payment
    expect((await refundsOf(paymentId)).map((one) => one.amount)).toEqual([1000, 1000]);
  });
});

describe('money given back in the dashboard of an order already sent (D)', () => {
  // an admin gave 10 back by hand for one of the two lamps, which came scratched; root says so, and
  // the buyer later sends both lamps back: the transfer takes the 10 first and asks Stripe for the rest
  it('is given to a lamp by root, and a later return of both lamps takes it first: Stripe sends the other lamp only', async () => {
    const { buyer, orderId, paymentId } = await paidOrder();
    expect(
      (await j.patch(admin, `/api/orders/${orderId}/status`, { status: 'shipped' })).statusCode,
    ).toBe(200);
    const mails = watchMail();
    const byHand = await refundInDashboard(paymentId, 1000);

    // root reads the item of the order and gives the refund to one lamp
    const [refund] = await rootFinds('hand_refunds_to_explain', { orderId });
    expect(refund).toMatchObject({ refundId: byHand.id, amount: 10 });
    const [item] = (await j.get(root, `/api/orders/${orderId}`)).json().items as { id: number }[];
    const decided = await j.post(root, `/api/payments/money-lines/${refund!.id}/decision`, {
      items: [{ orderItemId: item!.id, quantity: 1, amount: 10 }],
      note: 'Paid back for the scratched lamp.',
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ use: 'goods', covered: [] });
    expect(toBuyer(mails, buyer)).toEqual([]);

    // the buyer sends both lamps back, the admin takes them in and sends the money
    expect((await j.post(buyer, `/api/orders/${orderId}/withdrawal`)).statusCode).toBe(201);
    const code = statementCodeIn(mailTo(mails, buyer.email, `Withdrawal from order #${orderId}`));
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
    const sent = await j.post(admin, `/api/returns/${returnId}/refund`);
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ refundedTotal: 20, closedAt: expect.any(String) });

    // the buyer is told the statement is over with all of its money; Stripe sent the other lamp only
    expect(mailTo(mails, buyer.email, `Return of order #${orderId} is closed`).text).toContain(
      'We sent you €20.00.',
    );
    expect((await refundsOf(paymentId)).map((one) => one.amount)).toEqual([1000, 1000]);
    const lines = (
      await j.get(admin, `/api/admin/money-log?orderId=${orderId}&sortOrder=asc&limit=100`)
    ).json().items as (MoneyLine & { returnId: number | null; coversId: number | null })[];
    expect(lines.filter((line) => line.part === 'covered')).toEqual([
      expect.objectContaining({ amount: 10, coversId: refund!.id, returnId }),
    ]);
  });

  // root took the refund for a gesture first; the buyer sends the lamps back and root sees the 10
  // were for one of them: the decision is made again (no statement took its shares yet), and the
  // transfer of the statement takes the 10 first
  it('is decided again by root while no statement took its shares: the later return takes the 10 first', async () => {
    const { buyer, orderId, paymentId } = await paidOrder();
    expect(
      (await j.patch(admin, `/api/orders/${orderId}/status`, { status: 'shipped' })).statusCode,
    ).toBe(200);
    const mails = watchMail();
    await refundInDashboard(paymentId, 1000);

    const [refund] = await rootFinds('hand_refunds_to_explain', { orderId });
    const first = await j.post(root, `/api/payments/money-lines/${refund!.id}/decision`, {
      items: [],
      note: 'A gesture for the parcel that came late.',
    });
    expect(first.json()).toMatchObject({ use: 'compensation' });

    // the buyer sends both lamps back; root sees the 10 were for a lamp and decides again
    expect((await j.post(buyer, `/api/orders/${orderId}/withdrawal`)).statusCode).toBe(201);
    const [item] = (await j.get(root, `/api/orders/${orderId}`)).json().items as { id: number }[];
    const again = await j.post(root, `/api/payments/money-lines/${refund!.id}/decision`, {
      items: [{ orderItemId: item!.id, quantity: 1, amount: 10 }],
      note: 'It was for the scratched lamp.',
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ use: 'goods' });

    // the admin takes both lamps in and sends the money: Stripe sends the other lamp only
    const code = statementCodeIn(mailTo(mails, buyer.email, `Withdrawal from order #${orderId}`));
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
    const sent = await j.post(admin, `/api/returns/${returnId}/refund`);
    expect(sent.json()).toMatchObject({ refundedTotal: 20, closedAt: expect.any(String) });
    expect((await refundsOf(paymentId)).map((one) => one.amount)).toEqual([1000, 1000]);
  });

  it('leaves the order to go on and waits for root to say what it was for, the buyer hears nothing of it', async () => {
    const { buyer, orderId, paymentId } = await paidOrder();
    expect(
      (await j.patch(admin, `/api/orders/${orderId}/status`, { status: 'shipped' })).statusCode,
    ).toBe(200);
    const mails = watchMail();

    // an admin gives 5 back in the dashboard, a gesture for a parcel that came late
    const byHand = await refundInDashboard(paymentId, 500);

    // the order goes on: the admin marks it delivered
    expect(
      (await j.patch(admin, `/api/orders/${orderId}/status`, { status: 'delivered' })).statusCode,
    ).toBe(200);

    // root is to say what the refund was for, and does: a compensation
    const [refund, ...others] = await rootFinds('hand_refunds_to_explain', { orderId });
    expect(others).toEqual([]);
    expect(refund).toMatchObject({ purpose: 'hand', refundId: byHand.id, amount: 5 });
    const explained = await j.post(root, `/api/payments/money-lines/${refund!.id}/decision`, {
      items: [],
      note: 'Goodwill for a delay of the carrier.',
    });
    expect(explained.statusCode).toBe(200);
    expect(await refundsListed(orderId, 'state=unassigned')).toEqual([]);
    expect(await auditOf(orderId, 'payment.money_decision')).toHaveLength(1);

    // the buyer was told of the delivery only
    expect(toBuyer(mails, buyer).map((mail) => mail.subject)).toEqual([
      expect.stringContaining(`Order #${orderId} is delivered`),
    ]);
  });
});
