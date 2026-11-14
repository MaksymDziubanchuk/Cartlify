import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { asAdmin } from '../../../helpers/db.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { giveMoneyRight } from '../../../helpers/moneyManager.js';
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
  lateRefundFailedAtStripe,
  latePayment,
  lockMoneyPayment,
  moneyOfPayment,
  refundEvent,
  refundOf,
} from '../../../helpers/lateRefund.js';
import { watchMail, type SentMail } from '../../../helpers/mail.js';
import { loseReservation, placeOrder } from '../../../helpers/orders.js';
import { openPaymentPage, payPage } from '../../../helpers/payments.js';
import {
  closeOpenSessions,
  deliver,
  disputeEvent,
  endDispute,
  openDispute,
  queueRefundOutcome,
  realStripe,
} from '../../../helpers/stripe.js';
import { whileLocked } from '../../../helpers/variants.js';

// POST /api/payments/refunds/:refundId/outside: root records that the money of a refund that failed,
// of a payment the order could not take, went to the buyer another way. The refund is named by its
// id in the list of the refunds (its first line in the money journal), so an order with two late
// payments is not ambiguous. Only a refund that failed and is not marked yet: the money journal gets
// one line money.outside that names it, the journal of the admins one line payment.refund_outside
// with both lines, the buyer is mailed once. The refund that failed is made through the mock (a
// refund that is still pending runs on the mock only)

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
// an admin root allowed to handle the money the way root does
let manager: TestUser;
let someone: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];
const deps = () => ({ app, csrf, users: userIds, products });

const mockOnly = realStripe ? it.skip : it;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  manager = await createUser({ role: 'ADMIN' });
  someone = await createUser();
  userIds.push(admin.id, root.id, someone.id, manager.id);
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

const mark = (
  refundId: number | string,
  payload: Record<string, unknown>,
  actor: TestUser | null = root,
) =>
  app.inject({
    method: 'POST',
    url: `/api/payments/refunds/${refundId}/outside`,
    headers: actor ? withCsrf(csrf, accessCookie(actor)) : withCsrf(csrf),
    payload,
  });

// the clock of the database dates the lines and judges the day of the money, so the day of a mark is
// taken from it: now by that clock is never of the future nor before a line already written
const dbNow = async () =>
  (
    await asAdmin((tx) => tx.$queryRaw<{ now: Date }[]>`select (now() at time zone 'UTC') as now`)
  )[0]!.now;

const body = async (overrides: Record<string, unknown> = {}) => ({
  method: 'bank_transfer',
  note: 'Sent to the account the buyer wrote by mail.',
  at: (await dbNow()).toISOString(),
  ...overrides,
});

const mailsTo = (mails: SentMail[], email: string, part = '') =>
  mails.filter((mail) => mail.to.includes(email) && mail.subject.includes(part));

const OUTSIDE_SUBJECT = 'We sent you money for order #';

// the first line of the refund of a late payment: the id of the refund in the list
const refundLineOf = async (paymentId: string) =>
  (await moneyOfPayment(paymentId)).find((line) => line.event === 'money.refund')!;

// the money of a payment sent outside the app
const outsideOf = async (paymentId: string) =>
  (await moneyOfPayment(paymentId)).filter((line) => line.event === 'money.outside');

// the bank opens a chargeback of the payment (the money leaves the shop) and Stripe tells of it
async function disputed(paymentId: string): Promise<string> {
  const disputeId = openDispute(paymentId);
  for (const type of ['charge.dispute.created', 'charge.dispute.funds_withdrawn']) {
    expect((await deliver(app, await disputeEvent(type, disputeId))).statusCode).toBe(200);
  }
  return disputeId;
}

// the bank ends it and Stripe tells of it: won puts the money back with the shop
async function ended(disputeId: string, end: 'won' | 'lost') {
  endDispute(disputeId, end);
  const types = [
    'charge.dispute.closed',
    ...(end === 'won' ? ['charge.dispute.funds_reinstated'] : []),
  ];
  for (const type of types) {
    expect((await deliver(app, await disputeEvent(type, disputeId))).statusCode).toBe(200);
  }
}

// the lines root wrote of the refunds of an order
const rootLinesOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'order', entityId: orderId, event: 'payment.refund_outside' },
      orderBy: { id: 'asc' },
    }),
  );

