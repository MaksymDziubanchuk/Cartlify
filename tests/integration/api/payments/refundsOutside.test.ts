import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { asAdmin } from '../../../helpers/db.js';
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
  lateEventsOf,
  lateLinesOf,
  lockLateRefund,
  refundEvent,
  refundOf,
} from '../../../helpers/lateRefund.js';
import { watchMail, type SentMail } from '../../../helpers/mail.js';
import { loseReservation, placeOrder } from '../../../helpers/orders.js';
import { openPaymentPage, payPage } from '../../../helpers/payments.js';
import {
  closeOpenSessions,
  deliver,
  queueRefundOutcome,
  realStripe,
} from '../../../helpers/stripe.js';
import { whileLocked } from '../../../helpers/variants.js';

// POST /api/payments/refunds/:refundId/outside: root records that the money of a payment the order
// could not take, whose refund failed, went to the buyer another way. Only a refund that failed
// and is not marked yet; the refund is named by its id at Stripe, so an order with two late
// payments is not ambiguous. The line order.refund_late_outside is written once, the buyer is
// mailed once. The refund of a payment that failed is made through the mock (a refund that is
// still pending runs on the mock only)

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
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
  someone = await createUser();
  userIds.push(admin.id, root.id, someone.id);
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

const mark = (refundId: string, payload: Record<string, unknown>, actor: TestUser | null = root) =>
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

describe('who may record it', () => {
  it('lets root only: a visitor, a buyer and an admin are refused', async () => {
    const failed = await failedLateRefund(deps());

    for (const actor of [null, someone, admin, failed.user]) {
      const res = await mark(failed.refundId, await body(), actor);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    }

    expect(await lateEventsOf(failed.orderId)).not.toContain('order.refund_late_outside');
  });
});

