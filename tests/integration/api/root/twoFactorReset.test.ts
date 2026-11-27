import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie, logIn, refreshWith, signIn } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import { closeSessions, createUser, type TestUser } from '../../../helpers/factories.js';
import { watchMail } from '../../../helpers/mail.js';
import { enrollTwoFactor } from '../../../helpers/twoFactor.js';

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await newUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

async function newUser(opts: Parameters<typeof createUser>[0] = {}) {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
}

const reset = (actor: TestUser, targetId: number) =>
  app.inject({
    method: 'DELETE',
    url: `/api/root/admins/${targetId}/two-factor`,
    headers: withCsrf(csrf, accessCookie(actor)),
  });

describe('DELETE /api/root/admins/:adminId/two-factor', () => {
  it('resets the second step of an admin: the sessions end, the admin gets a mail, the next login sets it up', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    admin.twoFactorApp = (await enrollTwoFactor({ id: admin.id, role: 'ADMIN' })).app;
    const session = await signIn(app, csrf, admin);
    const mails = watchMail();

    const res = await reset(root, admin.id);
    expect(res.statusCode).toBe(204);

    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: [admin.email] });
    expect(mails[0]!.subject).toContain('The second step of your login was reset');

    const refreshed = await refreshWith(app, csrf, session.refreshToken);
    expect(refreshed.json()).toMatchObject({ errorCode: 'REFRESH_TOKEN_REVOKED' });

    const login = await logIn(app, csrf, { email: admin.email, password: admin.password });
    expect(login.statusCode).toBe(202);
    expect(login.json()).toMatchObject({ twoFactor: 'setup' });

    const line = await asAdmin((tx) =>
      tx.adminAuditLog.findFirst({
        where: { event: 'two_factor.reset', entityId: admin.id },
        select: { actorId: true, entityType: true, action: true },
      }),
    );
    expect(line).toEqual({ actorId: root.id, entityType: 'user', action: 'OTHER' });
  });

  it('finds nothing to reset for an admin without the second step, or a deleted account', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    const res = await reset(root, admin.id);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'TWO_FACTOR_NOT_FOUND' });
    expect((await reset(root, 2_000_000_000)).json()).toMatchObject({
      errorCode: 'USER_NOT_FOUND',
    });
  });

  it('resets no customer and no root', async () => {
    const buyer = await newUser();
    const otherRoot = await newUser({ role: 'ROOT' });
    await enrollTwoFactor({ id: otherRoot.id, role: 'ROOT' });

    for (const target of [buyer, otherRoot]) {
      const res = await reset(root, target.id);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'USER_NOT_ADMIN' });
    }
  });

  it('is for root only', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    const other = await newUser({ role: 'ADMIN' });

    const res = await reset(admin, other.id);
    expect(res.statusCode).toBe(403);
  });
});
