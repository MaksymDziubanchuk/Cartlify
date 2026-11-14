import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie, getMe } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import {
  closeSessions,
  createUser,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { failedLateRefund } from '../../helpers/lateRefund.js';
import { watchMail } from '../../helpers/mail.js';
import { closeOpenSessions, realStripe } from '../../helpers/stripe.js';

// Who may handle the money the way root does, each step with what its actor sees. An admin finds a
// late payment whose refund failed among the failed refunds of the alerts, and may not record the
// money as sent another way: the right is root's to give. Root finds the admin in the list of admins
// and gives the right; the admin, in the session already open, sees it in the profile and gets the
// decisions on the money among the alerts, records the money sent by a bank transfer, and the
// journal of the admins names the admin. Root takes the right away: the next failed refund is
// refused to the admin at once, and the decisions on the money leave the alerts. The refusals of
// each step are the tests of the routes (api/root/moneyManager, api/payments/refundsOutside).
let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
let admin: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

const mockOnly = realStripe ? it.skip : it;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT', name: 'Money Root' });
  admin = await createUser({ role: 'ADMIN', name: 'Olha Money' });
  userIds.push(root.id, admin.id);
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
const send = (actor: TestUser, method: 'POST' | 'PATCH', url: string, payload: unknown) =>
  app.inject({
    method,
    url,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload: payload as Record<string, unknown>,
  });

type Alert = { kind: string; count: number; list: { path: string; query: Record<string, string> } };

const kindsOf = async (actor: TestUser) => {
  const res = await get(actor, '/api/admin/alerts');
  expect(res.statusCode).toBe(200);
  return (res.json().alerts as Alert[]).map((alert) => alert.kind);
};

// the failed refunds of an order as the alert names them
async function failedOf(actor: TestUser, orderId: number) {
  const res = await get(actor, '/api/admin/alerts');
  const alert = (res.json().alerts as Alert[]).find((one) => one.kind === 'late_refunds_failed')!;
  const query = new URLSearchParams({ ...alert.list.query, orderId: String(orderId) });
  const list = await get(actor, `${alert.list.path}?${query}`);
  expect(list.statusCode).toBe(200);
  return list.json().items as { id: number; at: string }[];
}

const recordOutside = (actor: TestUser, refund: { id: number; at: string }) =>
  send(actor, 'POST', `/api/payments/refunds/${refund.id}/outside`, {
    method: 'bank_transfer',
    note: 'Sent to the account the buyer wrote by mail.',
    at: refund.at,
  });

describe('who may handle the money', () => {
  mockOnly(
    'root gives an admin the right, the admin sends the money of a failed refund another way, and loses the right at once when root takes it',
    async () => {
      const deps = { app, csrf, users: userIds, products };

      // the admin works without the right: the profile says so, no decision on the money in the alerts
      expect((await getMe(app, accessCookie(admin))).json()).toMatchObject({
        canManageMoney: false,
      });
      expect(await kindsOf(admin)).not.toContain('hand_refunds_to_explain');

      // a late payment whose refund failed: the admin finds it among the failed refunds
      const first = await failedLateRefund(deps, { name: 'Anna Koval' });
      const [refund] = await failedOf(admin, first.orderId);
      expect(refund).toBeDefined();
      const refused = await recordOutside(admin, refund!);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ errorCode: 'MONEY_MANAGER_REQUIRED' });

      // root finds the admin in the list of admins and gives the right
      const listed = await get(root, `/api/root/admins?search=${encodeURIComponent(admin.email)}`);
      const adminId = (listed.json().items as { id: number }[])[0]!.id;
      const given = await send(root, 'PATCH', `/api/root/admins/${adminId}`, {
        canManageMoney: true,
      });
      expect(given.statusCode).toBe(200);
      expect(given.json()).toMatchObject({ canManageMoney: true, canManageNewsletters: false });

      // the open session of the admin sees the right and the decisions on the money
      expect((await getMe(app, accessCookie(admin))).json()).toMatchObject({
        canManageMoney: true,
      });
      expect(await kindsOf(admin)).toEqual(
        expect.arrayContaining(['hand_refunds_to_explain', 'fraud_warnings', 'payment_reviews']),
      );
      expect(await kindsOf(admin)).not.toContain('admin_actions');

      // the admin records the money sent by a bank transfer: the buyer is told, the refund leaves
      // the alert, the journal of the admins names the admin
      const mails = watchMail();
      const marked = await recordOutside(admin, refund!);
      expect(marked.statusCode).toBe(200);
      expect(marked.json()).toMatchObject({ id: refund!.id, state: 'outside' });
      expect(await failedOf(admin, first.orderId)).toEqual([]);
      expect(
        mails.filter(
          (mail) =>
            mail.to.includes(first.user.email) &&
            mail.subject.includes('We sent you money for order #'),
        ),
      ).toHaveLength(1);
      const lines = await get(
        root,
        `/api/admin/audit-log?events=payment.refund_outside&entityType=order&entityId=${first.orderId}`,
      );
      expect(lines.json().items).toEqual([
        expect.objectContaining({ actorId: admin.id, actorRole: 'ADMIN' }),
      ]);

      // root reads the grant in the journal of the admins
      const grants = await get(
        root,
        `/api/admin/audit-log?events=payment.manager_granted&entityType=user&entityId=${adminId}`,
      );
      expect(grants.json().items).toHaveLength(1);

      // root takes the right away: the next failed refund is refused to the admin at once
      const taken = await send(root, 'PATCH', `/api/root/admins/${adminId}`, {
        canManageMoney: false,
      });
      expect(taken.statusCode).toBe(200);
      const second = await failedLateRefund(deps);
      const [next] = await failedOf(admin, second.orderId);
      const again = await recordOutside(admin, next!);
      expect(again.statusCode).toBe(403);
      expect(again.json()).toMatchObject({ errorCode: 'MONEY_MANAGER_REQUIRED' });
      expect(await kindsOf(admin)).not.toContain('hand_refunds_to_explain');
      expect((await getMe(app, accessCookie(admin))).json()).toMatchObject({
        canManageMoney: false,
      });
    },
  );
});