describe('who may record it', () => {
  it('lets root and an admin root allowed: a visitor, a buyer and an admin without the right are refused', async () => {
    const failed = await failedLateRefund(deps());
    const line = await refundLineOf(failed.paymentId);

    for (const actor of [null, someone, failed.user]) {
      const res = await mark(line.id, await body(), actor);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    }
    const byAdmin = await mark(line.id, await body(), admin);
    expect(byAdmin.statusCode).toBe(403);
    expect(byAdmin.json()).toMatchObject({ errorCode: 'MONEY_MANAGER_REQUIRED' });
    expect(await outsideOf(failed.paymentId)).toEqual([]);

    const byManager = await mark(line.id, await body(), manager);
    expect(byManager.statusCode).toBe(200);
    expect(byManager.json()).toMatchObject({ id: line.id, state: 'outside' });
    expect(await outsideOf(failed.paymentId)).toHaveLength(1);
  });
});

describe('what it records', () => {
  it('writes the money once in both journals, mails the buyer and answers the refund as outside', async () => {
    const failed = await failedLateRefund(deps());
    const line = await refundLineOf(failed.paymentId);
    const mails = watchMail();
    const note = 'Sent to the account the buyer wrote by mail.';
    const at = (await dbNow()).toISOString();

    const res = await mark(line.id, await body({ method: 'bank_transfer', note, at }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: line.id,
      purpose: 'late_payment',
      state: 'outside',
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
      // the payment went back another way: nothing of it is left at the provider
      paymentLeft: 0,
      // a late payment has no statement
      returnLeft: null,
      outside: { method: 'bank_transfer', note, at, by: root.id },
    });
    const [outside] = await outsideOf(failed.paymentId);
    expect(await outsideOf(failed.paymentId)).toHaveLength(1);
    expect(outside).toMatchObject({
      purpose: 'late_payment',
      part: 'whole',
      amount: '-51.00',
      coversId: line.id,
      actorId: root.id,
      method: 'bank_transfer',
      note,
      happenedAt: new Date(at),
    });
    expect(await rootLinesOf(failed.orderId)).toEqual([
      expect.objectContaining({
        actorId: root.id,
        actorRole: 'ROOT',
        entityType: 'order',
        entityId: failed.orderId,
        action: 'OTHER',
        meta: [
          { field: 'moneyLogIds', old: null, new: [line.id, outside!.id] },
          {
            field: 'refund',
            old: null,
            new: {
              purpose: 'late_payment',
              provider: 'stripe',
              paymentId: failed.paymentId,
              refundId: failed.refundId,
              amount: '51.00',
              currency: 'eur',
              method: 'bank_transfer',
              at,
            },
          },
          { field: 'note', old: null, new: note },
        ],
      }),
    ]);
    const told = mailsTo(mails, failed.user.email);
    expect(told.map((mail) => mail.subject)).toEqual([
      `Cartlify — ${OUTSIDE_SUBJECT}${failed.orderId}`,
    ]);
    expect(told[0]!.text).toContain('We sent you €51.00 for your order #');
    expect(told[0]!.text).toContain('We sent it by a bank transfer on ');
    // the note is for the shop
    expect(told[0]!.text).not.toContain(note);
  });

  it.each([
    ['cash', 'We sent it by cash on '],
    ['other', 'We sent it by another way on '],
  ])('names the way %s in the mail', async (method, words) => {
    const failed = await failedLateRefund(deps());
    const mails = watchMail();

    const line = await refundLineOf(failed.paymentId);
    expect((await mark(line.id, await body({ method }))).statusCode).toBe(200);

    expect(mailsTo(mails, failed.user.email)[0]!.text).toContain(words);
  });

  it('mails in the language of the buyer', async () => {
    const failed = await failedLateRefund(deps(), { locale: 'es' });
    const mails = watchMail();

    const line = await refundLineOf(failed.paymentId);
    expect((await mark(line.id, await body())).statusCode).toBe(200);

    expect(mailsTo(mails, failed.user.email)[0]!.subject).toContain(
      `Te enviamos dinero del pedido #${failed.orderId}`,
    );
  });
});

