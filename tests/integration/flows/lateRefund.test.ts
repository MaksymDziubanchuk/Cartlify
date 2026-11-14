import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { settleRefundsInTransit } from '@routes/api/payments/services/settleRefundsInTransit.service.js';

import { accessCookie } from '../../helpers/actors.js';
import { alertsOf } from '../../helpers/alerts.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import {
  closeSessions,
  createUser,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { latePayment, refundOf } from '../../helpers/lateRefund.js';
import { moveClock } from '../../helpers/payments.js';
import { watchMail, type SentMail } from '../../helpers/mail.js';
import {
  closeOpenSessions,
  deliver,
  queueRefundOutcome,
  realStripe,
  refundAtStripe,
  refundBecomes,
  refundsOf,
  stripeEvent,
  withStripeOutOfReach,
} from '../../helpers/stripe.js';

// The refund of a payment that comes after the units were sold, on its ways that are not the plain
// one. A refund that does not reach the buyer: root's way
// from the failure to the money sent another way, each step with what its actor sees. The buyer
// pays the page of a reservation that is over; Stripe takes the refund and keeps it pending, so
// the buyer hears nothing; Stripe fails it and the buyer is told so by mail; an admin sees the
// refund among the failed ones in the alerts and the list the alert names (the refunds of the money
// journal); root, who alone may, records that the money went to the buyer another way, which the
// journal of the admins keeps; the refund leaves the alert and the buyer is told how it was sent. The refusals of each step are the tests of the routes
// (api/payments/refundsOutside.test.ts) and the events of the refund those of the webhook
// (api/payments/webhookLateRefund.test.ts). The refund that stays pending is made by the Stripe
// mock only (the sandbox gives a card refund that succeeds).
// A refund whose request got no answer from Stripe: the admins see it in transit, the worker of the
// refunds (moneyRefund.worker.ts, a run limited to the payment of the test: the refunds of other
// files are not its own) asks again with the same key and the buyer is told once. And the same lost
// request while an admin gives the money back by hand in the Stripe dashboard: Stripe refuses the
// request as given back already, the refund made by hand is the one of the app, the money journal
// has one movement out, not two

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

const mockOnly = realStripe ? it.skip : it;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  userIds.push(admin.id, root.id);
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

const get = (actor: TestUser, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: accessCookie(actor) } });

type Alert = {
  kind: string;
  count: number;
  list: { path: string; query: Record<string, string> };
};
type Refund = {
  id: number;
  purpose: string;
  state: string;
  orderId: number;
  refundId: string | null;
  amount: number;
  currency: string | null;
  failure: string | null;
  byDashboard: boolean;
  at: string;
};

// the refunds of the money journal as the admin lists them
async function refundsListed(actor: TestUser, query: string): Promise<Refund[]> {
  const res = await get(actor, `/api/payments/refunds?${query}`);
  expect(res.statusCode).toBe(200);
  return res.json().items;
}

// the lines of the money journal of the admins for an order, the oldest first
async function moneyLogOf(actor: TestUser, orderId: number) {
  const res = await get(actor, `/api/admin/money-log?orderId=${orderId}&sortOrder=asc&limit=100`);
  expect(res.statusCode).toBe(200);
  return res.json().items as Array<{
    event: string;
    purpose: string;
    part: string;
    amount: number;
    state: string | null;
    refundId: string | null;
    byDashboard: boolean;
    actorRole: string | null;
  }>;
}

// a logger of the worker that keeps what it got
const workerLog = () => ({
  info: jest.fn<(obj: unknown, msg?: string) => void>(),
  warn: jest.fn<(obj: unknown, msg?: string) => void>(),
  error: jest.fn<(obj: unknown, msg?: string) => void>(),
});

const SENT_SUBJECT = 'We sent your payment for order #';

// the alert of a kind as the admin reads it, and the rows of the list it names, narrowed to an order
async function failedRefundsOf(actor: TestUser, orderId: number) {
  const alerts = await get(actor, '/api/admin/alerts');
  expect(alerts.statusCode).toBe(200);
  const alert = (alerts.json().alerts as Alert[]).find(
    (one) => one.kind === 'late_refunds_failed',
  )!;

  const query = new URLSearchParams({ ...alert.list.query, orderId: String(orderId) });
  const list = await get(actor, `${alert.list.path}?${query}`);
  expect(list.statusCode).toBe(200);
  return { alert, rows: list.json().items as Refund[] };
}

const mailsTo = (mails: SentMail[], email: string) =>
  mails.filter((mail) => mail.to.includes(email));

