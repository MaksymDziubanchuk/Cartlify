import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { stripeProvider } from '@routes/api/payments/providers/stripe/stripe.provider.js';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import { closeSessions, removeProducts, type TestProduct } from '../../../helpers/factories.js';
import {
  deliverOk,
  LATE_REFUND_AMOUNT,
  latePayment,
  lockMoneyPayment,
  moneyOfPayment,
  moneyStepsOf,
  refundEvent,
  refundOf,
} from '../../../helpers/lateRefund.js';
import { takeLogs } from '../../../helpers/logs.js';
import { watchMail, type SentMail } from '../../../helpers/mail.js';
import {
  closeOpenSessions,
  deliver,
  queueRefundOutcome,
  realStripe,
  refundAtStripe,
  refundBecomes,
  refundsOf,
  stripeEvent,
} from '../../../helpers/stripe.js';
import { whileLocked } from '../../../helpers/variants.js';

// The refund of a payment the order could not take, in the money journal (db/05, money_log): the
// late payment came (+), the refund goes out in transit (-) before Stripe is asked, under the key
// refund:<payment>; Stripe made it (its id), told it sent (the state, with the mail to the buyer),
// or it failed (a new line with the sum back, with the mail). The buyer is mailed once for each,
// whatever the number of the deliveries of the events, also when two come at the same time. Money
// given back by hand in the dashboard meanwhile is not sent twice. Stripe is the mock; a refund
// that is pending or fails runs on the mock only (the sandbox gives a card refund that succeeds)

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];
const products: TestProduct[] = [];
const deps = () => ({ app, csrf, users: userIds, products });

// the tests of a refund that is pending need the mock to make one
const mockOnly = realStripe ? it.skip : it;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
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

const mailsTo = (mails: SentMail[], email: string, part = '') =>
  mails.filter((mail) => mail.to.includes(email) && mail.subject.includes(part));

const SENT_SUBJECT = 'We sent your payment for order #';
const FAILED_SUBJECT = 'We could not send your payment back for order #';

// the line of the refund of the payment
const refundLineOf = async (paymentId: string) =>
  (await moneyOfPayment(paymentId)).find((line) => line.event === 'money.refund')!;

