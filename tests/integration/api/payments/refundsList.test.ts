import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
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
} from '../../../helpers/stripe.js';

// GET /api/payments/refunds: the refunds that wait for the shop. failed: the transfers of the open
// statements of return that failed and the refunds of late payments that failed, until root records
// the money as sent another way; unsent: the refunds of late payments the provider has told neither
// sent nor failed. The oldest first, a page at a time. The alerts failed_refunds and
// refunded_payments_not_sent name it (api/admin/alertsLateRefunds.test.ts)

type Row = {
  id: string;
  source: string;
  orderId: number;
  userId: number;
  returnId: number | null;
  provider: string | null;
  paymentId: string | null;
  refundId: string | null;
  amount: number | null;
  currency: string | null;
  failure: string | null;
  failureText: string | null;
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

// a statement of an admin for a unit of a sent order of the buyer, the goods on the shelf, whose
// transfer failed
async function failedStatement() {
  const placed = await flows.shippedOrder(buyer, product, 1);
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
    ['no state', ''],
    ['a state that is none', 'state=paid'],
    ['an order that is none', 'state=failed&orderId=0'],
    ['a time that is none', 'state=failed&to=yesterday'],
    ['a limit past the largest', 'state=failed&limit=101'],
  ])('refuses %s', async (_name, query) => {
    const res = await get(`/api/payments/refunds?${query}`);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('refuses a cursor that is none', async () => {
    const res = await get('/api/payments/refunds?state=failed&cursor=abc');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });
});

describe('the refunds that failed', () => {
  it('lists a late payment whose refund failed, with what root needs to record it', async () => {
    const failed = await failedLateRefund(deps());

    const page = await listOf(`state=failed&orderId=${failed.orderId}`);

    expect(page).toEqual({
      items: [
        {
          id: failed.refundId,
          source: 'payment',
          orderId: failed.orderId,
          userId: failed.user.id,
          returnId: null,
          provider: 'stripe',
          paymentId: failed.paymentId,
          refundId: failed.refundId,
          amount: 51,
          currency: 'eur',
          failure: 'card_unavailable',
          failureText: 'expired_or_canceled_card',
          at: expect.any(String),
        },
      ],
      total: 1,
      limit: 20,
      nextCursor: null,
    });
  });

  it('lists a statement of return whose transfer failed, with the statement as the case', async () => {
    const failed = await failedStatement();

    const page = await listOf(`state=failed&orderId=${failed.orderId}`);

    expect(page.items).toEqual([
      {
        id: String(failed.returnId),
        source: 'return',
        orderId: failed.orderId,
        userId: buyer.id,
        returnId: failed.returnId,
        provider: null,
        paymentId: null,
        refundId: null,
        amount: 10,
        currency: 'eur',
        failure: 'card_unavailable',
        failureText: null,
        at: expect.any(String),
      },
    ]);
  });

  it('puts the oldest first, statements before payments of the same time, and pages by a cursor', async () => {
    const statement = await failedStatement();
    const late = await failedLateRefund(deps(), { name: 'Late Buyer' });
    const query = (extra = '') => `state=failed&userId=${late.user.id}${extra}`;

    // one buyer has both: the late payment above, a statement made for the same buyer by a flow
    const other = await flows.shippedOrder(late.user, product, 1);
    const card = await flows.adminStatement(other.orderId, other.itemId, 1);
    await flows.setGoods(card, 1, 'to_stock');
    await failReturnRefund(admin.id, card.id, 'shop_balance');

    const all = await listOf(query());
    expect(all.total).toBe(2);
    const times = all.items.map((row) => Date.parse(row.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));

    const first = await listOf(query('&limit=1'));
    expect(first.items).toHaveLength(1);
    expect(first.total).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listOf(query(`&limit=1&cursor=${first.nextCursor}`));
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect([first.items[0]!.id, second.items[0]!.id]).toEqual(all.items.map((row) => row.id));
    expect(statement.returnId).toBeGreaterThan(0);
  });

  it('keeps out a statement whose transfer went through at the second try', async () => {
    const failed = await failedStatement();
    await refundReturn(admin.id, failed.returnId);

    expect((await listOf(`state=failed&orderId=${failed.orderId}`)).items).toEqual([]);
  });

  it('keeps out a late payment whose refund was sent and one that is on its way', async () => {
    const sent = await latePayment(deps());
    await deliver(app, sent.event);

    expect((await listOf(`state=failed&orderId=${sent.orderId}`)).items).toEqual([]);
    expect((await listOf(`state=unsent&orderId=${sent.orderId}`)).items).toEqual([]);
  });

  it('keeps out a refund root has recorded as sent another way', async () => {
    const failed = await failedLateRefund(deps());
    const [row] = (await listOf(`state=failed&orderId=${failed.orderId}`)).items;
    const failedAt = Date.parse(row!.at);
    const marked = await app.inject({
      method: 'POST',
      url: `/api/payments/refunds/${failed.refundId}/outside`,
      headers: withCsrf(csrf, accessCookie(root)),
      payload: { method: 'cash', note: 'Handed over.', at: new Date(failedAt).toISOString() },
    });

    // the mark itself is tested in refundsOutside.test.ts: here only the list follows it
    expect(marked.statusCode).toBe(200);
    expect((await listOf(`state=failed&orderId=${failed.orderId}`)).items).toEqual([]);
  });

  it('narrows to the buyer, the order and the time', async () => {
    const failed = await failedLateRefund(deps());
    const [row] = (await listOf(`state=failed&orderId=${failed.orderId}`)).items;
    const at = Date.parse(row!.at);

    expect((await listOf(`state=failed&userId=${failed.user.id}`)).total).toBe(1);
    expect((await listOf(`state=failed&userId=${buyer.id}&orderId=${failed.orderId}`)).total).toBe(
      0,
    );
    const before = new Date(at - 1000).toISOString();
    const after = new Date(at + 1000).toISOString();
    expect((await listOf(`state=failed&orderId=${failed.orderId}&to=${before}`)).total).toBe(0);
    expect((await listOf(`state=failed&orderId=${failed.orderId}&to=${after}`)).total).toBe(1);
  });
});