describe('a late payment whose refund fails', () => {
  mockOnly(
    'is told to the buyer, seen by the admin and recorded by root as sent another way',
    async () => {
      // the buyer pays the page after the reservation was over and the units were gone
      const late = await latePayment(
        { app, csrf, users: userIds, products },
        { name: 'Anna Koval' },
      );
      const mails = watchMail();

      // Stripe takes the refund and keeps it pending: the buyer hears nothing yet
      queueRefundOutcome({ status: 'pending' });
      expect((await deliver(app, late.event)).statusCode).toBe(200);
      expect(mailsTo(mails, late.user.email)).toEqual([]);

      // Stripe tells that the refund failed: the buyer is told, the order named in the subject
      const refund = await refundOf(late.paymentId);
      await refundBecomes(refund.id, { status: 'failed', reason: 'expired_or_canceled_card' });
      expect((await deliver(app, await stripeEvent('refund.failed', refund.id))).statusCode).toBe(
        200,
      );
      const told = mailsTo(mails, late.user.email);
      expect(told).toHaveLength(1);
      expect(told[0]!.subject).toContain('We could not send your payment back for order #');
      expect(told[0]!.text).toContain('We will contact you about another way to send it.');
      const orderId = Number(/order #(\d+)/.exec(told[0]!.subject)![1]);

      // the admin sees the refund among the failed ones: the alert counts it and names the list
      const seen = await failedRefundsOf(admin, orderId);
      expect(seen.alert.count).toBeGreaterThanOrEqual(1);
      expect(seen.rows).toEqual([
        expect.objectContaining({
          purpose: 'late_payment',
          state: 'failed',
          orderId,
          amount: 51,
          currency: 'eur',
          failure: 'card_unavailable',
        }),
      ]);
      const refundId = seen.rows[0]!.id;

      // an admin may not record it: only root
      const refused = await app.inject({
        method: 'POST',
        url: `/api/payments/refunds/${refundId}/outside`,
        headers: withCsrf(csrf, accessCookie(admin)),
        payload: { method: 'bank_transfer', note: 'Sent.', at: seen.rows[0]!.at },
      });
      expect(refused.statusCode).toBe(403);

      // root records that the money went to the buyer by a bank transfer, on the day it went
      const marked = await app.inject({
        method: 'POST',
        url: `/api/payments/refunds/${refundId}/outside`,
        headers: withCsrf(csrf, accessCookie(root)),
        payload: {
          method: 'bank_transfer',
          note: 'Sent to the account the buyer wrote by mail.',
          at: seen.rows[0]!.at,
        },
      });
      expect(marked.statusCode).toBe(200);
      expect(marked.json()).toMatchObject({ id: refundId, orderId, state: 'outside' });

      // the refund has left the alert and the list, and the journal has the line of root
      const after = await failedRefundsOf(admin, orderId);
      expect(after.rows).toEqual([]);
      const lines = await get(
        admin,
        `/api/admin/audit-log?events=payment.refund_outside&entityType=order&entityId=${orderId}`,
      );
      expect(lines.json().items).toHaveLength(1);

      // the buyer is told how and when the money was sent
      const sent = mailsTo(mails, late.user.email).filter((mail) =>
        mail.subject.includes('We sent you money for order #'),
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain('We sent you €51.00 for your order #');
      expect(sent[0]!.text).toContain('We sent it by a bank transfer on ');
    },
  );
});

describe('a late payment whose refund Stripe did not answer', () => {
  it('stays in transit for the admins until the worker asks again, and the buyer is told once', async () => {
    const late = await latePayment({ app, csrf, users: userIds, products }, { name: 'Anna Koval' });
    const mails = watchMail();

    // the event of the page comes; the request of the refund gets no answer from Stripe: the buyer
    // hears nothing yet
    const delivered = await withStripeOutOfReach(() => deliver(app, late.event));
    expect(delivered.statusCode).toBe(200);
    expect(mailsTo(mails, late.user.email)).toEqual([]);

    // the admin sees the refund on its way, without a number of Stripe yet
    expect(await refundsListed(admin, `state=in_transit&orderId=${late.orderId}`)).toEqual([
      expect.objectContaining({
        purpose: 'late_payment',
        state: 'in_transit',
        refundId: null,
        amount: 51,
      }),
    ]);

    // three days on, the admins see it among the late refunds in transit too long
    const alerts = alertsOf({ app: () => app, csrf: () => csrf });
    const inTransit = async () => {
      const clock = moveClock(3 * 86_400_000 + 3_600_000);
      try {
        return (await alerts.listOf(admin, 'late_refunds_in_transit', { orderId: late.orderId }))
          .items;
      } finally {
        clock.restore();
      }
    };
    expect(await inTransit()).toEqual([
      expect.objectContaining({ purpose: 'late_payment', state: 'in_transit', amount: 51 }),
    ]);

    // the worker asks Stripe again with the same key: the refund is made and sent
    const log = workerLog();
    expect(await settleRefundsInTransit(log, { olderThanMs: 0, paymentId: late.paymentId })).toBe(
      1,
    );
    expect(log.error).not.toHaveBeenCalled();
    const told = mailsTo(mails, late.user.email);
    expect(told).toHaveLength(1);
    expect(told[0]!.subject).toContain(`${SENT_SUBJECT}${late.orderId} back`);
    expect(told[0]!.text).toContain('We sent your payment of €51.00');

    // the admin sees it sent, with the number Stripe gave it
    const [sent] = await refundsListed(admin, `orderId=${late.orderId}`);
    expect(sent).toMatchObject({
      purpose: 'late_payment',
      state: 'sent',
      refundId: expect.stringMatching(/^re_/),
    });
    expect(await refundsListed(admin, `state=in_transit&orderId=${late.orderId}`)).toEqual([]);
    expect(await inTransit()).toEqual([]);

    // the events Stripe sends of that refund, and a next run of the worker: nothing more
    expect(
      (await deliver(app, await stripeEvent('refund.created', sent!.refundId!))).statusCode,
    ).toBe(200);
    expect(
      await settleRefundsInTransit(workerLog(), { olderThanMs: 0, paymentId: late.paymentId }),
    ).toBe(0);
    expect(mailsTo(mails, late.user.email)).toHaveLength(1);
    expect(await refundsOf(late.paymentId)).toHaveLength(1);

    // the money journal: the payment came, the same sum went back, the work of the system
    expect(await moneyLogOf(admin, late.orderId)).toEqual([
      expect.objectContaining({
        event: 'money.late_payment',
        purpose: 'late_payment',
        part: 'whole',
        amount: 51,
        actorRole: null,
      }),
      expect.objectContaining({
        event: 'money.refund',
        purpose: 'late_payment',
        part: 'whole',
        amount: -51,
        state: 'sent',
        refundId: sent!.refundId,
        byDashboard: false,
        actorRole: null,
      }),
    ]);
  });

  // the already_refunded race: the money went back by hand at Stripe after the request of the app
  // was lost, before the worker asked again
  it('counts the money once when an admin gives it back by hand in the Stripe dashboard meanwhile', async () => {
    const late = await latePayment({ app, csrf, users: userIds, products }, { name: 'Anna Koval' });
    const mails = watchMail();
    const delivered = await withStripeOutOfReach(() => deliver(app, late.event));
    expect(delivered.statusCode).toBe(200);

    // meanwhile an admin gives the whole payment back in the Stripe dashboard
    const byHand = await refundAtStripe(late.paymentId);

    // the worker asks again: Stripe says the money went back already; the refund made by hand is
    // the refund of the app, and the buyer is told the money is sent
    expect(
      await settleRefundsInTransit(workerLog(), { olderThanMs: 0, paymentId: late.paymentId }),
    ).toBe(1);
    const told = mailsTo(mails, late.user.email);
    expect(told).toHaveLength(1);
    expect(told[0]!.subject).toContain(`${SENT_SUBJECT}${late.orderId} back`);
    expect(told[0]!.text).toContain('We sent your payment of €51.00');

    // then Stripe tells of the refund made by hand: it is counted already, nothing more
    expect((await deliver(app, await stripeEvent('refund.created', byHand.id))).statusCode).toBe(
      200,
    );
    expect(mailsTo(mails, late.user.email)).toHaveLength(1);
    expect(await refundsOf(late.paymentId)).toHaveLength(1);

    // the admin sees one refund, sent, made in the dashboard, and nothing that waits for root
    expect(await refundsListed(admin, `orderId=${late.orderId}`)).toEqual([
      expect.objectContaining({
        purpose: 'late_payment',
        state: 'sent',
        refundId: byHand.id,
        byDashboard: true,
        amount: 51,
      }),
    ]);
    expect(await refundsListed(root, `state=unassigned&orderId=${late.orderId}`)).toEqual([]);

    // the money journal: one movement in, one out
    const lines = await moneyLogOf(admin, late.orderId);
    expect(lines).toEqual([
      expect.objectContaining({ event: 'money.late_payment', amount: 51 }),
      expect.objectContaining({
        event: 'money.refund',
        purpose: 'late_payment',
        amount: -51,
        state: 'sent',
        refundId: byHand.id,
        byDashboard: true,
      }),
    ]);
    expect(lines.reduce((sum, line) => sum + line.amount, 0)).toBe(0);
  });
});