describe('the money of a late payment is sent', () => {
  it('writes the late payment and the refund sent, and mails the buyer, when Stripe answers that the refund succeeded', async () => {
    const late = await latePayment(deps());
    const mails = watchMail();

    const res = await deliver(app, late.event);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    const refund = await refundOf(late.paymentId);
    expect(refund).toMatchObject({ status: 'succeeded', amount: 5100 });
    expect(await moneyOfPayment(late.paymentId)).toEqual([
      expect.objectContaining({
        event: 'money.late_payment',
        purpose: 'late_payment',
        part: 'whole',
        amount: LATE_REFUND_AMOUNT,
        currency: 'eur',
        orderId: late.orderId,
        userId: late.user.id,
        // the work of the system, nobody signed in did it
        actorId: null,
        meta: expect.arrayContaining([{ field: 'reason', new: 'OUT_OF_STOCK' }]),
      }),
      expect.objectContaining({
        event: 'money.refund',
        purpose: 'late_payment',
        part: 'whole',
        amount: `-${LATE_REFUND_AMOUNT}`,
        orderId: late.orderId,
        userId: late.user.id,
        actorId: null,
        state: 'sent',
        refundId: refund.id,
        transferKey: `refund:${late.paymentId}`,
        byDashboard: false,
      }),
    ]);
    const told = mailsTo(mails, late.user.email);
    expect(told.map((mail) => mail.subject)).toEqual([
      `Cartlify — ${SENT_SUBJECT}${late.orderId} back`,
    ]);
    expect(told[0]!.text).toContain('We sent your payment of €51.00');
  });

  // the worker asks Stripe again when it must, never a delivery of the event
  it('acknowledges the event of the page again without a second refund, line or mail', async () => {
    const late = await latePayment(deps());
    const mails = watchMail();

    await deliver(app, late.event);
    const again = await deliver(app, late.event);

    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ received: true, skipped: 'REFUNDED' });
    expect(await refundsOf(late.paymentId)).toHaveLength(1);
    expect(await moneyStepsOf(late.paymentId)).toEqual(['money.late_payment', 'money.refund:sent']);
    expect(mailsTo(mails, late.user.email)).toHaveLength(1);
  });

  mockOnly(
    'keeps the refund in transit with its id and mails nothing while it is pending',
    async () => {
      const late = await latePayment(deps());
      queueRefundOutcome({ status: 'pending' });
      const mails = watchMail();

      expect((await deliver(app, late.event)).statusCode).toBe(200);

      const refund = await refundOf(late.paymentId);
      expect(refund).toMatchObject({ status: 'pending' });
      expect(await moneyStepsOf(late.paymentId)).toEqual([
        'money.late_payment',
        'money.refund:in_transit',
      ]);
      expect(await refundLineOf(late.paymentId)).toMatchObject({ refundId: refund.id });
      expect(mailsTo(mails, late.user.email)).toEqual([]);
    },
  );

  // the event Stripe records when a pending refund ends is the one the webhook gets
  mockOnly('sends once, when the event says that the pending refund succeeded', async () => {
    const late = await latePayment(deps());
    queueRefundOutcome({ status: 'pending' });
    await deliver(app, late.event);
    const refund = await refundOf(late.paymentId);
    const mails = watchMail();

    await refundBecomes(refund.id, { status: 'succeeded' });
    const event = await stripeEvent('refund.updated', refund.id);
    expect((await deliver(app, event)).statusCode).toBe(200);
    expect((await deliver(app, event)).statusCode).toBe(200);

    expect(await moneyStepsOf(late.paymentId)).toEqual(['money.late_payment', 'money.refund:sent']);
    expect(mailsTo(mails, late.user.email, SENT_SUBJECT)).toHaveLength(1);
  });

  // the request made the refund and its answer was lost: the line knows no refund yet, the event
  // of the creation finds it by the key in the metadata and gives it the id
  mockOnly('takes the id of the refund from the event of its creation', async () => {
    const late = await latePayment(deps());
    queueRefundOutcome({ status: 'pending' });
    const ask = stripeProvider.refundPayment.bind(stripeProvider);
    jest.spyOn(stripeProvider, 'refundPayment').mockImplementation(async (args) => {
      await ask(args);
      return { refundId: null, status: 'pending', bankReference: null };
    });
    await deliver(app, late.event);
    expect(await refundLineOf(late.paymentId)).toMatchObject({
      state: 'in_transit',
      refundId: null,
    });
    const refund = await refundOf(late.paymentId);
    const mails = watchMail();

    const res = await deliver(
      app,
      refundEvent('refund.created', {
        id: refund.id,
        paymentId: late.paymentId,
        status: 'pending',
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(await refundLineOf(late.paymentId)).toMatchObject({
      state: 'in_transit',
      refundId: refund.id,
    });
    expect(mailsTo(mails, late.user.email)).toEqual([]);
  });

  it('refunds once, writes each line once and mails once when the event of the page comes twice at the same time', async () => {
    const late = await latePayment(deps());
    const mails = watchMail();

    const answers = await whileLocked(
      (tx) => lockMoneyPayment(tx, late.paymentId),
      () => Promise.all([deliver(app, late.event), deliver(app, late.event)]),
      { waiters: 2 },
    );

    expect(answers.map((res) => res.statusCode)).toEqual([200, 200]);
    expect(await refundsOf(late.paymentId)).toHaveLength(1);
    expect(await moneyStepsOf(late.paymentId)).toEqual(['money.late_payment', 'money.refund:sent']);
    expect(mailsTo(mails, late.user.email)).toHaveLength(1);
  });

  // an admin gave the money back in the Stripe dashboard before the event came: Stripe refuses our
  // request, the refund made by hand is the one of the line, and the buyer has the money
  it('takes the refund made by hand for all of the payment as the one of the line', async () => {
    const late = await latePayment(deps());
    const byHand = await refundAtStripe(late.paymentId);
    const mails = watchMail();

    expect((await deliver(app, late.event)).statusCode).toBe(200);

    expect(await refundsOf(late.paymentId)).toHaveLength(1);
    expect(await moneyOfPayment(late.paymentId)).toEqual([
      expect.objectContaining({ event: 'money.late_payment', amount: LATE_REFUND_AMOUNT }),
      expect.objectContaining({
        event: 'money.refund',
        purpose: 'late_payment',
        amount: `-${LATE_REFUND_AMOUNT}`,
        state: 'sent',
        refundId: byHand.id,
        byDashboard: true,
      }),
    ]);
    expect(mailsTo(mails, late.user.email, SENT_SUBJECT)).toHaveLength(1);
  });

  // part of the payment went back by hand: the money is not sent twice; the refund made by hand is
  // a line of its own, the request for all of the payment fails as given back already, and the app
  // sends what is left under a key of its own
  it('sends only what is left when part of the payment went back by hand', async () => {
    const late = await latePayment(deps());
    const byHand = await refundAtStripe(late.paymentId, { amount: 2000 });
    const mails = watchMail();

    expect((await deliver(app, late.event)).statusCode).toBe(200);

    const refunds = await refundsOf(late.paymentId);
    expect(refunds.map((one) => one.amount).sort((a, b) => a - b)).toEqual([2000, 3100]);
    const rest = refunds.find((one) => one.id !== byHand.id)!;
    const lines = await moneyOfPayment(late.paymentId);
    const first = lines.find((line) => line.transferKey === `refund:${late.paymentId}`)!;
    expect(lines).toEqual([
      expect.objectContaining({ event: 'money.late_payment', amount: '51.00' }),
      first,
      expect.objectContaining({
        event: 'money.refund',
        purpose: 'hand',
        amount: '-20.00',
        refundId: byHand.id,
        byDashboard: true,
      }),
      expect.objectContaining({
        event: 'money.refund_failed',
        purpose: 'late_payment',
        amount: '51.00',
        coversId: first.id,
        failure: 'already_refunded',
      }),
      expect.objectContaining({
        event: 'money.refund',
        purpose: 'late_payment',
        amount: '-31.00',
        state: 'sent',
        refundId: rest.id,
        transferKey: `refund:${late.paymentId}:3100`,
      }),
    ]);
    expect(first).toMatchObject({ amount: '-51.00', refundId: null });
    // the money the app sent; the buyer has all of the payment back
    const told = mailsTo(mails, late.user.email, SENT_SUBJECT);
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toContain('€31.00');
  });
});

describe('the refund of a late payment fails', () => {
  mockOnly(
    'writes the failure and mails the buyer, once, when the pending refund fails',
    async () => {
      const late = await latePayment(deps());
      queueRefundOutcome({ status: 'pending' });
      await deliver(app, late.event);
      const refund = await refundOf(late.paymentId);
      const mails = watchMail();
      const reason = 'expired_or_canceled_card';

      // Stripe tells a failure twice: refund.failed and refund.updated with the failed status
      const failedEvent = refundEvent('refund.failed', {
        id: refund.id,
        paymentId: late.paymentId,
        status: 'failed',
        reason,
      });
      const updatedEvent = refundEvent('refund.updated', {
        id: refund.id,
        paymentId: late.paymentId,
        status: 'failed',
        reason,
      });
      expect((await deliver(app, failedEvent)).statusCode).toBe(200);
      expect((await deliver(app, updatedEvent)).statusCode).toBe(200);
      expect((await deliver(app, failedEvent)).statusCode).toBe(200);

      expect(await moneyStepsOf(late.paymentId)).toEqual([
        'money.late_payment',
        'money.refund:in_transit',
        'money.refund_failed',
      ]);
      const refundLine = await refundLineOf(late.paymentId);
      expect((await moneyOfPayment(late.paymentId)).at(-1)).toMatchObject({
        purpose: 'late_payment',
        amount: LATE_REFUND_AMOUNT,
        coversId: refundLine.id,
        refundId: refund.id,
        failure: 'card_unavailable',
        failureText: reason,
        actorId: null,
      });
      const told = mailsTo(mails, late.user.email);
      expect(told.map((mail) => mail.subject)).toEqual([
        `Cartlify — ${FAILED_SUBJECT}${late.orderId}`,
      ]);
      expect(told[0]!.text).toContain('the card can no longer take money');
      expect(told[0]!.text).not.toContain(reason);
      expect(told[0]!.text).not.toContain('sent back to us by your bank');
    },
  );

  mockOnly(
    'writes the failure and mails the buyer, once, when the refund fails at once',
    async () => {
      const late = await latePayment(deps());
      const mails = watchMail();
      queueRefundOutcome({ status: 'failed', reason: 'expired_or_canceled_card' });

      // Stripe made the refund and it failed in the same answer: the event of the page is taken
      expect((await deliver(app, late.event)).statusCode).toBe(200);
      expect((await deliver(app, late.event)).statusCode).toBe(200);

      expect(await moneyStepsOf(late.paymentId)).toEqual([
        'money.late_payment',
        'money.refund:in_transit',
        'money.refund_failed',
      ]);
      expect((await moneyOfPayment(late.paymentId)).at(-1)).toMatchObject({
        failure: 'card_unavailable',
        failureText: 'expired_or_canceled_card',
      });
      const told = mailsTo(mails, late.user.email);
      expect(told.map((mail) => mail.subject)).toEqual([
        `Cartlify — ${FAILED_SUBJECT}${late.orderId}`,
      ]);
    },
  );

  // Stripe refused the request itself and made no refund: the money did not leave the shop, so
  // the refund that went out in transit comes back with the reason, for root to send another way
  it('writes a refusal of Stripe without a refund as a failure of the line', async () => {
    const late = await latePayment(deps());
    jest.spyOn(stripeProvider, 'refundPayment').mockResolvedValue({
      refundId: null,
      status: 'failed',
      failure: 'unknown',
      failureText: 'The payment cannot be refunded.',
      bankReference: null,
    });
    const mails = watchMail();

    expect((await deliver(app, late.event)).statusCode).toBe(200);

    expect(await moneyStepsOf(late.paymentId)).toEqual([
      'money.late_payment',
      'money.refund:in_transit',
      'money.refund_failed',
    ]);
    expect((await moneyOfPayment(late.paymentId)).at(-1)).toMatchObject({
      amount: LATE_REFUND_AMOUNT,
      refundId: null,
      failure: 'unknown',
      failureText: 'The payment cannot be refunded.',
    });
    expect(mailsTo(mails, late.user.email, FAILED_SUBJECT)).toHaveLength(1);
  });

  it('fails the refund that succeeded before: the bank sent the money back', async () => {
    const late = await latePayment(deps());
    await deliver(app, late.event);
    const refund = await refundOf(late.paymentId);
    const mails = watchMail();

    const event = refundEvent('refund.failed', {
      id: refund.id,
      paymentId: late.paymentId,
      status: 'failed',
      reason: 'expired_or_canceled_card',
    });
    expect((await deliver(app, event)).statusCode).toBe(200);
    expect((await deliver(app, event)).statusCode).toBe(200);

    // the line stays as it was told: sent; the failure is a new line
    expect(await moneyStepsOf(late.paymentId)).toEqual([
      'money.late_payment',
      'money.refund:sent',
      'money.refund_failed',
    ]);
    const told = mailsTo(mails, late.user.email, FAILED_SUBJECT);
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toContain('The money we sent earlier was sent back to us by your bank');
    expect(told[0]!.text).toContain('We will contact you about another way to send it.');
  });

  // our word for the reason, the words of Stripe in the line and not in the mail; a reason that is
  // not about the card of the buyer is told in general words
  it.each([
    ['expired_or_canceled_card', 'card_unavailable', true],
    ['lost_or_stolen_card', 'card_unavailable', true],
    ['insufficient_funds', 'shop_balance', false],
    ['declined', 'unknown', false],
  ])('puts the reason %s down as %s', async (reason, failure, aboutTheCard) => {
    const late = await latePayment(deps());
    await deliver(app, late.event);
    const refund = await refundOf(late.paymentId);
    const mails = watchMail();

    await deliverOk(
      app,
      refundEvent('refund.updated', {
        id: refund.id,
        paymentId: late.paymentId,
        status: 'failed',
        reason,
      }),
    );

    expect((await moneyOfPayment(late.paymentId)).at(-1)).toMatchObject({
      event: 'money.refund_failed',
      failure,
      failureText: reason,
    });
    const [mail] = mailsTo(mails, late.user.email, FAILED_SUBJECT);
    expect(mail!.text.includes('the card can no longer take money')).toBe(aboutTheCard);
    expect(mail!.text).not.toContain(reason);
  });

  // the bank settles a disputed payment: the failure is written for the dispute to follow, and the
  // buyer is not told that the shop cannot send the money
  it('writes a failure the dispute of the bank caused and mails nothing', async () => {
    const late = await latePayment(deps());
    await deliver(app, late.event);
    const refund = await refundOf(late.paymentId);
    const mails = watchMail();

    await deliverOk(
      app,
      refundEvent('refund.updated', {
        id: refund.id,
        paymentId: late.paymentId,
        status: 'failed',
        reason: 'charge_for_pending_refund_disputed',
      }),
    );

    expect((await moneyOfPayment(late.paymentId)).at(-1)).toMatchObject({
      event: 'money.refund_failed',
      failure: 'disputed',
    });
    expect(mailsTo(mails, late.user.email)).toEqual([]);
  });

  it('fails the refund that was cancelled, the same way', async () => {
    const late = await latePayment(deps());
    await deliver(app, late.event);
    const refund = await refundOf(late.paymentId);

    await deliverOk(
      app,
      refundEvent('refund.updated', {
        id: refund.id,
        paymentId: late.paymentId,
        status: 'canceled',
      }),
    );

    expect((await moneyOfPayment(late.paymentId)).at(-1)).toMatchObject({
      event: 'money.refund_failed',
      failure: 'unknown',
      failureText: 'canceled',
    });
  });

  // events come in any order: a snapshot that says succeeded, after the one that says failed,
  // is old, and a refund that failed does not succeed again
  mockOnly(
    'does not send a refund that failed when an old event says that it succeeded',
    async () => {
      const late = await latePayment(deps());
      queueRefundOutcome({ status: 'pending' });
      await deliver(app, late.event);
      const refund = await refundOf(late.paymentId);
      const mails = watchMail();

      await deliverOk(
        app,
        refundEvent('refund.failed', {
          id: refund.id,
          paymentId: late.paymentId,
          status: 'failed',
          reason: 'expired_or_canceled_card',
        }),
      );
      await deliverOk(
        app,
        refundEvent('refund.updated', {
          id: refund.id,
          paymentId: late.paymentId,
          status: 'succeeded',
        }),
      );

      expect(await moneyStepsOf(late.paymentId)).toEqual([
        'money.late_payment',
        'money.refund:in_transit',
        'money.refund_failed',
      ]);
      expect(mailsTo(mails, late.user.email)).toHaveLength(1);
    },
  );

  mockOnly('writes the failure once when two deliveries come at the same time', async () => {
    const late = await latePayment(deps());
    queueRefundOutcome({ status: 'pending' });
    await deliver(app, late.event);
    const refund = await refundOf(late.paymentId);
    const event = refundEvent('refund.failed', {
      id: refund.id,
      paymentId: late.paymentId,
      status: 'failed',
      reason: 'expired_or_canceled_card',
    });
    const mails = watchMail();

    const answers = await whileLocked(
      (tx) => lockMoneyPayment(tx, late.paymentId),
      () => Promise.all([deliver(app, event), deliver(app, event)]),
      { waiters: 2 },
    );

    expect(answers.map((res) => res.statusCode)).toEqual([200, 200]);
    expect(await moneyStepsOf(late.paymentId)).toEqual([
      'money.late_payment',
      'money.refund:in_transit',
      'money.refund_failed',
    ]);
    expect(mailsTo(mails, late.user.email, FAILED_SUBJECT)).toHaveLength(1);
  });

  // the key is ours, the refund is not the one the line knows: it is not the refund of the line
  it('changes nothing for an event under the key that names another refund than the one kept', async () => {
    const late = await latePayment(deps());
    await deliver(app, late.event);
    const mails = watchMail();

    const res = await deliver(
      app,
      refundEvent('refund.updated', {
        id: 're_not_the_kept_one',
        paymentId: late.paymentId,
        status: 'failed',
        reason: 'expired_or_canceled_card',
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(await moneyStepsOf(late.paymentId)).toEqual(['money.late_payment', 'money.refund:sent']);
    expect(mailsTo(mails, late.user.email)).toEqual([]);
  });

  it('writes the failure in the language of the buyer', async () => {
    const late = await latePayment(deps(), { locale: 'uk' });
    await deliver(app, late.event);
    const refund = await refundOf(late.paymentId);
    const mails = watchMail();

    await deliverOk(
      app,
      refundEvent('refund.failed', {
        id: refund.id,
        paymentId: late.paymentId,
        status: 'failed',
        reason: 'expired_or_canceled_card',
      }),
    );

    const [mail] = mailsTo(mails, late.user.email, 'Ми не змогли надіслати');
    expect(mail!.subject).toContain(`#${late.orderId}`);
    expect(mail!.text).toContain('картка більше не приймає кошти');
  });
});

// a refund made by hand in the dashboard (no key of the app) is api/payments/handRefunds.test.ts
describe('the refund events that are not of a refund of the app', () => {
  // the key has the form of the app, no refund of the app has it: another tool in the account
  it('acknowledges a refund under a key the app does not know and says so', async () => {
    const mails = watchMail();
    const event = refundEvent('refund.failed', {
      id: 're_unknown',
      paymentId: 'pi_not_refunded_by_the_app',
      status: 'failed',
      reason: 'expired_or_canceled_card',
    });

    const res = await deliver(app, event);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, skipped: 'UNKNOWN_REFUND' });
    expect(takeLogs({ msg: 'stripe event was skipped', skipped: 'UNKNOWN_REFUND' })).toEqual([
      expect.objectContaining({ eventId: event.id, refundId: 're_unknown' }),
    ]);
    expect(await moneyOfPayment('pi_not_refunded_by_the_app')).toEqual([]);
    expect(mails).toEqual([]);
  });
});