describe('what it refuses', () => {
  it('answers 404 for a line that is no refund of a late payment', async () => {
    const failed = await failedLateRefund(deps());
    const [late] = await moneyOfPayment(failed.paymentId);

    for (const id of [late!.id, 2147483647]) {
      const res = await mark(id, await body());
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'PAYMENT_REFUND_NOT_FOUND' });
    }
  });

  it('answers 409 for a refund whose money was sent', async () => {
    const late = await latePayment(deps());
    await deliver(app, late.event);
    const mails = watchMail();

    const res = await mark((await refundLineOf(late.paymentId)).id, await body());

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PAYMENT_REFUND_NOT_FAILED' });
    expect(await outsideOf(late.paymentId)).toEqual([]);
    expect(mailsTo(mails, late.user.email)).toEqual([]);
  });

  mockOnly('answers 409 for a refund that is still on its way', async () => {
    const late = await latePayment(deps());
    queueRefundOutcome({ status: 'pending' });
    await deliver(app, late.event);

    const res = await mark((await refundLineOf(late.paymentId)).id, await body());

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PAYMENT_REFUND_NOT_FAILED' });
  });

  it('answers 409 for a refund root has recorded already, and writes nothing again', async () => {
    const failed = await failedLateRefund(deps());
    const line = await refundLineOf(failed.paymentId);
    expect((await mark(line.id, await body())).statusCode).toBe(200);
    const mails = watchMail();

    const again = await mark(line.id, await body({ method: 'cash' }));

    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ errorCode: 'PAYMENT_REFUND_ALREADY_MARKED' });
    expect(await outsideOf(failed.paymentId)).toHaveLength(1);
    expect(await rootLinesOf(failed.orderId)).toHaveLength(1);
    expect(mailsTo(mails, failed.user.email)).toEqual([]);
  });

  // what the bank decides may give the buyer the money: root does not send it another way meanwhile
  // (the transfer of a statement is refused the same way, RETURN_REFUND_DISPUTED)
  mockOnly('answers 409 while a dispute of the payment is open at the bank', async () => {
    const failed = await failedLateRefund(deps());
    const line = await refundLineOf(failed.paymentId);
    await disputed(failed.paymentId);
    const mails = watchMail();

    const res = await mark(line.id, await body());

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PAYMENT_REFUND_DISPUTED' });
    expect(await outsideOf(failed.paymentId)).toEqual([]);
    expect(await rootLinesOf(failed.orderId)).toEqual([]);
    expect(mailsTo(mails, failed.user.email)).toEqual([]);
  });

  // lost: the bank gave the buyer the money of the payment; won: the money came back to the shop and
  // the app sent the payment back again. Either way the buyer has it, a mark would pay it twice
  mockOnly(
    'answers 409 once the money of the payment went back to the buyer after the dispute',
    async () => {
      for (const end of ['lost', 'won'] as const) {
        const failed = await lateRefundFailedAtStripe(deps());
        const line = await refundLineOf(failed.paymentId);
        await ended(await disputed(failed.paymentId), end);

        const res = await mark(line.id, await body());

        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ errorCode: 'PAYMENT_REFUND_NOT_FAILED' });
        expect(await outsideOf(failed.paymentId)).toEqual([]);
      }
    },
  );

  it('records it once when two roots send the same mark at the same time', async () => {
    const failed = await failedLateRefund(deps());
    const line = await refundLineOf(failed.paymentId);
    const mails = watchMail();
    const payload = await body();

    const answers = await whileLocked(
      (tx) => lockMoneyPayment(tx, failed.paymentId),
      () => Promise.all([mark(line.id, payload), mark(line.id, payload)]),
      { waiters: 2 },
    );

    expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    expect(answers.find((res) => res.statusCode === 409)!.json()).toMatchObject({
      errorCode: 'PAYMENT_REFUND_ALREADY_MARKED',
    });
    expect(await outsideOf(failed.paymentId)).toHaveLength(1);
    expect(await rootLinesOf(failed.orderId)).toHaveLength(1);
    expect(mailsTo(mails, failed.user.email, OUTSIDE_SUBJECT)).toHaveLength(1);
  });

  it.each([
    ['no way', { method: undefined }],
    ['a way that is not a way to send money', { method: 'chargeback' }],
    ['no note', { note: undefined }],
    ['an empty note', { note: '' }],
    ['a note too long', { note: 'x'.repeat(501) }],
    ['no day', { at: undefined }],
    ['a day that is none', { at: 'yesterday' }],
  ])('refuses %s', async (_name, change) => {
    const failed = await failedLateRefund(deps());
    const line = await refundLineOf(failed.paymentId);

    const res = await mark(line.id, { ...(await body()), ...change });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(await outsideOf(failed.paymentId)).toEqual([]);
  });

  it('refuses a note of spaces only', async () => {
    const failed = await failedLateRefund(deps());
    const line = await refundLineOf(failed.paymentId);

    const res = await mark(line.id, await body({ note: '   ' }));

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PAYMENT_REFUND_OUTSIDE_NOTE_REQUIRED' });
  });

  it.each(['re_3QxYz', '0', '2147483648'])('refuses a refund id %p that is none', async (id) => {
    const res = await mark(id, await body());

    expect(res.statusCode).toBe(400);
    expect(['VALIDATION_ERROR', 'INVALID_ID_PARAM']).toContain(res.json().errorCode);
  });

  it('refuses a day of the future and a day before the refund was asked', async () => {
    const failed = await failedLateRefund(deps());
    const line = await refundLineOf(failed.paymentId);
    const [asked] = await asAdmin((tx) =>
      tx.moneyLog.findMany({ where: { id: line.id }, select: { createdAt: true } }),
    );

    const future = await mark(
      line.id,
      await body({ at: new Date((await dbNow()).getTime() + 3_600_000).toISOString() }),
    );
    const before = await mark(
      line.id,
      await body({ at: new Date(asked!.createdAt.getTime() - 60_000).toISOString() }),
    );

    for (const res of [future, before]) {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'PAYMENT_REFUND_OUTSIDE_AT_INVALID' });
    }
    expect(await outsideOf(failed.paymentId)).toEqual([]);
  });
});

