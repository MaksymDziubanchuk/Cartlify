import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { settleRefundsInTransit } from '@routes/api/payments/services/settleRefundsInTransit.service.js';

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
import { moneyOfPayment } from '../../../helpers/lateRefund.js';
import { watchMail, type SentMail } from '../../../helpers/mail.js';
import { giveMoneyRight } from '../../../helpers/moneyManager.js';
import { placePaidOrder } from '../../../helpers/payments.js';
import {
  closeOpenSessions,
  deliver,
  disputeEvent,
  openDispute,
  queueRefundOutcome,
  realStripe,
  refundsOf,
  withStripeOutOfReach,
} from '../../../helpers/stripe.js';

// POST /api/payments/compensations: root (or a money admin) gives the buyer of an order money by the
// button of the app: a refund of the app of the purpose compensation, at most
// what is left of the payment, not while a dispute of the payment is open; the buyer is mailed once
// it is sent, a failure is not mailed and waits for root to send it another way. The function of the
// database is db/compensation.test.ts

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let manager: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

const mockOnly = realStripe ? it.skip : it;

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
  app.inject({ method: 'POST', url, headers: withCsrf(csrf, accessCookie(actor)), payload });

const get = (url: string, actor: TestUser = admin) =>
  app.inject({ method: 'GET', url, headers: { cookie: accessCookie(actor) } });

const compensate = (body: Record<string, unknown>, actor: TestUser = root) =>
  post('/api/payments/compensations', body, actor);

const mailsTo = (mails: SentMail[], email: string, part = '') =>
  mails.filter((mail) => mail.to.includes(email) && mail.subject.includes(part));

const SENT = 'We sent you a compensation for order #';

// an order of two units at 10 (20 in all) that Stripe took the money for and the shop sent
async function sentOrder() {
  const buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(buyer.id);
  const product = await createProduct({ price: 10, stock: 10 });
  products.push(product);
  const placed = await placePaidOrder(app, csrf, buyer, product, { quantity: 2, stage: 'shipped' });
  return { ...placed, buyer };
}

const auditOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'order', entityId: orderId, event: 'payment.compensation' },
      select: { actorId: true, actorRole: true, meta: true },
    }),
  );

