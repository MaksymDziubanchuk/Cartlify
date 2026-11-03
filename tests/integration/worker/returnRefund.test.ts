import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { settlePendingReturnRefunds } from '@routes/api/returns/services/settlePendingReturnRefunds.service.js';

import { accessCookie } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { asAdmin } from '../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { watchMail } from '../../helpers/mail.js';
import { placePaidOrder, placePaidOrderOf } from '../../helpers/payments.js';
import {
  queueRefundOutcome,
  realStripe,
  refundsOf,
  settleRefund,
  stripeOfTests,
  withStripeOutOfReach,
} from '../../helpers/stripe.js';

// the worker that settles the transfers of money back that stayed pending: the ones Stripe did not
// answer (no id yet: asked again with the same key, which gives the one refund) and the ones Stripe
// had not decided (asked where the refund stands). It leaves a transfer that is young, one Stripe
// still holds, and one it cannot reach now. Every run is limited to the statement of its test: the
// transfers of other test files are not its to settle

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(admin.id, buyer.id);
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

// a logger of the worker that keeps what it got
const workerLog = () => ({
  info: jest.fn<(obj: unknown, msg?: string) => void>(),
  warn: jest.fn<(obj: unknown, msg?: string) => void>(),
  error: jest.fn<(obj: unknown, msg?: string) => void>(),
});

const mockOnly = realStripe ? it.skip : it;

const post = (url: string, payload: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload,
  });

// a statement whose one unit is back on the shelf, for an order paid by a card
async function readyStatement() {
  const product = await createProduct({ price: 10, stock: 10 });
  products.push(product);
  const { orderId, paymentId } = await placePaidOrder(app, csrf, buyer, product, { quantity: 1 });
  const [item] = await asAdmin((tx) =>
    tx.orderItem.findMany({ where: { orderId }, select: { id: true } }),
  );
  const made = await post('/api/returns', {
    orderId,
    items: [{ orderItemId: item!.id, quantity: 1 }],
    basis: 'other',
    reason: 'defect',
  });
  const card = made.json();
  await post(`/api/returns/${card.id}/receive`, {
    results: [{ itemId: card.items[0].id, quantity: 1, goods: 'to_stock' }],
  });
  return { orderId, paymentId, returnId: card.id as number };
}

const rowsOf = (returnId: number) =>
  asAdmin((tx) =>
    tx.orderReturnItem.findMany({
      where: { returnId },
      select: { money: true, refundId: true, refundFailure: true },
    }),
  );

