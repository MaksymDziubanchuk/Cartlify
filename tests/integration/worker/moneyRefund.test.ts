import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

import appStripe from '@config/stripe.js';
import { followDisputes } from '@routes/api/payments/services/followDisputes.service.js';
import { settleRefundsInTransit } from '@routes/api/payments/services/settleRefundsInTransit.service.js';

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
import { latePayment, moneyOfPayment, moneyStepsOf } from '../../helpers/lateRefund.js';
import { takeLogs } from '../../helpers/logs.js';
import { watchMail } from '../../helpers/mail.js';
import { placePaidOrder, placePaidOrderOf } from '../../helpers/payments.js';
import {
  closeOpenSessions,
  deliver,
  disputeEvent,
  endDispute,
  openDispute,
  outOfReachDuring,
  PENDING_REFUND_CARD,
  refundBecomes,
  stripeWait,
  queueRefundOutcome,
  realStripe,
  refundsOf,
  settleRefund,
  stripeOfTests,
  withStripeOutOfReach,
} from '../../helpers/stripe.js';

// the worker of the refunds of the app that stayed in transit in the money journal: the transfers of
// the statements and the refunds of the late payments. One Stripe did not answer (no id yet) is
// looked for by its key among the refunds of the payment, and when there is none asked again with
// the same key and sum, which gives the one refund; one Stripe had not decided is asked where it
// stands. A silent refund stays in transit as long as it takes (never a failure the app makes up);
// one that is young, one Stripe still holds and one it cannot reach now are left. Every run is
// limited to the statement or the payment of its test: the refunds of other files are not its own

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];
const deps = () => ({ app, csrf, users: userIds, products });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(admin.id, buyer.id);
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
async function readyStatement(paymentCard?: string) {
  const product = await createProduct({ price: 10, stock: 10 });
  products.push(product);
  const { orderId, paymentId } = await placePaidOrder(app, csrf, buyer, product, {
    quantity: 1,
    ...(paymentCard ? { card: paymentCard } : {}),
  });
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
    parcel: { buyerPaid: 0 },
    results: [{ itemId: card.items[0].id, quantity: 1, goods: 'to_stock' }],
  });
  return { orderId, paymentId, returnId: card.id as number };
}

// the money of the rows of a statement and the line of the transfer that pays them
const rowsOf = (returnId: number) =>
  asAdmin(async (tx) => {
    const rows = await tx.orderReturnItem.findMany({
      where: { returnId },
      orderBy: { id: 'asc' },
      select: { money: true, moneyLogId: true },
    });
    const lines = await tx.moneyLog.findMany({
      where: { id: { in: rows.flatMap((row) => (row.moneyLogId ? [row.moneyLogId] : [])) } },
      select: {
        id: true,
        event: true,
        refundId: true,
        state: true,
        failure: true,
        transferKey: true,
      },
    });
    return rows.map((row) => ({
      money: row.money,
      line: lines.find((line) => line.id === row.moneyLogId) ?? null,
    }));
  });