describe('what it records', () => {
  it('writes the line once, mails the buyer and answers the refund as marked', async () => {
    const failed = await failedLateRefund(deps());
    const mails = watchMail();
    const note = 'Sent to the account the buyer wrote by mail.';
    const at = (await dbNow()).toISOString();

    const res = await mark(failed.refundId, await body({ method: 'bank_transfer', note, at }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      refundId: failed.refundId,
      orderId: failed.orderId,
      userId: failed.user.id,
      provider: 'stripe',
      paymentId: failed.paymentId,
      amount: 51,
      currency: 'eur',
      state: 'outside',
      failure: 'card_unavailable',
      failureText: 'expired_or_canceled_card',
      outside: { method: 'bank_transfer', note, at, by: root.id },
    });
    expect(await lateEventsOf(failed.orderId)).toEqual([
      'order.refund_late',
      'order.refund_late_sent',
      'order.refund_late_failed',
      'order.refund_late_outside',
    ]);
    const line = (await lateLinesOf(failed.orderId)).at(-1)!;
    expect(line).toMatchObject({
      actorId: root.id,
      actorRole: 'ROOT',
      entityType: 'order',
      entityId: failed.orderId,
      action: 'OTHER',
      meta: [
        {
          field: 'refund',
          old: null,
          new: {
            initiator: 'root',
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
    });
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

    expect((await mark(failed.refundId, await body({ method }))).statusCode).toBe(200);

    expect(mailsTo(mails, failed.user.email)[0]!.text).toContain(words);
  });

  it('mails in the language of the buyer', async () => {
    const failed = await failedLateRefund(deps(), { locale: 'es' });
    const mails = watchMail();

    expect((await mark(failed.refundId, await body())).statusCode).toBe(200);

    expect(mailsTo(mails, failed.user.email)[0]!.subject).toContain(
      `Te enviamos dinero del pedido #${failed.orderId}`,
    );
  });

  it('takes the refund out of the list of the failed ones', async () => {
    const failed = await failedLateRefund(deps());
    const list = () =>
      app.inject({
        method: 'GET',
        url: `/api/payments/refunds?state=failed&orderId=${failed.orderId}`,
        headers: { cookie: accessCookie(admin) },
      });
    expect((await list()).json().items.map((row: { id: string }) => row.id)).toEqual([
      failed.refundId,
    ]);

    await mark(failed.refundId, await body());

    expect((await list()).json()).toMatchObject({ items: [], total: 0 });
  });
});

describe('what it refuses', () => {
  it('answers 404 for a refund the app did not make', async () => {
    const res = await mark('re_made_by_hand_at_stripe', await body());

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'LATE_REFUND_NOT_FOUND' });
  });

  it('answers 409 for a refund whose money was sent', async () => {
    const late = await latePayment(deps());
    await deliver(app, late.event);
    const refund = await refundOf(late.paymentId);
    const mails = watchMail();

    const res = await mark(refund.id, await body());

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'LATE_REFUND_NOT_FAILED' });
    expect(await lateEventsOf(late.orderId)).not.toContain('order.refund_late_outside');
    expect(mailsTo(mails, late.user.email)).toEqual([]);
  });

  mockOnly('answers 409 for a refund that is still on its way', async () => {
    const late = await latePayment(deps());
    queueRefundOutcome({ status: 'pending' });
    await deliver(app, late.event);
    const refund = await refundOf(late.paymentId);

    const res = await mark(refund.id, await body());

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'LATE_REFUND_NOT_FAILED' });
  });

  it('answers 409 for a refund root has recorded already, and writes nothing again', async () => {
    const failed = await failedLateRefund(deps());
    expect((await mark(failed.refundId, await body())).statusCode).toBe(200);
    const mails = watchMail();

    const again = await mark(failed.refundId, await body({ method: 'cash' }));

    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ errorCode: 'LATE_REFUND_ALREADY_MARKED' });
    expect(
      (await lateEventsOf(failed.orderId)).filter((event) => event === 'order.refund_late_outside'),
    ).toHaveLength(1);
    expect(mailsTo(mails, failed.user.email)).toEqual([]);
  });

  it('records it once when two roots send the same mark at the same time', async () => {
    const failed = await failedLateRefund(deps());
    const mails = watchMail();
    const payload = await body();

    const answers = await whileLocked(
      (tx) => lockLateRefund(tx, failed.paymentId),
      () => Promise.all([mark(failed.refundId, payload), mark(failed.refundId, payload)]),
      { waiters: 2 },
    );

    expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    expect(answers.find((res) => res.statusCode === 409)!.json()).toMatchObject({
      errorCode: 'LATE_REFUND_ALREADY_MARKED',
    });
    expect(
      (await lateEventsOf(failed.orderId)).filter((event) => event === 'order.refund_late_outside'),
    ).toHaveLength(1);
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

    const res = await mark(failed.refundId, { ...(await body()), ...change });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(await lateEventsOf(failed.orderId)).not.toContain('order.refund_late_outside');
  });

  it('refuses a refund id that is no id at the provider', async () => {
    const res = await mark('re%20x', await body());

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('refuses a day of the future and a day before the refund was made', async () => {
    const failed = await failedLateRefund(deps());
    const [made] = await lateLinesOf(failed.orderId);

    const future = await mark(
      failed.refundId,
      await body({ at: new Date((await dbNow()).getTime() + 3_600_000).toISOString() }),
    );
    const before = await mark(
      failed.refundId,
      await body({ at: new Date(made!.createdAt.getTime() - 60_000).toISOString() }),
    );

    for (const res of [future, before]) {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'LATE_REFUND_OUTSIDE_AT_INVALID' });
    }
    expect(await lateEventsOf(failed.orderId)).not.toContain('order.refund_late_outside');
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

    const refunds: string[] = [];
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
      refunds.push(refund.id);
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
        .items.map((row: { id: string }) => row.id)
        .sort();
    expect(await waiting()).toEqual([...refunds].sort());
    const mails = watchMail();

    expect((await mark(refunds[1]!, await body())).statusCode).toBe(200);

    expect(await waiting()).toEqual([refunds[0]]);
    expect(mailsTo(mails, user.email, OUTSIDE_SUBJECT)).toHaveLength(1);
    expect(
      (await lateLinesOf(orderId)).filter((line) => line.event === 'order.refund_late_outside'),
    ).toHaveLength(1);
    // the other can be recorded on its own
    expect((await mark(refunds[0]!, await body())).statusCode).toBe(200);
    expect(await waiting()).toEqual([]);
  });
});