describe('a compensation of root', () => {
  it('goes to the buyer through the payment, the buyer is mailed, the journal of the admins keeps the note', async () => {
    const order = await sentOrder();
    const mails = watchMail();

    const res = await compensate({
      orderId: order.orderId,
      amount: 5,
      note: '  A gesture for the parcel that came late  ',
    });

    expect(res.statusCode).toBe(200);
    const refund = res.json();
    expect(refund).toMatchObject({
      purpose: 'compensation',
      state: 'sent',
      orderId: order.orderId,
      userId: order.buyer.id,
      returnId: null,
      amount: 5,
      need: null,
    });
    expect((await refundsOf(order.paymentId)).map((one) => one.amount)).toEqual([500]);
    const told = mailsTo(mails, order.buyer.email, SENT);
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toContain('We sent you €5.00 as a compensation for your order');
    expect(told[0]!.text).not.toContain('A gesture');
    expect(await auditOf(order.orderId)).toEqual([
      {
        actorId: root.id,
        actorRole: 'ROOT',
        meta: [
          { field: 'moneyLogId', old: null, new: refund.id },
          { field: 'amount', old: null, new: '5.00' },
          { field: 'note', old: null, new: 'A gesture for the parcel that came late' },
        ],
      },
    ]);
    const listed = await get(`/api/payments/refunds?purpose=compensation&orderId=${order.orderId}`);
    expect(listed.json().items).toEqual([
      expect.objectContaining({ id: refund.id, state: 'sent' }),
    ]);
  });

  it('is given by an admin root allowed to handle the money; an admin without the right and a buyer are refused', async () => {
    const order = await sentOrder();

    for (const actor of [admin, order.buyer]) {
      const res = await compensate({ orderId: order.orderId, amount: 1, note: 'x' }, actor);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        errorCode: actor === admin ? 'MONEY_MANAGER_REQUIRED' : 'INSUFFICIENT_ROLE',
      });
    }
    const byManager = await compensate(
      { orderId: order.orderId, amount: 1, note: 'A gesture' },
      manager,
    );
    expect(byManager.statusCode).toBe(200);
  });

  it('gives no more than is left of the payment (COMPENSATION_EXCEEDS_PAID)', async () => {
    const order = await sentOrder();
    expect(
      (await compensate({ orderId: order.orderId, amount: 15, note: 'A gesture' })).statusCode,
    ).toBe(200);

    const res = await compensate({ orderId: order.orderId, amount: 5.01, note: 'More' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'COMPENSATION_EXCEEDS_PAID' });
    expect(await refundsOf(order.paymentId)).toHaveLength(1);
  });

  mockOnly(
    'waits while a dispute of the payment is open at the bank (COMPENSATION_DISPUTED)',
    async () => {
      const order = await sentOrder();
      const disputeId = openDispute(order.paymentId);
      expect(
        (await deliver(app, await disputeEvent('charge.dispute.created', disputeId))).statusCode,
      ).toBe(200);

      const res = await compensate({ orderId: order.orderId, amount: 5, note: 'A gesture' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'COMPENSATION_DISPUTED' });
      expect(await refundsOf(order.paymentId)).toEqual([]);
    },
  );

  // a second press of the button, or two people at once: the money would go twice
  mockOnly(
    'gives none while another compensation of the order is on its way (COMPENSATION_IN_TRANSIT)',
    async () => {
      const order = await sentOrder();
      const first = await withStripeOutOfReach(() =>
        compensate({ orderId: order.orderId, amount: 5, note: 'A gesture' }),
      );
      expect(first.json()).toMatchObject({ state: 'in_transit' });

      const again = await compensate({ orderId: order.orderId, amount: 5, note: 'A gesture' });

      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ errorCode: 'COMPENSATION_IN_TRANSIT' });

      // once the first is sent, the next one goes
      await settleRefundsInTransit(
        { info: () => undefined, warn: () => undefined, error: () => undefined },
        { paymentId: order.paymentId, olderThanMs: 0 },
      );
      expect(
        (await compensate({ orderId: order.orderId, amount: 5, note: 'Another gesture' }))
          .statusCode,
      ).toBe(200);
      expect((await refundsOf(order.paymentId)).map((one) => one.amount)).toEqual([500, 500]);
    },
  );

  it('refuses an order with no payment (COMPENSATION_ORDER_INVALID) and a note of spaces only', async () => {
    const order = await sentOrder();

    const none = await compensate({ orderId: 2_147_483_000, amount: 5, note: 'A gesture' });
    const blank = await compensate({ orderId: order.orderId, amount: 5, note: '   ' });

    expect(none.statusCode).toBe(404);
    expect(none.json()).toMatchObject({ errorCode: 'COMPENSATION_ORDER_INVALID' });
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toMatchObject({ errorCode: 'COMPENSATION_NOTE_REQUIRED' });
  });

  it.each([
    { amount: 0, note: 'x' },
    { amount: -1, note: 'x' },
    { amount: 1.234, note: 'x' },
    { amount: 1 },
    { amount: 1, note: 'x'.repeat(501) },
    {},
  ])('refuses a body that is none: %j', async (body) => {
    const order = await sentOrder();

    const res = await compensate({ orderId: order.orderId, ...body });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

describe('what becomes of a compensation later', () => {
  // the card can no longer take the money: no mail, the failure waits
  // among the failed refunds, root sends it another way and the buyer is told how
  mockOnly('fails without a mail and waits for root, who sends it another way', async () => {
    const order = await sentOrder();
    queueRefundOutcome({ status: 'failed', reason: 'expired_or_canceled_card' });
    const mails = watchMail();

    const res = await compensate({ orderId: order.orderId, amount: 5, note: 'A gesture' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'failed', failure: 'card_unavailable' });
    expect(mailsTo(mails, order.buyer.email)).toEqual([]);
    const failed = (
      await get(`/api/payments/refunds?purpose=compensation&state=failed&orderId=${order.orderId}`)
    ).json().items;
    expect(failed).toEqual([expect.objectContaining({ id: res.json().id, state: 'failed' })]);

    const sent = await post(`/api/payments/refunds/${res.json().id}/outside`, {
      method: 'bank_transfer',
      note: 'To the account the buyer wrote by mail.',
      at: failed[0].at,
    });

    expect(sent.statusCode).toBe(200);
    expect(mailsTo(mails, order.buyer.email, 'We sent you money for order #')).toHaveLength(1);
    expect(
      (await moneyOfPayment(order.paymentId)).filter((line) => line.purpose === 'compensation'),
    ).toEqual([
      expect.objectContaining({ event: 'money.refund', amount: '-5.00' }),
      expect.objectContaining({ event: 'money.refund_failed', amount: '5.00' }),
      expect.objectContaining({ event: 'money.outside', amount: '-5.00' }),
    ]);
  });

  // Stripe did not answer: the line stays in transit, the worker asks again with the same key
  mockOnly(
    'is settled by the worker when Stripe did not answer, and the buyer is mailed then',
    async () => {
      const order = await sentOrder();
      const mails = watchMail();

      const res = await withStripeOutOfReach(() =>
        compensate({ orderId: order.orderId, amount: 5, note: 'A gesture' }),
      );

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: 'in_transit' });
      expect(mailsTo(mails, order.buyer.email)).toEqual([]);

      await settleRefundsInTransit(
        { info: () => undefined, warn: () => undefined, error: () => undefined },
        { paymentId: order.paymentId, olderThanMs: 0 },
      );

      expect((await refundsOf(order.paymentId)).map((one) => one.amount)).toEqual([500]);
      expect(mailsTo(mails, order.buyer.email, SENT)).toHaveLength(1);
    },
  );
});