describe('the transfers of the statements in transit', () => {
  it('asks Stripe again with the same key when it did not answer, and the one refund is made', async () => {
    const { returnId, paymentId } = await readyStatement();
    await withStripeOutOfReach(() => post(`/api/returns/${returnId}/refund`));
    expect(await rowsOf(returnId)).toEqual([
      expect.objectContaining({
        money: 'pending',
        line: expect.objectContaining({ state: 'in_transit', refundId: null }),
      }),
    ]);
    const log = workerLog();
    const mails = watchMail();

    const settled = await settleRefundsInTransit(log, { olderThanMs: 0, returnId });
    const again = await settleRefundsInTransit(log, { olderThanMs: 0, returnId });

    expect(settled).toBe(1);
    expect(again).toBe(0);
    expect(await rowsOf(returnId)).toEqual([
      expect.objectContaining({
        money: 'refunded',
        line: expect.objectContaining({ state: 'sent', refundId: expect.stringMatching(/^re_/) }),
      }),
    ]);
    expect(await refundsOf(paymentId)).toHaveLength(1);
    expect(mails.filter((mail) => mail.to.includes(buyer.email))).toHaveLength(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('asks where a refund stands and leaves it while Stripe holds it', async () => {
    const { returnId } = await readyStatement(PENDING_REFUND_CARD);
    await post(`/api/returns/${returnId}/refund`);
    const [before] = await rowsOf(returnId);

    const held = await settleRefundsInTransit(workerLog(), { olderThanMs: 0, returnId });

    expect(held).toBe(0);
    expect(await rowsOf(returnId)).toEqual([before]);
    expect(before).toMatchObject({
      money: 'pending',
      line: { state: 'in_transit', refundId: expect.stringMatching(/^re_/) },
    });
  });

  // the sandbox ends a refund of the pending card about two minutes later: the test waits for it;
  // the mock ends it at once
  it(
    'settles a pending refund when Stripe ends it, as the work of the system',
    async () => {
      const { orderId, returnId } = await readyStatement(PENDING_REFUND_CARD);
      await post(`/api/returns/${returnId}/refund`);
      const [row] = await rowsOf(returnId);
      await refundBecomes(row!.line!.refundId!, { status: 'succeeded' });

      const settled = await settleRefundsInTransit(workerLog(), { olderThanMs: 0, returnId });

      expect(settled).toBe(1);
      expect(await rowsOf(returnId)).toEqual([
        expect.objectContaining({
          money: 'refunded',
          line: expect.objectContaining({ state: 'sent', refundId: row!.line!.refundId }),
        }),
      ]);
      // the admin started it: one line of the journal of the admins; the worker writes none
      const lines = await asAdmin((tx) =>
        tx.adminAuditLog.findMany({
          where: { entityType: 'order', entityId: orderId, event: 'return.refund' },
          select: { actorId: true, actorRole: true },
        }),
      );
      expect(lines).toEqual([{ actorId: admin.id, actorRole: 'ADMIN' }]);
    },
    stripeWait,
  );

  mockOnly('settles a refund that failed after it was pending, with the reason', async () => {
    const { returnId } = await readyStatement();
    queueRefundOutcome({ status: 'pending' });
    await post(`/api/returns/${returnId}/refund`);
    const [row] = await rowsOf(returnId);
    settleRefund(row!.line!.refundId!, { status: 'failed', reason: 'insufficient_funds' });

    const settled = await settleRefundsInTransit(workerLog(), { olderThanMs: 0, returnId });

    expect(settled).toBe(1);
    expect(await rowsOf(returnId)).toEqual([
      expect.objectContaining({
        money: 'failed',
        line: expect.objectContaining({ event: 'money.refund_failed', failure: 'shop_balance' }),
      }),
    ]);
  });

  it('leaves a refund it cannot ask about now, and logs it', async () => {
    const { returnId } = await readyStatement(PENDING_REFUND_CARD);
    await post(`/api/returns/${returnId}/refund`);
    const log = workerLog();

    const settled = await withStripeOutOfReach(() =>
      settleRefundsInTransit(log, { olderThanMs: 0, returnId }),
    );

    expect(settled).toBe(0);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.stringMatching(/^refund:/) }),
      'refund check failed',
    );
    expect(await rowsOf(returnId)).toEqual([expect.objectContaining({ money: 'pending' })]);
  });

  it('finds the refund Stripe made while the answer was lost, by the key it carries, and makes no second one', async () => {
    const { returnId, paymentId } = await readyStatement();
    await withStripeOutOfReach(() => post(`/api/returns/${returnId}/refund`));
    const [row] = await rowsOf(returnId);
    // the request had reached Stripe: the refund is there, with the key of the transfer
    const made = await stripeOfTests.refunds.create({
      payment_intent: paymentId,
      amount: 1000,
      metadata: { transfer: row!.line!.transferKey! },
    });

    const settled = await settleRefundsInTransit(workerLog(), { olderThanMs: 0, returnId });

    expect(settled).toBe(1);
    expect(await rowsOf(returnId)).toEqual([
      expect.objectContaining({
        money: 'refunded',
        line: expect.objectContaining({ refundId: made.id, state: 'sent' }),
      }),
    ]);
    expect(await refundsOf(paymentId)).toHaveLength(1);
  });

  // a key Stripe forgot after a day is no reason to give up: the refund is looked for among the
  // refunds of the payment first, so asking again never makes a second one
  it('asks again a transfer Stripe has not answered for long, and logs it', async () => {
    const { returnId, paymentId } = await readyStatement();
    await withStripeOutOfReach(() => post(`/api/returns/${returnId}/refund`));
    const log = workerLog();

    const settled = await settleRefundsInTransit(log, {
      olderThanMs: 0,
      warnAfterMs: 0,
      returnId,
    });

    expect(settled).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.stringMatching(/^refund:/) }),
      'refund is still in transit',
    );
    expect(await rowsOf(returnId)).toEqual([expect.objectContaining({ money: 'refunded' })]);
    expect(await refundsOf(paymentId)).toHaveLength(1);
  });

  it('asks for all the parts of a transfer, its rows changed since or not', async () => {
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
    await post(`/api/returns/${made.id}/proof/confirm`, { buyerPaid: 0 });
    await withStripeOutOfReach(() => post(`/api/returns/${made.id}/refund`));
    // the goods of one row come back meanwhile: that row changes, its transfer stays the same
    const received = await post(`/api/returns/${made.id}/receive`, {
      parcel: { buyerPaid: 0 },
      results: [{ itemId: made.items[0].id, quantity: 1, goods: 'to_stock' }],
    });
    expect(received.statusCode).toBe(200);

    const settled = await settleRefundsInTransit(workerLog(), {
      olderThanMs: 0,
      returnId: made.id,
    });

    // the transfer is one: it is asked again for all of its money, never for a part
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

    const settled = await settleRefundsInTransit(workerLog(), { returnId });

    expect(settled).toBe(0);
    expect(await rowsOf(returnId)).toEqual([expect.objectContaining({ money: 'pending' })]);
  });
});

