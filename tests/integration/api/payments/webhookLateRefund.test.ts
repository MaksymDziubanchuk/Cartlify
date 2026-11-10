import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { stripeProvider } from '@routes/api/payments/providers/stripe/stripe.provider.js';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import { closeSessions, removeProducts, type TestProduct } from '../../../helpers/factories.js';
import {
  deliverOk,
  LATE_REFUND_AMOUNT,
  lateEventsOf,
  lateLinesOf,
  latePayment,
  lockLateRefund,
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

// The refund of a payment the order could not take goes through three states, told by the lines of
// the admin log: the refund is made (order.refund_late), the money is sent (order.refund_late_sent,
// with the mail to the buyer), or the refund fails (order.refund_late_failed, with the mail). The
// buyer is mailed once for each, whatever the number of the deliveries of the events, also when two
// come at the same time. A refund that is pending, or that Stripe made for somebody else, writes
// nothing. Stripe is the mock; a refund that is pending or fails runs on the mock only (the sandbox
// gives a card refund that succeeds)

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

describe('the money of a late payment is sent', () => {
  it('writes the sent line and mails the buyer when Stripe answers that the refund succeeded', async () => {
    const late = await latePayment(deps());
    const mails = watchMail();

    expect((await deliver(app, late.event)).statusCode).toBe(200);

    const refund = await refundOf(late.paymentId);
    expect(refund).toMatchObject({ status: 'succeeded', amount: 5100 });
    expect(await lateEventsOf(late.orderId)).toEqual([
      'order.refund_late',
      'order.refund_late_sent',
    ]);
    const [, sent] = await lateLinesOf(late.orderId);
    expect(sent).toMatchObject({
      actorId: late.user.id,
      actorRole: 'USER',
      entityType: 'order',
      action: 'OTHER',
      meta: [
        {
          field: 'refund',
          old: null,
          new: {
            initiator: 'system',
            provider: 'stripe',
            paymentId: late.paymentId,
            refundId: refund.id,
            amount: LATE_REFUND_AMOUNT,
            currency: 'eur',
          },
        },
      ],
    });
    const told = mailsTo(mails, late.user.email);
    expect(told.map((mail) => mail.subject)).toEqual([
      `Cartlify — ${SENT_SUBJECT}${late.orderId} back`,
    ]);
    expect(told[0]!.text).toContain('We sent your payment of €51.00');
  });

  it('sends nothing twice when Stripe delivers the event of the page again', async () => {
    const late = await latePayment(deps());
    const mails = watchMail();

    await deliver(app, late.event);
    const again = await deliver(app, late.event);

    expect(again.statusCode).toBe(200);
    expect(await lateEventsOf(late.orderId)).toEqual([
      'order.refund_late',
      'order.refund_late_sent',
    ]);
    expect(mailsTo(mails, late.user.email)).toHaveLength(1);
  });

  mockOnly(
    'writes the refund line only and mails nothing while the refund is pending',
    async () => {
      const late = await latePayment(deps());
      queueRefundOutcome({ status: 'pending' });
      const mails = watchMail();

      expect((await deliver(app, late.event)).statusCode).toBe(200);

      expect(await refundOf(late.paymentId)).toMatchObject({ status: 'pending' });
      expect(await lateEventsOf(late.orderId)).toEqual(['order.refund_late']);
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

    expect(await lateEventsOf(late.orderId)).toEqual([
      'order.refund_late',
      'order.refund_late_sent',
    ]);
    expect(mailsTo(mails, late.user.email, SENT_SUBJECT)).toHaveLength(1);
  });

  // the event of the end can come before the answer to the request is kept: the app asks Stripe
  // where the refund stands once the line is written
  mockOnly(
    'reads the refund again after the line is written when its first answer was pending',
    async () => {
      const late = await latePayment(deps());
      queueRefundOutcome({ status: 'pending' });
      jest
        .spyOn(stripeProvider, 'getRefund')
        .mockImplementation(async (refundId) => ({ refundId, status: 'succeeded' }));
      const mails = watchMail();

      expect((await deliver(app, late.event)).statusCode).toBe(200);

      expect(await lateEventsOf(late.orderId)).toEqual([
        'order.refund_late',
        'order.refund_late_sent',
      ]);
      expect(mailsTo(mails, late.user.email, SENT_SUBJECT)).toHaveLength(1);
    },
  );

  // not reading the refund is no reason to fail the event: the money is refunded, the event that
  // ends it comes later, and the alert of the refunds not sent covers the rest
  mockOnly(
    'keeps the refund line and answers 200 when Stripe cannot be asked where the refund stands',
    async () => {
      const late = await latePayment(deps());
      queueRefundOutcome({ status: 'pending' });
      jest.spyOn(stripeProvider, 'getRefund').mockRejectedValue(new Error('unreachable'));
      const mails = watchMail();

      const res = await deliver(app, late.event);

      expect(res.statusCode).toBe(200);
      expect(takeLogs({ msg: 'the state of the refund of a late payment was not read' })).toEqual([
        expect.objectContaining({ orderId: late.orderId, paymentId: late.paymentId }),
      ]);
      expect(await lateEventsOf(late.orderId)).toEqual(['order.refund_late']);
      expect(mailsTo(mails, late.user.email)).toEqual([]);
    },
  );

  // two deliveries of the same event at the same time: they wait for each other, the first writes
  // the line and mails, the second finds it and does nothing
  mockOnly(
    'sends once when two deliveries of the event of the end come at the same time',
    async () => {
      const late = await latePayment(deps());
      queueRefundOutcome({ status: 'pending' });
      await deliver(app, late.event);
      const refund = await refundOf(late.paymentId);
      const event = refundEvent('refund.updated', {
        id: refund.id,
        paymentId: late.paymentId,
        status: 'succeeded',
      });
      const mails = watchMail();

      const answers = await whileLocked(
        (tx) => lockLateRefund(tx, late.paymentId),
        () => Promise.all([deliver(app, event), deliver(app, event)]),
        { waiters: 2 },
      );

      expect(answers.map((res) => res.statusCode)).toEqual([200, 200]);
      expect(await lateEventsOf(late.orderId)).toEqual([
        'order.refund_late',
        'order.refund_late_sent',
      ]);
      expect(mailsTo(mails, late.user.email, SENT_SUBJECT)).toHaveLength(1);
    },
  );

  it('refunds once, writes one line of each and mails once when the event of the page comes twice at the same time', async () => {
    const late = await latePayment(deps());
    const mails = watchMail();

    const answers = await whileLocked(
      (tx) => lockLateRefund(tx, late.paymentId),
      () => Promise.all([deliver(app, late.event), deliver(app, late.event)]),
      { waiters: 2 },
    );

    expect(answers.map((res) => res.statusCode)).toEqual([200, 200]);
    expect(await refundsOf(late.paymentId)).toHaveLength(1);
    expect(await lateEventsOf(late.orderId)).toEqual([
      'order.refund_late',
      'order.refund_late_sent',
    ]);
    expect(mailsTo(mails, late.user.email)).toHaveLength(1);
  });

  // an admin gave the money back in the Stripe dashboard before the event came: the buyer has it
  it('writes the sent line and mails the buyer for a payment Stripe had given back already', async () => {
    const late = await latePayment(deps());
    await refundAtStripe(late.paymentId);
    const mails = watchMail();

    expect((await deliver(app, late.event)).statusCode).toBe(200);

    expect(await lateEventsOf(late.orderId)).toEqual([
      'order.refund_late',
      'order.refund_late_sent',
    ]);
    const [, sent] = await lateLinesOf(late.orderId);
    expect(sent!.meta).toEqual([
      expect.objectContaining({ new: expect.objectContaining({ refundId: null }) }),
    ]);
    expect(mailsTo(mails, late.user.email, SENT_SUBJECT)).toHaveLength(1);
  });
});

describe('the refund of a late payment fails', () => {
  mockOnly(
    'writes the failed line and mails the buyer, once, when the pending refund fails',
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

      expect(await lateEventsOf(late.orderId)).toEqual([
        'order.refund_late',
        'order.refund_late_failed',
      ]);
      const [, failed] = await lateLinesOf(late.orderId);
      expect(failed).toMatchObject({
        actorId: late.user.id,
        actorRole: 'USER',
        meta: [
          {
            field: 'refund',
            old: null,
            new: {
              initiator: 'system',
              provider: 'stripe',
              paymentId: late.paymentId,
              refundId: refund.id,
              amount: LATE_REFUND_AMOUNT,
              currency: 'eur',
              failure: 'card_unavailable',
              failureText: reason,
              sentBack: false,
            },
          },
        ],
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
    'writes the failed line and mails the buyer, once, when the refund fails at once',
    async () => {
      const late = await latePayment(deps());
      const mails = watchMail();
      queueRefundOutcome({ status: 'failed', reason: 'expired_or_canceled_card' });

      // Stripe made the refund and it failed in the same answer: the event of the page is taken
      expect((await deliver(app, late.event)).statusCode).toBe(200);
      expect((await deliver(app, late.event)).statusCode).toBe(200);

      expect(await lateEventsOf(late.orderId)).toEqual([
        'order.refund_late',
        'order.refund_late_failed',
      ]);
      const [, failed] = await lateLinesOf(late.orderId);
      expect(failed).toMatchObject({
        meta: [
          {
            field: 'refund',
            new: {
              paymentId: late.paymentId,
              failure: 'card_unavailable',
              failureText: 'expired_or_canceled_card',
              sentBack: false,
            },
          },
        ],
      });
      const told = mailsTo(mails, late.user.email);
      expect(told.map((mail) => mail.subject)).toEqual([
        `Cartlify — ${FAILED_SUBJECT}${late.orderId}`,
      ]);
    },
  );

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

    expect(await lateEventsOf(late.orderId)).toEqual([
      'order.refund_late',
      'order.refund_late_sent',
      'order.refund_late_failed',
    ]);
    const failed = (await lateLinesOf(late.orderId)).at(-1)!;
    expect(failed.meta).toEqual([
      expect.objectContaining({
        new: expect.objectContaining({ failure: 'card_unavailable', sentBack: true }),
      }),
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
    ['charge_for_pending_refund_disputed', 'disputed', false],
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

    const failed = (await lateLinesOf(late.orderId)).at(-1)!;
    expect(failed.event).toBe('order.refund_late_failed');
    expect(failed.meta).toEqual([
      expect.objectContaining({ new: expect.objectContaining({ failure, failureText: reason }) }),
    ]);
    const [mail] = mailsTo(mails, late.user.email, FAILED_SUBJECT);
    expect(mail!.text.includes('the card can no longer take money')).toBe(aboutTheCard);
    expect(mail!.text).not.toContain(reason);
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

    const failed = (await lateLinesOf(late.orderId)).at(-1)!;
    expect(failed.event).toBe('order.refund_late_failed');
    expect(failed.meta).toEqual([
      expect.objectContaining({
        new: expect.objectContaining({ failure: 'unknown', failureText: 'canceled' }),
      }),
    ]);
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

      expect(await lateEventsOf(late.orderId)).toEqual([
        'order.refund_late',
        'order.refund_late_failed',
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
      (tx) => lockLateRefund(tx, late.paymentId),
      () => Promise.all([deliver(app, event), deliver(app, event)]),
      { waiters: 2 },
    );

    expect(answers.map((res) => res.statusCode)).toEqual([200, 200]);
    expect(await lateEventsOf(late.orderId)).toEqual([
      'order.refund_late',
      'order.refund_late_failed',
    ]);
    expect(mailsTo(mails, late.user.email, FAILED_SUBJECT)).toHaveLength(1);
  });

  // the refund is the one of the key of the payment, though its id is not the one kept
  it('finds the refund by the payment in its key when its id is not the one kept', async () => {
    const late = await latePayment(deps());
    await deliver(app, late.event);

    await deliverOk(
      app,
      refundEvent('refund.updated', {
        id: 're_not_the_kept_one',
        paymentId: late.paymentId,
        status: 'failed',
        reason: 'expired_or_canceled_card',
      }),
    );

    expect(await lateEventsOf(late.orderId)).toEqual([
      'order.refund_late',
      'order.refund_late_sent',
      'order.refund_late_failed',
    ]);
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

describe('the refund events that are not about a late payment', () => {
  // a refund made by hand in the dashboard has no key of the app: it is acknowledged, nothing is done
  it.each([
    ['succeeded', 'refund.updated'],
    ['failed', 'refund.failed'],
  ] as const)('leaves a refund made by hand at Stripe alone: %s', async (status, type) => {
    const late = await latePayment(deps());
    await deliver(app, late.event);
    const mails = watchMail();
    const before = await lateEventsOf(late.orderId);

    const res = await deliver(
      app,
      refundEvent(type, {
        id: 're_made_by_hand',
        paymentId: late.paymentId,
        status,
        reason: 'expired_or_canceled_card',
        metadata: {},
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(await lateEventsOf(late.orderId)).toEqual(before);
    expect(mailsTo(mails, late.user.email)).toEqual([]);
  });

  it('leaves a refund with the key of a payment the app did not refund alone', async () => {
    const mails = watchMail();

    const res = await deliver(
      app,
      refundEvent('refund.failed', {
        id: 're_unknown',
        paymentId: 'pi_not_refunded_by_the_app',
        status: 'failed',
        reason: 'expired_or_canceled_card',
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(mails).toEqual([]);
  });
});