describe('the return refund worker', () => {
  it('asks Stripe again with the same key when it did not answer, and the one refund is made', async () => {
    const { returnId, paymentId } = await readyStatement();
    await withStripeOutOfReach(() => post(`/api/returns/${returnId}/refund`));
    expect(await rowsOf(returnId)).toEqual([
      expect.objectContaining({ money: 'pending', refundId: null }),
    ]);
    const log = workerLog();
    const mails = watchMail();

    const settled = await settlePendingReturnRefunds(log, { olderThanMs: 0, returnId });
    const again = await settlePendingReturnRefunds(log, { olderThanMs: 0, returnId });

    expect(settled).toBe(1);
    expect(again).toBe(0);
    expect(await rowsOf(returnId)).toEqual([
      expect.objectContaining({ money: 'refunded', refundId: expect.stringMatching(/^re_/) }),
    ]);
    expect(await refundsOf(paymentId)).toHaveLength(1);
    expect(mails.filter((mail) => mail.to.includes(buyer.email))).toHaveLength(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  mockOnly(
    'asks where a refund stands, leaves it while Stripe holds it, and settles it when it ends',
    async () => {
      const { orderId, returnId } = await readyStatement();
      queueRefundOutcome({ status: 'pending' });
      const res = await post(`/api/returns/${returnId}/refund`);
      const refundId: string = res.json().items[0].refundId;
      const log = workerLog();

      const held = await settlePendingReturnRefunds(log, { olderThanMs: 0, returnId });
      settleRefund(refundId, { status: 'succeeded' });
      const settled = await settlePendingReturnRefunds(log, { olderThanMs: 0, returnId });

      expect(held).toBe(0);
      expect(settled).toBe(1);
      expect(await rowsOf(returnId)).toEqual([
        expect.objectContaining({ money: 'refunded', refundId }),
      ]);
      // the worker acts for the system, as the buyer of the order
      const lines = await asAdmin((tx) =>
        tx.adminAuditLog.findMany({
          where: { entityType: 'order', entityId: orderId, event: 'return.refund' },
          select: { actorId: true, actorRole: true, meta: true },
        }),
      );
      expect(lines).toEqual([
        expect.objectContaining({
          actorId: buyer.id,
          actorRole: 'USER',
          meta: expect.arrayContaining([
            { field: 'refund', old: null, new: expect.objectContaining({ initiator: 'system' }) },
          ]),
        }),
      ]);
    },
  );

  mockOnly('settles a refund that failed after it was pending, with the reason', async () => {
    const { returnId } = await readyStatement();
    queueRefundOutcome({ status: 'pending' });
    const res = await post(`/api/returns/${returnId}/refund`);
    const refundId: string = res.json().items[0].refundId;
    settleRefund(refundId, { status: 'failed', reason: 'insufficient_funds' });

    const settled = await settlePendingReturnRefunds(workerLog(), { olderThanMs: 0, returnId });

    expect(settled).toBe(1);
    expect(await rowsOf(returnId)).toEqual([
      expect.objectContaining({
        money: 'not_refunded',
        refundId: null,
        refundFailure: 'shop_balance',
      }),
    ]);
  });

  mockOnly('leaves a transfer it cannot ask about now, and logs it', async () => {
    const { returnId } = await readyStatement();
    queueRefundOutcome({ status: 'pending' });
    await post(`/api/returns/${returnId}/refund`);
    const log = workerLog();

    const settled = await withStripeOutOfReach(() =>
      settlePendingReturnRefunds(log, { olderThanMs: 0, returnId }),
    );

    expect(settled).toBe(0);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(await rowsOf(returnId)).toEqual([expect.objectContaining({ money: 'pending' })]);
  });

  it('finds the refund Stripe made while the answer was lost, by the key it carries, and makes no second one', async () => {
    const { returnId, paymentId } = await readyStatement();
    await withStripeOutOfReach(() => post(`/api/returns/${returnId}/refund`));
    const [row] = await asAdmin((tx) =>
      tx.orderReturnItem.findMany({ where: { returnId }, select: { refundKey: true } }),
    );
    // the request had reached Stripe: the refund is there, with the key of the transfer
    const made = await stripeOfTests.refunds.create({
      payment_intent: paymentId,
      amount: 1000,
      metadata: { transfer: `refund:${row!.refundKey}` },
    });

    const settled = await settlePendingReturnRefunds(workerLog(), { olderThanMs: 0, returnId });

    expect(settled).toBe(1);
    expect(await rowsOf(returnId)).toEqual([
      expect.objectContaining({ money: 'refunded', refundId: made.id }),
    ]);
    expect(await refundsOf(paymentId)).toHaveLength(1);
  });

  it('does not ask again a transfer the provider has not answered for hours: it fails for a root to decide', async () => {
    const { returnId, paymentId } = await readyStatement();
    await withStripeOutOfReach(() => post(`/api/returns/${returnId}/refund`));
    const log = workerLog();

    const settled = await settlePendingReturnRefunds(log, {
      olderThanMs: 0,
      giveUpAfterMs: 0,
      returnId,
    });

    expect(settled).toBe(1);
    expect(await rowsOf(returnId)).toEqual([
      expect.objectContaining({ money: 'not_refunded', refundId: null, refundFailure: 'unknown' }),
    ]);
    // Stripe was not asked for a second refund
    expect(await refundsOf(paymentId)).toEqual([]);
  });

  it('logs a transfer that stays pending for long', async () => {
    const { returnId } = await readyStatement();
    await withStripeOutOfReach(() => post(`/api/returns/${returnId}/refund`));
    const log = workerLog();

    await withStripeOutOfReach(() =>
      settlePendingReturnRefunds(log, { olderThanMs: 0, warnAfterMs: 0, returnId }),
    );

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.any(String) }),
      'return refund is still pending',
    );
    expect(await rowsOf(returnId)).toEqual([expect.objectContaining({ money: 'pending' })]);
  });

  it('asks again for the whole transfer when a row of it changed since, once every row is old enough', async () => {
    const first = await createProduct({ price: 10, stock: 10 });
    const second = await createProduct({ price: 20, stock: 10 });
    products.push(first, second);
    const { orderId, paymentId } = await placePaidOrderOf(app, csrf, buyer, [
      { item: first, quantity: 1 },
      { item: second, quantity: 1 },
    ]);
    const items = await asAdmin((tx) =>
      tx.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' }, select: { id: true } }),
    );
    const made = (
      await post('/api/returns', {
        orderId,
        items: items.map((item) => ({ orderItemId: item.id, quantity: 1 })),
        basis: 'other',
        reason: 'defect',
      })
    ).json();
    // the money goes ahead of the goods, and Stripe does not answer
    await post(`/api/returns/${made.id}/proof/confirm`);
    await withStripeOutOfReach(() => post(`/api/returns/${made.id}/refund`));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    // the goods of one row come back meanwhile: that row changes, its transfer stays the same
    const received = await post(`/api/returns/${made.id}/receive`, {
      results: [{ itemId: made.items[0].id, quantity: 1, goods: 'to_stock' }],
    });
    expect(received.statusCode).toBe(200);

    const early = await settlePendingReturnRefunds(workerLog(), {
      olderThanMs: 1000,
      returnId: made.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const settled = await settlePendingReturnRefunds(workerLog(), {
      olderThanMs: 1000,
      returnId: made.id,
    });

    // the transfer is one: it is asked again for all of its money, never for a part
    expect(early).toBe(0);
    expect(settled).toBe(1);
    expect((await refundsOf(paymentId)).map((one) => one.amount)).toEqual([3000]);
    expect(await rowsOf(made.id)).toEqual([
      expect.objectContaining({ money: 'refunded' }),
      expect.objectContaining({ money: 'refunded' }),
    ]);
  });

  it('leaves a young transfer to the request that is waiting for Stripe', async () => {
    const { returnId } = await readyStatement();
    await withStripeOutOfReach(() => post(`/api/returns/${returnId}/refund`));

    const settled = await settlePendingReturnRefunds(workerLog(), { returnId });

    expect(settled).toBe(0);
    expect(await rowsOf(returnId)).toEqual([expect.objectContaining({ money: 'pending' })]);
  });
});