describe('the refunds not told sent', () => {
  mockOnly(
    'lists a refund of a late payment that is on its way, with the time it was made',
    async () => {
      const late = await latePayment(deps());
      queueRefundOutcome({ status: 'pending' });
      await deliver(app, late.event);
      const refund = await refundOf(late.paymentId);

      const page = await listOf(`state=unsent&orderId=${late.orderId}`);

      expect(page.items).toEqual([
        expect.objectContaining({
          id: refund.id,
          source: 'payment',
          refundId: refund.id,
          paymentId: late.paymentId,
          amount: 51,
          currency: 'eur',
          failure: null,
          failureText: null,
        }),
      ]);
      // it is not among the failed ones
      expect((await listOf(`state=failed&orderId=${late.orderId}`)).items).toEqual([]);

      // its end comes: it is sent, and leaves the list
      await deliverOk(
        app,
        refundEvent('refund.updated', {
          id: refund.id,
          paymentId: late.paymentId,
          status: 'succeeded',
        }),
      );
      expect((await listOf(`state=unsent&orderId=${late.orderId}`)).items).toEqual([]);
    },
  );

  mockOnly('moves a refund that failed from the unsent to the failed', async () => {
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

    expect((await listOf(`state=unsent&orderId=${late.orderId}`)).items).toEqual([]);
    expect((await listOf(`state=failed&orderId=${late.orderId}`)).items).toEqual([
      expect.objectContaining({ refundId: refund.id, failure: 'shop_balance' }),
    ]);
  });

  it('has no statements: a statement is never unsent', async () => {
    const failed = await failedStatement();

    expect((await listOf(`state=unsent&orderId=${failed.orderId}`)).items).toEqual([]);
  });
});
