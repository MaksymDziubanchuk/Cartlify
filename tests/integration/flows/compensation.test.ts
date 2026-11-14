import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../helpers/actors.js';
import { alertsOf } from '../../helpers/alerts.js';
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
import { watchMail, type SentMail } from '../../helpers/mail.js';
import { placePaidOrder } from '../../helpers/payments.js';
import {
  closeOpenSessions,
  queueRefundOutcome,
  realStripe,
  refundsOf,
} from '../../helpers/stripe.js';

// A compensation by the button of the app, each step with what its actor sees:
// root gives an admin the right of the money, the admin finds the order of a buyer whose parcel
// came late and gives a compensation; the buyer is mailed. A second one the card no longer takes: the
// buyer hears nothing of it, root finds it in the alert of the failed compensations and sends it by
// a bank transfer, the buyer is told how. The rules and the refusals are api/payments/compensation.test.ts

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

const mockOnly = realStripe ? it.skip : it;
const alerts = alertsOf({ app: () => app, csrf: () => csrf });

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

const send = (actor: TestUser, method: 'POST' | 'PATCH', url: string, payload: object) =>
  app.inject({ method, url, headers: withCsrf(csrf, accessCookie(actor)), payload });

const toBuyer = (mails: SentMail[], buyer: TestUser, part = '') =>
  mails.filter((mail) => mail.to.includes(buyer.email) && mail.subject.includes(part));

describe('a compensation by the button of the app', () => {
  mockOnly(
    'an admin root allowed gives it and the buyer is told; one the card does not take root sends another way',
    async () => {
      const buyer = await createUser({ name: 'Anna Koval' });
      userIds.push(buyer.id);
      const product = await createProduct({ price: 10, stock: 10, name: `Desk lamp ${buyer.id}` });
      products.push(product);
      const { orderId, paymentId } = await placePaidOrder(app, csrf, buyer, product, {
        quantity: 2,
        stage: 'shipped',
      });

      // root finds the admin in the list of admins and gives the right of the money
      const listed = await get(root, `/api/root/admins?search=${encodeURIComponent(admin.email)}`);
      const adminId = (listed.json().items as { id: number }[])[0]!.id;
      expect(
        (await send(root, 'PATCH', `/api/root/admins/${adminId}`, { canManageMoney: true }))
          .statusCode,
      ).toBe(200);

      // the admin reads the order and gives 5 for the parcel that came late
      const order = (await get(admin, `/api/orders/${orderId}`)).json();
      expect(order).toMatchObject({ id: orderId, status: 'shipped' });
      const mails = watchMail();
      const given = await send(admin, 'POST', '/api/payments/compensations', {
        orderId,
        amount: 5,
        note: 'The parcel came three days late.',
      });
      expect(given.statusCode).toBe(200);
      expect(given.json()).toMatchObject({ purpose: 'compensation', state: 'sent', amount: 5 });
      expect(toBuyer(mails, buyer, 'We sent you a compensation for order #')).toHaveLength(1);

      // a second one the card no longer takes: the buyer hears nothing
      queueRefundOutcome({ status: 'failed', reason: 'expired_or_canceled_card' });
      const failing = await send(admin, 'POST', '/api/payments/compensations', {
        orderId,
        amount: 3,
        note: 'And the box was crushed.',
      });
      expect(failing.statusCode).toBe(200);
      expect(failing.json()).toMatchObject({ state: 'failed', failure: 'card_unavailable' });
      expect(toBuyer(mails, buyer)).toHaveLength(1);

      // root finds it in the alert of the failed compensations and sends it by a bank transfer
      const failedOnes = async () =>
        (await alerts.listOf(root, 'compensation_refunds_failed', { orderId })).items as {
          id: number;
          at: string;
        }[];
      const [failed, ...others] = await failedOnes();
      expect(others).toEqual([]);
      const sent = await send(root, 'POST', `/api/payments/refunds/${failed!.id}/outside`, {
        method: 'bank_transfer',
        note: 'To the account the buyer wrote by mail.',
        at: failed!.at,
      });
      expect(sent.statusCode).toBe(200);
      expect(toBuyer(mails, buyer, 'We sent you money for order #')).toHaveLength(1);
      expect(await failedOnes()).toEqual([]);

      // Stripe sent the first; the journal of the admins names the admin for both
      expect((await refundsOf(paymentId)).map((one) => one.amount)).toContain(500);
      const audit = await asAdmin((tx) =>
        tx.adminAuditLog.findMany({
          where: { entityType: 'order', entityId: orderId, event: 'payment.compensation' },
          select: { actorId: true },
        }),
      );
      expect(audit).toEqual([{ actorId: admin.id }, { actorId: admin.id }]);
    },
  );
});
