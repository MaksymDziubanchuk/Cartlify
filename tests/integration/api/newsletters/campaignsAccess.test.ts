import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { closeSessions, createUser } from '../../../helpers/factories.js';
import { giveNewsletterRight } from '../../../helpers/newsletterManager.js';
import {
  CAMPAIGNS,
  campaignApi,
  forgetCampaigns,
  type CampaignApi,
} from '../../../helpers/newsletterCampaigns.js';
import {
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../../helpers/newsletterStaff.js';

// Who may call the routes of the campaigns: root, and an admin whom root allowed. Every other account
// is refused by the guard of its own: a visitor without a login and a user by their role, an admin
// without the right by the right itself, which the server reads from the database at every request.
// What each route does is the test of the route

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
let api: CampaignApi;
const made: number[] = [];
const extraUserIds: number[] = [];

// an id no row has: a route that finds nothing answers 404 for the ones allowed
const NO_ROW = 2_147_483_647;

type Call = {
  name: string;
  // what the allowed actors get
  allowed: number;
  send: (cookie: string) => Promise<LightMyRequestResponse>;
};

const noteIfMade = (res: LightMyRequestResponse) => {
  if (res.statusCode === 201) made.push(res.json().id as number);
  return res;
};

const ROUTES: Call[] = [
  {
    name: 'POST /api/newsletters/campaigns',
    allowed: 201,
    send: async (cookie) =>
      noteIfMade(
        await app.inject({
          method: 'POST',
          url: CAMPAIGNS,
          headers: withCsrf(csrf, cookie),
          payload: { name: 'Access check' },
        }),
      ),
  },
  {
    name: 'GET /api/newsletters/campaigns',
    allowed: 200,
    send: (cookie) =>
      app.inject({
        method: 'GET',
        url: `${CAMPAIGNS}?limit=1`,
        headers: cookie ? { cookie } : {},
      }),
  },
  {
    name: 'GET /api/newsletters/campaigns/:campaignId',
    allowed: 404,
    send: (cookie) =>
      app.inject({
        method: 'GET',
        url: `${CAMPAIGNS}/${NO_ROW}`,
        headers: cookie ? { cookie } : {},
      }),
  },
  {
    name: 'PATCH /api/newsletters/campaigns/:campaignId',
    allowed: 404,
    send: (cookie) =>
      app.inject({
        method: 'PATCH',
        url: `${CAMPAIGNS}/${NO_ROW}`,
        headers: withCsrf(csrf, cookie),
        payload: { name: 'Access check' },
      }),
  },
  {
    name: 'DELETE /api/newsletters/campaigns/:campaignId',
    allowed: 404,
    send: (cookie) =>
      app.inject({
        method: 'DELETE',
        url: `${CAMPAIGNS}/${NO_ROW}`,
        headers: withCsrf(csrf, cookie),
      }),
  },
  {
    name: 'POST /api/newsletters/campaigns/:campaignId/copy',
    allowed: 404,
    send: (cookie) =>
      app.inject({
        method: 'POST',
        url: `${CAMPAIGNS}/${NO_ROW}/copy`,
        headers: withCsrf(csrf, cookie),
      }),
  },
  {
    name: 'POST /api/newsletters/campaigns/:campaignId/schedule',
    allowed: 404,
    send: (cookie) =>
      app.inject({
        method: 'POST',
        url: `${CAMPAIGNS}/${NO_ROW}/schedule`,
        headers: withCsrf(csrf, cookie),
        payload: { runNow: true },
      }),
  },
  {
    name: 'POST /api/newsletters/campaigns/:campaignId/cancel',
    allowed: 404,
    send: (cookie) =>
      app.inject({
        method: 'POST',
        url: `${CAMPAIGNS}/${NO_ROW}/cancel`,
        headers: withCsrf(csrf, cookie),
      }),
  },
  {
    name: 'POST /api/newsletters/campaigns/:campaignId/stop',
    allowed: 404,
    send: (cookie) =>
      app.inject({
        method: 'POST',
        url: `${CAMPAIGNS}/${NO_ROW}/stop`,
        headers: withCsrf(csrf, cookie),
      }),
  },
  {
    name: 'POST /api/newsletters/campaigns/:campaignId/preview',
    allowed: 404,
    send: (cookie) =>
      app.inject({
        method: 'POST',
        url: `${CAMPAIGNS}/${NO_ROW}/preview`,
        headers: withCsrf(csrf, cookie),
        payload: { locale: 'en' },
      }),
  },
  {
    name: 'POST /api/newsletters/campaigns/:campaignId/test',
    allowed: 404,
    send: (cookie) =>
      app.inject({
        method: 'POST',
        url: `${CAMPAIGNS}/${NO_ROW}/test`,
        headers: withCsrf(csrf, cookie),
        payload: { email: 'access-check@example.com', locale: 'en' },
      }),
  },
];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  staff = await createNewsletterStaff();
  api = campaignApi(app, csrf);
});

afterAll(async () => {
  try {
    await forgetCampaigns(api, staff.manager, made);
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
// the very session the admin has open, the same access token, is refused at once; root gives it back
// and the same token works again
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

describe('the csrf token', () => {
  it.each([
    ['POST /api/newsletters/campaigns', 'POST', CAMPAIGNS, { name: 'No token' }],
    [
      'PATCH /api/newsletters/campaigns/:campaignId',
      'PATCH',
      `${CAMPAIGNS}/1`,
      { name: 'No token' },
    ],
    ['DELETE /api/newsletters/campaigns/:campaignId', 'DELETE', `${CAMPAIGNS}/1`, undefined],
    ['POST /api/newsletters/campaigns/:campaignId/copy', 'POST', `${CAMPAIGNS}/1/copy`, undefined],
    [
      'POST /api/newsletters/campaigns/:campaignId/schedule',
      'POST',
      `${CAMPAIGNS}/1/schedule`,
      { runNow: true },
    ],
    [
      'POST /api/newsletters/campaigns/:campaignId/cancel',
      'POST',
      `${CAMPAIGNS}/1/cancel`,
      undefined,
    ],
    ['POST /api/newsletters/campaigns/:campaignId/stop', 'POST', `${CAMPAIGNS}/1/stop`, undefined],
    [
      'POST /api/newsletters/campaigns/:campaignId/preview',
      'POST',
      `${CAMPAIGNS}/1/preview`,
      { locale: 'en' },
    ],
    [
      'POST /api/newsletters/campaigns/:campaignId/test',
      'POST',
      `${CAMPAIGNS}/1/test`,
      { email: 'a@example.com', locale: 'en' },
    ],
  ] as const)('is needed by %s', async (_name, method, url, payload) => {
    const res = await app.inject({
      method,
      url,
      headers: { cookie: accessCookie(staff.manager) },
      ...(payload ? { payload } : {}),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'CSRF_TOKEN_INVALID' });
  });
});