describe('the refunds of the late payments in transit', () => {
  it('asks Stripe again with the same key when it did not answer, and mails the buyer once', async () => {
    const late = await latePayment(deps());
    await withStripeOutOfReach(() => deliver(app, late.event));
    expect(await moneyStepsOf(late.paymentId)).toEqual([
      'money.late_payment',
      'money.refund:in_transit',
    ]);
    const mails = watchMail();
    const log = workerLog();

    const settled = await settleRefundsInTransit(log, {
      olderThanMs: 0,
      paymentId: late.paymentId,
    });
    const again = await settleRefundsInTransit(log, { olderThanMs: 0, paymentId: late.paymentId });

    expect(settled).toBe(1);
    expect(again).toBe(0);
    expect(await moneyStepsOf(late.paymentId)).toEqual(['money.late_payment', 'money.refund:sent']);
    expect((await moneyOfPayment(late.paymentId)).at(-1)).toMatchObject({
      refundId: expect.stringMatching(/^re_/),
      transferKey: `refund:${late.paymentId}`,
    });
    expect(await refundsOf(late.paymentId)).toHaveLength(1);
    expect(
      mails.filter(
        (mail) =>
          mail.to.includes(late.user.email) && mail.subject.includes('We sent your payment'),
      ),
    ).toHaveLength(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  mockOnly('settles a refund of a late payment Stripe ended meanwhile', async () => {
    const late = await latePayment(deps());
    queueRefundOutcome({ status: 'pending' });
    await deliver(app, late.event);
    const [refund] = await refundsOf(late.paymentId);
    settleRefund(refund!.id, { status: 'failed', reason: 'expired_or_canceled_card' });

    const settled = await settleRefundsInTransit(workerLog(), {
      olderThanMs: 0,
      paymentId: late.paymentId,
    });

    expect(settled).toBe(1);
    expect(await moneyStepsOf(late.paymentId)).toEqual([
      'money.late_payment',
      'money.refund:in_transit',
      'money.refund_failed',
    ]);
  });
});

// the disputes whose step did not finish when their event came: a dispute open without the draft of
// the evidence (Stripe could not take it), a dispute lost on an order not sent that is not cancelled
// yet, a dispute ended with a statement of the order whose money waits. The worker reads each from
// Stripe and takes the same step as the webhook; a dispute whose steps are done is not asked about
describe('the disputes whose steps are not done', () => {
  const disputeRow = (stripeId: string) =>
    asAdmin((tx) => tx.paymentDispute.findUniqueOrThrow({ where: { stripeId } }));

  mockOnly('puts the draft of the evidence Stripe could not take, once', async () => {
    const product = await createProduct({ price: 10, stock: 10 });
    products.push(product);
    const { orderId, paymentId } = await placePaidOrder(app, csrf, buyer, product, { quantity: 1 });
    const disputeId = openDispute(paymentId);
    outOfReachDuring(appStripe.disputes, 'update');
    await deliver(app, await disputeEvent('charge.dispute.created', disputeId));
    takeLogs({ msg: 'the draft of the evidence of a dispute was not put' });
    jest.restoreAllMocks();
    expect((await disputeRow(disputeId)).draftedAt).toBeNull();

    const followed = await followDisputes(workerLog(), { paymentId });
    const again = await followDisputes(workerLog(), { paymentId });

    expect(followed).toBe(1);
    expect(again).toBe(0);
    expect((await disputeRow(disputeId)).draftedAt).toEqual(expect.any(Date));
    expect(
      (await stripeOfTests.disputes.retrieve(disputeId)).evidence.product_description,
    ).toContain(`Order #${orderId}`);
  });

  mockOnly(
    'cancels an order not sent whose dispute was lost while its step did not run',
    async () => {
      const product = await createProduct({ price: 10, stock: 10 });
      products.push(product);
      const { orderId, paymentId } = await placePaidOrder(app, csrf, buyer, product, {
        quantity: 1,
      });
      const disputeId = openDispute(paymentId);
      await deliver(app, await disputeEvent('charge.dispute.created', disputeId));
      endDispute(disputeId, 'lost');
      // the state of the end is kept, as the webhook keeps it before its steps
      const dispute = await stripeOfTests.disputes.retrieve(disputeId);
      await asAdmin(
        (tx) => tx.$queryRaw`
        select cartlify.sync_payment_dispute(
          'stripe'::cartlify."PaymentProvider", ${disputeId}::text, ${paymentId}::text,
          'lost'::cartlify."DisputeStatus", ${dispute.reason}::text, null::timestamp, true, 0, false,
          (now() at time zone 'utc')::timestamp, null::timestamp,
          ${JSON.stringify(dispute.balance_transactions.map((one) => ({ id: one.id, amount: one.amount / 100, currency: one.currency })))}::jsonb
        ) as synced
      `,
      );
      const mails = watchMail();

      const followed = await followDisputes(workerLog(), { paymentId });
      const again = await followDisputes(workerLog(), { paymentId });

      expect(followed).toBe(1);
      expect(again).toBe(0);
      const statements = await asAdmin((tx) =>
        tx.orderReturn.findMany({ where: { orderId }, select: { source: true, reason: true } }),
      );
      expect(statements).toEqual([{ source: 'system', reason: 'dispute_lost' }]);
      expect(
        mails.filter(
          (mail) =>
            mail.to.includes(buyer.email) &&
            mail.subject.includes('after the decision of your bank'),
        ),
      ).toHaveLength(1);
    },
  );

  it('leaves a dispute whose steps are done', async () => {
    const product = await createProduct({ price: 10, stock: 10 });
    products.push(product);
    const { paymentId } = await placePaidOrder(app, csrf, buyer, product, { quantity: 1 });

    expect(await followDisputes(workerLog(), { paymentId })).toBe(0);
  });
});
