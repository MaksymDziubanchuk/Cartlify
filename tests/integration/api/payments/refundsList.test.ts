import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import {
  deliverOk,
  failedLateRefund,
  latePayment,
  moneyOfPayment,
  refundEvent,
  refundOf,
} from '../../../helpers/lateRefund.js';
import { returnFlows } from '../../../helpers/returnFlows.js';
import { failReturnRefund, refundReturn } from '../../../helpers/returns.js';
import {
  closeOpenSessions,
  deliver,
  queueRefundOutcome,
  realStripe,
  refundAtStripe,
  stripeEvent,
} from '../../../helpers/stripe.js';
import { placePaidOrder } from '../../../helpers/payments.js';

// GET /api/payments/refunds: the refunds of the money journal, each one request of the app (a
// transfer of a statement in its parts, a refund of a late payment) or one refund made by hand in
// the dashboard, with where it stands. state=failed: the failures the shop still has to act on;
// in_transit: asked and not told sent; unassigned: a refund made by hand root has not tied or
// explained; any (the default): all of them. The oldest state first, a page at a time. The alerts
// of the refunds name it (api/admin/alertsLateRefunds.test.ts)

type Row = {
  id: number;
  purpose: string;
  state: string;
  need: string | null;
  orderId: number | null;
  userId: number | null;
  returnId: number | null;
  provider: string | null;
  paymentId: string | null;
  refundId: string | null;
  amount: number;
  currency: string | null;
  failure: string | null;
  failureText: string | null;
  bankReference: string | null;
  byDashboard: boolean;
  createdAt: string;
  at: string;
};
type Page = { items: Row[]; total: number; limit: number; nextCursor: string | null };

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let buyer: TestUser;
let product: TestProduct;
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
  buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(admin.id, root.id, buyer.id);
  product = await createProduct({ price: 10, stock: 500 });
  products.push(product);
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

const listOf = async (query: string, actor: TestUser = admin) => {
  const res = await get(`/api/payments/refunds?${query}`, actor);
  expect(res.statusCode).toBe(200);
  return res.json() as Page;
};

// the first line of the refund of a late payment: the id of its refund in the list
const refundLineOf = async (paymentId: string) =>
  (await moneyOfPayment(paymentId)).find((line) => line.event === 'money.refund')!.id;

// the first line of the transfers of a statement, the oldest first
const transferLinesOf = (returnId: number) =>
  asAdmin(async (tx) =>
    (
      await tx.moneyLog.findMany({
        where: { returnId, event: 'money.refund', part: 'goods' },
        orderBy: { id: 'asc' },
        select: { id: true },
      })
    ).map((line) => line.id),
  );

// a statement of an admin for a unit of a sent order of the buyer, the goods on the shelf, whose
// transfer failed
async function failedStatement(of: TestUser = buyer) {
  const placed = await flows.shippedOrder(of, product, 1);
  const card = await flows.adminStatement(placed.orderId, placed.itemId, 1);
  await flows.setGoods(card, 1, 'to_stock');
  await failReturnRefund(admin.id, card.id, 'card_unavailable');
  return { ...placed, returnId: card.id };
}