describe('an order with two late payments', () => {
  const confirmAgain = (user: TestUser, orderId: number) =>
    app.inject({
      method: 'POST',
      url: '/api/orders/current/confirm',
      headers: withCsrf(csrf, accessCookie(user)),
      payload: { orderId, expectedDeliveryPrice: 0 },
    });

  // three pages of the order, one for each confirmation: the third is paid and the order goes out,
  // then the first two are paid after it
  it('names the refund, so marking one leaves the other', async () => {
    const user = await createUser();
    userIds.push(user.id);
    const product = await createProduct({ price: 25.5, stock: 5 });
    products.push(product);
    const orderId = await placeOrder(app, csrf, user, product, 'waiting', 2);
    const first = await openPaymentPage(app, csrf, user, orderId);
    await loseReservation(orderId);
    expect((await confirmAgain(user, orderId)).statusCode).toBe(200);
    const second = await openPaymentPage(app, csrf, user, orderId);
    await loseReservation(orderId);
    expect((await confirmAgain(user, orderId)).statusCode).toBe(200);
    const third = await openPaymentPage(app, csrf, user, orderId);
    await deliverOk(app, (await payPage(third)).event);

    const refunds: number[] = [];
    for (const page of [first, second]) {
      const late = await payPage(page);
      await deliverOk(app, late.event);
      const refund = await refundOf(late.paymentId);
      await deliverOk(
        app,
        refundEvent('refund.failed', {
          id: refund.id,
          paymentId: late.paymentId,
          status: 'failed',
          reason: 'expired_or_canceled_card',
        }),
      );
      refunds.push((await refundLineOf(late.paymentId)).id);
    }
    const waiting = async () =>
      (
        await app.inject({
          method: 'GET',
          url: `/api/payments/refunds?state=failed&orderId=${orderId}`,
          headers: { cookie: accessCookie(admin) },
        })
      )
        .json()
        .items.map((row: { id: number }) => row.id)
        .sort((a: number, b: number) => a - b);
    expect(await waiting()).toEqual([...refunds].sort((a, b) => a - b));
    const mails = watchMail();

    expect((await mark(refunds[1]!, await body())).statusCode).toBe(200);

    expect(await waiting()).toEqual([refunds[0]]);
    expect(mailsTo(mails, user.email, OUTSIDE_SUBJECT)).toHaveLength(1);
    expect(await rootLinesOf(orderId)).toHaveLength(1);
    // the other can be recorded on its own
    expect((await mark(refunds[0]!, await body())).statusCode).toBe(200);
    expect(await waiting()).toEqual([]);
  });
});
