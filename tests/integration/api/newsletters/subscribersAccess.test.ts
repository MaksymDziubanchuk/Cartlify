import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { closeSessions, createUser, uniqueEmail } from '../../../helpers/factories.js';
import { giveNewsletterRight } from '../../../helpers/newsletterManager.js';
import { forget } from '../../../helpers/newsletterApi.js';
import {
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../../helpers/newsletterStaff.js';

// Who may call the routes of the people who run the newsletters (the subscribers and the blocklist):
// root, and an admin whom root allowed. Every other account is refused by the guard of its own: a
// visitor without a login and a user by their role, an admin without the right by the right itself,
// which the server reads from the database at every request (so root taking it away stops the admin
// in the session that is open). What each route does is the test of the route

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
const emails: string[] = [];
const extraUserIds: number[] = [];

// an id no row has: a route that finds nothing answers 404 for the ones allowed
const NO_ROW = 2_147_483_647;

type Call = {
  name: string;
  // what the allowed actors get
  allowed: number;
  send: (cookie: string) => Promise<LightMyRequestResponse>;
};

const ROUTES: Call[] = [
  {
    name: 'GET /api/newsletters/subscribers/summary',
    allowed: 200,
    send: (cookie) =>
      app.inject({
        method: 'GET',
        url: '/api/newsletters/subscribers/summary',
        headers: cookie ? { cookie } : {},
      }),
  },
  {
    name: 'GET /api/newsletters/subscribers',
    allowed: 200,
    send: (cookie) =>
      app.inject({
        method: 'GET',
        url: '/api/newsletters/subscribers?limit=1',
        headers: cookie ? { cookie } : {},
      }),
  },
  {
    name: 'DELETE /api/newsletters/subscribers/:subscriberId',
    allowed: 404,
    send: (cookie) =>
      app.inject({
        method: 'DELETE',
        url: `/api/newsletters/subscribers/${NO_ROW}`,
        headers: withCsrf(csrf, cookie),
      }),
  },
  {
    name: 'GET /api/newsletters/blocklist',
    allowed: 200,
    send: (cookie) =>
      app.inject({
        method: 'GET',
        url: `/api/newsletters/blocklist?email=${encodeURIComponent(uniqueEmail('lookup'))}`,
        headers: cookie ? { cookie } : {},
      }),
  },
  {
    name: 'POST /api/newsletters/blocklist',
    allowed: 201,
    send: (cookie) => {
      const email = uniqueEmail('access-block');
      emails.push(email);

      return app.inject({
        method: 'POST',
        url: '/api/newsletters/blocklist',
        headers: withCsrf(csrf, cookie),
        payload: { email },
      });
    },
  },
  {
    name: 'DELETE /api/newsletters/blocklist/:blockId',
    allowed: 404,
    send: (cookie) =>
      app.inject({
        method: 'DELETE',
        url: `/api/newsletters/blocklist/${NO_ROW}`,
        headers: withCsrf(csrf, cookie),
      }),
  },
];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  staff = await createNewsletterStaff();
});

afterAll(async () => {
  try {
    await forget(emails);
    await closeStaff(staff);
    await closeSessions(extraUserIds);
  } finally {
    await stopApp();
  }
});

describe.each(ROUTES)('$name', ({ allowed, send }) => {
  it('refuses a visitor without a login: a guest has a role of its own', async () => {
    const res = await send('');

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('asks a session that is not valid to log in again', async () => {
    const res = await send('accessToken=not-a-token');

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ errorCode: 'LOGIN_REQUIRED' });
  });

  it('refuses a user by their role', async () => {
    const res = await send(accessCookie(staff.user));

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('refuses an admin whom root did not allow', async () => {
    const res = await send(accessCookie(staff.plainAdmin));

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_MANAGER_REQUIRED' });
  });

  it('lets an admin whom root allowed', async () => {
    const res = await send(accessCookie(staff.manager));

    expect(res.statusCode).toBe(allowed);
  });

  it('lets root', async () => {
    const res = await send(accessCookie(staff.root));

    expect(res.statusCode).toBe(allowed);
  });
});

// The right is read from the database at every request, never from the token: root takes it away and
// the very session the admin has open, the same access token, is refused at once; root gives it
// back and the same token works again
describe('the right root takes away', () => {
  it.each(ROUTES)(
    'stops an admin in the session that is open: $name',
    async ({ allowed, send }) => {
      const admin = await createUser({ role: 'ADMIN' });
      extraUserIds.push(admin.id);
      await giveNewsletterRight(staff.root.id, admin.id);
      const cookie = accessCookie(admin);

      expect((await send(cookie)).statusCode).toBe(allowed);

      const taken = await app.inject({
        method: 'PATCH',
        url: `/api/root/admins/${admin.id}`,
        headers: withCsrf(csrf, accessCookie(staff.root)),
        payload: { canManageNewsletters: false },
      });
      expect(taken.statusCode).toBe(200);

      const refused = await send(cookie);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ errorCode: 'NEWSLETTER_MANAGER_REQUIRED' });

      const given = await app.inject({
        method: 'PATCH',
        url: `/api/root/admins/${admin.id}`,
        headers: withCsrf(csrf, accessCookie(staff.root)),
        payload: { canManageNewsletters: true },
      });
      expect(given.statusCode).toBe(200);

      expect((await send(cookie)).statusCode).toBe(allowed);
    },
  );
});
