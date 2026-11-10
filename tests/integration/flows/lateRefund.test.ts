import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../helpers/actors.js';
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
import { watchMail, type SentMail } from '../../helpers/mail.js';
import {
  closeOpenSessions,
  deliver,
  queueRefundOutcome,
  realStripe,
  refundBecomes,
  stripeEvent,
} from '../../helpers/stripe.js';

// A payment that comes after the units were sold, whose refund does not reach the buyer: root's way
// from the failure to the money sent another way, each step with what its actor sees. The buyer
// pays the page of a reservation that is over; Stripe takes the refund and keeps it pending, so
// the buyer hears nothing; Stripe fails it and the buyer is told so by mail; an admin sees the
// refund among the failed ones in the alerts, the list the alert names and the journal; root, who
// alone may, records that the money went to the buyer another way; the refund leaves the alert
// and the buyer is told how it was sent. The refusals of each step are the tests of the routes
// (api/payments/refundsOutside.test.ts) and the events of the refund those of the webhook
// (api/payments/webhookLateRefund.test.ts). The refund that stays pending is made by the Stripe
// mock only (the sandbox gives a card refund that succeeds)

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
  id: string;
  source: string;
  orderId: number;
  refundId: string | null;
  amount: number | null;
  currency: string | null;
  failure: string | null;
  at: string;
};

// the alert of a kind as the admin reads it, and the rows of the list it names, narrowed to an order
async function failedRefundsOf(actor: TestUser, orderId: number) {
  const alerts = await get(actor, '/api/admin/alerts');
  expect(alerts.statusCode).toBe(200);
  const alert = (alerts.json().alerts as Alert[]).find((one) => one.kind === 'failed_refunds')!;

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
          source: 'payment',
          orderId,
          amount: 51,
          currency: 'eur',
          failure: 'card_unavailable',
        }),
      ]);
      const refundId = seen.rows[0]!.refundId!;

      // and the journal, filtered for every failed refund, holds the line of the failure
      const journal = await get(
        admin,
        `/api/admin/audit-log?events=return.refund_failed,order.refund_late_failed&entityType=order&entityId=${orderId}`,
      );
      expect(journal.statusCode).toBe(200);
      expect(journal.json().items.map((line: { event: string }) => line.event)).toEqual([
        'order.refund_late_failed',
      ]);

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
      expect(marked.json()).toMatchObject({ refundId, orderId, state: 'outside' });

      // the refund has left the alert and the list, and the journal has the line of root
      const after = await failedRefundsOf(admin, orderId);
      expect(after.rows).toEqual([]);
      const lines = await get(
        admin,
        `/api/admin/audit-log?events=order.refund_late_outside&entityType=order&entityId=${orderId}`,
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