describe('who may read it', () => {
  it('lets admin and root, not a buyer or a visitor', async () => {
    const failed = await failedLateRefund(deps());
    const query = `state=failed&orderId=${failed.orderId}`;

    const visitor = await get(`/api/payments/refunds?${query}`, null);
    expect(visitor.statusCode).toBe(403);
    expect(visitor.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    const refused = await get(`/api/payments/refunds?${query}`, failed.user);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect((await listOf(query, admin)).total).toBe(1);
    expect((await listOf(query, root)).total).toBe(1);
  });

  it.each([
    ['a state that is none', 'state=unsent'],
    ['a purpose that is none', 'purpose=order'],
    ['a need that is none', 'need=decide'],
    ['an order that is none', 'orderId=0'],
    ['a time that is none', 'to=yesterday'],
    ['a limit past the largest', 'limit=101'],
  ])('refuses %s', async (_name, query) => {
    const res = await get(`/api/payments/refunds?${query}`);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('refuses a cursor that is none', async () => {
    const res = await get('/api/payments/refunds?cursor=abc');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });
});

describe('a refund of the list', () => {
  it('is a late payment whose refund failed, with what root needs to send it another way', async () => {
    const failed = await failedLateRefund(deps());

    const page = await listOf(`state=failed&orderId=${failed.orderId}`);

    expect(page).toEqual({
      items: [
        {
          id: await refundLineOf(failed.paymentId),
          purpose: 'late_payment',
          state: 'failed',
          need: null,
          orderId: failed.orderId,
          userId: failed.user.id,
          returnId: null,
          returnCode: null,
          provider: 'stripe',
          paymentId: failed.paymentId,
          refundId: failed.refundId,
          amount: 51,
          currency: 'eur',
          failure: 'card_unavailable',
          failureText: 'expired_or_canceled_card',
          bankReference: null,
          byDashboard: false,
          createdAt: expect.any(String),
          at: expect.any(String),
          // the refund failed: all of the payment is still at the provider
          paymentLeft: 51,
          // a late payment has no statement
          returnLeft: null,
        },
      ],
      total: 1,
      limit: 20,
      nextCursor: null,
    });
    // the state is the time it failed, after the refund was asked
    expect(Date.parse(page.items[0]!.at)).toBeGreaterThanOrEqual(
      Date.parse(page.items[0]!.createdAt),
    );
  });

  it('is a transfer of a statement in all its parts, named by its first line', async () => {
    const failed = await failedStatement();

    const page = await listOf(`state=failed&orderId=${failed.orderId}`);

    expect(page.items).toEqual([
      expect.objectContaining({
        id: (await transferLinesOf(failed.returnId))[0],
        purpose: 'return',
        state: 'failed',
        need: null,
        orderId: failed.orderId,
        userId: buyer.id,
        returnId: failed.returnId,
        // the code of the statement, as the admins know it, and the payment the transfer did not take
        returnCode: `R${failed.orderId}-1`,
        provider: 'stripe',
        amount: 10,
        failure: 'card_unavailable',
        failureText: 'test',
        paymentLeft: 10,
        // what the open statement still has to send: the row whose transfer failed
        returnLeft: 10,
      }),
    ]);
  });

  it('is sent once the provider told so, among all of them only', async () => {
    const sent = await latePayment(deps());
    await deliver(app, sent.event);

    expect((await listOf(`orderId=${sent.orderId}`)).items).toEqual([
      expect.objectContaining({ purpose: 'late_payment', state: 'sent', failure: null }),
    ]);
    expect((await listOf(`state=any&orderId=${sent.orderId}`)).total).toBe(1);
    expect((await listOf(`state=failed&orderId=${sent.orderId}`)).items).toEqual([]);
    expect((await listOf(`state=in_transit&orderId=${sent.orderId}`)).items).toEqual([]);
  });

  it('puts the oldest state first and pages by a cursor', async () => {
    const late = await failedLateRefund(deps(), { name: 'Late Buyer' });
    const statement = await failedStatement(late.user);
    const query = (extra = '') => `state=failed&userId=${late.user.id}${extra}`;

    const all = await listOf(query());
    expect(all.total).toBe(2);
    const times = all.items.map((row) => Date.parse(row.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(all.items.map((row) => row.purpose)).toEqual(['late_payment', 'return']);

    const first = await listOf(query('&limit=1'));
    expect(first.items).toHaveLength(1);
    expect(first.total).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listOf(query(`&limit=1&cursor=${first.nextCursor}`));
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect([first.items[0]!.id, second.items[0]!.id]).toEqual(all.items.map((row) => row.id));
    expect(second.items[0]!.returnId).toBe(statement.returnId);
  });

  it('narrows to the kind, the buyer, the order and the time', async () => {
    const failed = await failedLateRefund(deps());
    const [row] = (await listOf(`state=failed&orderId=${failed.orderId}`)).items;
    const at = Date.parse(row!.at);

    expect((await listOf(`state=failed&userId=${failed.user.id}`)).total).toBe(1);
    expect((await listOf(`purpose=late_payment&orderId=${failed.orderId}`)).total).toBe(1);
    expect((await listOf(`purpose=return&orderId=${failed.orderId}`)).total).toBe(0);
    expect((await listOf(`state=failed&userId=${buyer.id}&orderId=${failed.orderId}`)).total).toBe(
      0,
    );
    const before = new Date(at - 1000).toISOString();
    const after = new Date(at + 1000).toISOString();
    expect((await listOf(`orderId=${failed.orderId}&to=${before}`)).total).toBe(0);
    expect((await listOf(`orderId=${failed.orderId}&to=${after}`)).total).toBe(1);
    expect((await listOf(`orderId=${failed.orderId}&from=${before}`)).total).toBe(1);
    expect((await listOf(`orderId=${failed.orderId}&from=${after}`)).total).toBe(0);
  });
});

describe('the failures that wait for the shop', () => {
  // the rows of the statement got their money by the second transfer: the first failure waits for
  // nothing, it stays in all of them as the failure it was
  it('keeps out a statement whose transfer went through at the second try', async () => {
    const failed = await failedStatement();
    await refundReturn(admin.id, failed.returnId);

    expect((await listOf(`state=failed&orderId=${failed.orderId}`)).items).toEqual([]);
    expect(
      (await listOf(`orderId=${failed.orderId}`)).items.map((row) => [row.purpose, row.state]),
    ).toEqual([
      ['return', 'failed'],
      ['return', 'sent'],
    ]);
  });

  it('keeps out a refund root has sent another way: it is outside', async () => {
    const failed = await failedLateRefund(deps());
    const [row] = (await listOf(`state=failed&orderId=${failed.orderId}`)).items;
    const marked = await app.inject({
      method: 'POST',
      url: `/api/payments/refunds/${row!.id}/outside`,
      headers: withCsrf(csrf, accessCookie(root)),
      payload: { method: 'cash', note: 'Handed over.', at: row!.at },
    });

    // the mark itself is tested in refundsOutside.test.ts: here only the list follows it
    expect(marked.statusCode).toBe(200);
    expect((await listOf(`state=failed&orderId=${failed.orderId}`)).items).toEqual([]);
    expect((await listOf(`orderId=${failed.orderId}`)).items).toEqual([
      expect.objectContaining({ id: row!.id, state: 'outside' }),
    ]);
  });

  // the money went back by hand: the refunds made by hand count it, nothing waits for the shop
  it('keeps out a request refused because the money went back by hand already', async () => {
    const late = await latePayment(deps());
    await refundAtStripe(late.paymentId, { amount: 2000 });
    await deliver(app, late.event);

    const all = await listOf(`orderId=${late.orderId}`);

    expect(all.items.map((one) => [one.purpose, one.state, one.failure])).toEqual(
      expect.arrayContaining([
        ['late_payment', 'failed', 'already_refunded'],
        ['late_payment', 'sent', null],
        ['hand', 'sent', null],
      ]),
    );
    expect((await listOf(`state=failed&orderId=${late.orderId}`)).items).toEqual([]);
  });
});

describe('the refunds in transit', () => {
  mockOnly('lists a refund of a late payment that is on its way, until its end comes', async () => {
    const late = await latePayment(deps());
    queueRefundOutcome({ status: 'pending' });
    await deliver(app, late.event);
    const refund = await refundOf(late.paymentId);

    const page = await listOf(`state=in_transit&orderId=${late.orderId}`);

    expect(page.items).toEqual([
      expect.objectContaining({
        purpose: 'late_payment',
        state: 'in_transit',
        refundId: refund.id,
        paymentId: late.paymentId,
        amount: 51,
        currency: 'eur',
        failure: null,
      }),
    ]);
    // it came to its state when it was asked
    expect(page.items[0]!.at).toBe(page.items[0]!.createdAt);
    expect((await listOf(`state=failed&orderId=${late.orderId}`)).items).toEqual([]);

    await deliverOk(
      app,
      refundEvent('refund.updated', {
        id: refund.id,
        paymentId: late.paymentId,
        status: 'succeeded',
      }),
    );
    expect((await listOf(`state=in_transit&orderId=${late.orderId}`)).items).toEqual([]);
  });

  mockOnly('moves a refund that failed from the ones in transit to the failed', async () => {
    const late = await latePayment(deps());
    queueRefundOutcome({ status: 'pending' });
    await deliver(app, late.event);
    const refund = await refundOf(late.paymentId);

    await deliverOk(
      app,
      refundEvent('refund.failed', {
        id: refund.id,
        paymentId: late.paymentId,
        status: 'failed',
        reason: 'insufficient_funds',
      }),
    );

    expect((await listOf(`state=in_transit&orderId=${late.orderId}`)).items).toEqual([]);
    expect((await listOf(`state=failed&orderId=${late.orderId}`)).items).toEqual([
      expect.objectContaining({ refundId: refund.id, failure: 'shop_balance' }),
    ]);
  });
});

describe('the refunds made by hand that wait for root', () => {
  // part of the payment of a sent order went back by hand: the refund made by hand is its own line,
  // nobody said what it was; root has it to explain
  it('lists one root has not said what it was for, with what it needs', async () => {
    const order = await placePaidOrder(app, csrf, buyer, product, {
      quantity: 2,
      stage: 'shipped',
    });
    const byHand = await refundAtStripe(order.paymentId, { amount: 500 });
    await deliver(app, await stripeEvent('refund.created', byHand.id));

    const page = await listOf(`state=unassigned&orderId=${order.orderId}`);

    expect(page.items).toEqual([
      expect.objectContaining({
        purpose: 'hand',
        state: 'sent',
        need: 'explain',
        refundId: byHand.id,
        amount: 5,
        byDashboard: true,
        returnId: null,
      }),
    ]);
    expect((await listOf(`state=unassigned&need=explain&orderId=${order.orderId}`)).total).toBe(1);
    expect((await listOf(`purpose=hand&orderId=${order.orderId}`)).total).toBe(1);
  });

  // part of a late payment went back by hand: the money of a payment the order could not take is no
  // money of its goods, nothing for root to say (the decision refuses it: api/payments/handRefunds)
  it('has no refund made by hand of a late payment among them', async () => {
    const late = await latePayment(deps());
    await refundAtStripe(late.paymentId, { amount: 2000 });
    await deliver(app, late.event);

    expect((await listOf(`state=unassigned&orderId=${late.orderId}`)).items).toEqual([]);
    expect((await listOf(`purpose=hand&orderId=${late.orderId}`)).total).toBe(1);
  });

  it('has no refunds of the app among them', async () => {
    const failed = await failedLateRefund(deps());

    expect((await listOf(`state=unassigned&orderId=${failed.orderId}`)).items).toEqual([]);
  });
});
