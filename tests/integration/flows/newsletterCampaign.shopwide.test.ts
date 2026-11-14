import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { sessionCookie, signIn, type Session } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';

// A campaign from a draft to the day it goes out, each step with what its actor sees. Root gives an
// admin the right to run the newsletters and sets the limit of the shop to one campaign in a week.
// The admin makes a draft with a subject and no block, tries to schedule it and reads what is missing,
// writes the rest, and schedules it. A copy of it cannot take the same week: the refusal names the
// campaign in the way, the admin calls that one off, the copy takes the week and later moves to
// another. The list shows the campaigns in their states and root reads each step in the admin log.
// The refusals one by one (the wrong states, the past, the races) are the tests of the routes
// (api/newsletters). *.shopwide: the limit counts every campaign of the database.

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
let admin: TestUser;
let drafter: TestUser;
let limitBefore: { count: number; days: number };

const DAY = 24 * 60 * 60 * 1000;
// a year of its own, far away and different for every run, as the tests of the routes take theirs
const year = 2100 + Math.floor(Math.random() * 6000);
const start = Date.UTC(year, 5, 1, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT', name: 'Campaign Root' });
  admin = await createUser({ role: 'ADMIN', name: 'Campaign Admin' });
  drafter = await createUser({ role: 'ADMIN', name: 'Draft Admin' });
});

afterAll(async () => {
  try {
    await closeSessions([root.id, admin.id, drafter.id]);
  } finally {
    await stopApp();
  }
});

const send = (
  session: Session,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) =>
  app.inject({
    method,
    url,
    headers:
      method === 'GET'
        ? { cookie: sessionCookie(session) }
        : withCsrf(csrf, sessionCookie(session)),
    ...(payload ? { payload } : {}),
  });

describe('a campaign from a draft to the day it goes out', () => {
  it('is drafted, completed, scheduled, held back by the limit, freed by a cancellation and moved', async () => {
    const rootSession = await signIn(app, csrf, root);
    const adminSession = await signIn(app, csrf, admin);

    // the limit of the shop, as it stands: root reads it and sets one campaign in a week
    const settings = await send(rootSession, 'GET', '/api/admin/shop-settings');
    limitBefore = {
      count: settings.json().newsletterLimitCount,
      days: settings.json().newsletterLimitDays,
    };
    try {
      expect(
        (
          await send(rootSession, 'PUT', '/api/root/shop-settings/newsletterLimitCount', {
            value: 1,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await send(rootSession, 'PUT', '/api/root/shop-settings/newsletterLimitDays', {
            value: 7,
          })
        ).statusCode,
      ).toBe(200);

      // root gives the admin the right; the admin sees it in the profile
      const given = await send(rootSession, 'PATCH', `/api/root/admins/${admin.id}`, {
        canManageNewsletters: true,
      });
      expect(given.statusCode).toBe(200);
      expect((await send(adminSession, 'GET', '/api/users/me')).json().canManageNewsletters).toBe(
        true,
      );

      // the admin makes a draft with a subject and no block
      const created = await send(adminSession, 'POST', '/api/newsletters/campaigns', {
        name: 'Flow week',
        content: { subject: { en: 'Flow sale' }, blocks: [] },
      });
      expect(created.statusCode).toBe(201);
      const campaign = created.json() as { id: number };

      // scheduling it says what is missing, and the admin writes exactly that
      const early = await send(
        adminSession,
        'POST',
        `/api/newsletters/campaigns/${campaign.id}/schedule`,
        { scheduledAt: iso(start) },
      );
      expect(early.statusCode).toBe(400);
      expect(early.json()).toMatchObject({
        errorCode: 'NEWSLETTER_CONTENT_INCOMPLETE',
        details: { missing: [{ field: 'content.blocks', locale: null }] },
      });

      const written = await send(
        adminSession,
        'PATCH',
        `/api/newsletters/campaigns/${campaign.id}`,
        {
          content: {
            subject: { en: 'Flow sale' },
            blocks: [{ type: 'button', kind: 'sale', url: '/sale' }],
          },
        },
      );
      expect(written.statusCode).toBe(200);

      const scheduled = await send(
        adminSession,
        'POST',
        `/api/newsletters/campaigns/${campaign.id}/schedule`,
        { scheduledAt: iso(start) },
      );
      expect(scheduled.statusCode).toBe(200);
      expect(scheduled.json()).toMatchObject({
        id: campaign.id,
        status: 'scheduled',
        scheduledAt: iso(start),
      });

      // a copy of it asks for the same week and is held back; the refusal names the campaign in the way
      const copy = (
        await send(adminSession, 'POST', `/api/newsletters/campaigns/${campaign.id}/copy`)
      ).json() as { id: number; name: string };
      const held = await send(
        adminSession,
        'POST',
        `/api/newsletters/campaigns/${copy.id}/schedule`,
        { scheduledAt: iso(start + 2 * DAY) },
      );
      expect(held.statusCode).toBe(409);
      expect(held.json()).toMatchObject({
        errorCode: 'NEWSLETTER_LIMIT_REACHED',
        details: {
          campaigns: [{ id: campaign.id, name: 'Flow week', at: iso(start) }],
          limit: { count: 1, days: 7 },
        },
      });
      const blocking = (held.json().details.campaigns as { id: number }[])[0]!;

      // the admin calls the one in the way off, and the copy takes the week
      const called = await send(
        adminSession,
        'POST',
        `/api/newsletters/campaigns/${blocking.id}/cancel`,
      );
      expect(called.statusCode).toBe(200);
      expect(called.json().status).toBe('cancelled');

      const taken = await send(
        adminSession,
        'POST',
        `/api/newsletters/campaigns/${copy.id}/schedule`,
        { scheduledAt: iso(start + 2 * DAY) },
      );
      expect(taken.statusCode).toBe(200);

      // later the copy moves to another week, and the page lists what is scheduled and what is not
      const moved = await send(
        adminSession,
        'POST',
        `/api/newsletters/campaigns/${copy.id}/schedule`,
        { scheduledAt: iso(start + 30 * DAY) },
      );
      expect(moved.statusCode).toBe(200);
      expect(moved.json().scheduledAt).toBe(iso(start + 30 * DAY));

      const listed = async (status: string) => {
        const res = await send(adminSession, 'GET', `/api/newsletters/campaigns?status=${status}`);
        expect(res.statusCode).toBe(200);
        return (res.json().items as { id: number; scheduledAt: string | null }[]).filter(
          (item) => item.id === copy.id || item.id === campaign.id,
        );
      };
      expect(await listed('scheduled')).toEqual([
        expect.objectContaining({ id: copy.id, scheduledAt: iso(start + 30 * DAY) }),
      ]);
      expect(await listed('cancelled')).toEqual([expect.objectContaining({ id: campaign.id })]);

      // root reads what the admin did to the campaign, step by step
      const journal = await send(
        rootSession,
        'GET',
        `/api/admin/audit-log?entityType=newsletter_campaign&entityId=${copy.id}`,
      );
      expect(journal.statusCode).toBe(200);
      const events = (journal.json().items as { event: string }[]).map((line) => line.event);
      expect(events.filter((event) => event === 'newsletter.campaign_scheduled')).toHaveLength(2);
      expect(events).toContain('newsletter.campaign_copied');

      // the one the admin called off is cancelled in the log as well
      const first = await send(
        rootSession,
        'GET',
        `/api/admin/audit-log?entityType=newsletter_campaign&entityId=${campaign.id}`,
      );
      expect((first.json().items as { event: string }[]).map((line) => line.event)).toContain(
        'newsletter.campaign_cancelled',
      );

      // nothing of this stays scheduled: the copy is called off too
      expect(
        (await send(adminSession, 'POST', `/api/newsletters/campaigns/${copy.id}/cancel`))
          .statusCode,
      ).toBe(200);
    } finally {
      for (const [key, value] of [
        ['newsletterLimitCount', limitBefore.count],
        ['newsletterLimitDays', limitBefore.days],
      ] as const) {
        await send(rootSession, 'PUT', `/api/root/shop-settings/${key}`, { value });
      }
    }
  });
});

describe('a draft that is not to be sent', () => {
  it('is deleted by the admin who runs the newsletters and leaves the list', async () => {
    // root gives an admin the right to run the newsletters; the admin drafts one and drops it
    const rootSession = await signIn(app, csrf, root);
    const given = await send(rootSession, 'PATCH', `/api/root/admins/${drafter.id}`, {
      canManageNewsletters: true,
    });
    expect(given.statusCode).toBe(200);
    const session = await signIn(app, csrf, drafter);
    const created = await send(session, 'POST', '/api/newsletters/campaigns', {
      name: 'Flow draft to drop',
      content: { subject: { en: 'Not this one' }, blocks: [] },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: number };
    const listed = async () =>
      (
        (await send(session, 'GET', '/api/newsletters/campaigns?limit=100')).json().items as {
          id: number;
        }[]
      ).map((one) => one.id);
    expect(await listed()).toContain(id);

    const dropped = await send(session, 'DELETE', `/api/newsletters/campaigns/${id}`);
    expect(dropped.statusCode).toBeLessThan(300);
    expect(await listed()).not.toContain(id);
    expect((await send(session, 'GET', `/api/newsletters/campaigns/${id}`)).statusCode).toBe(404);
  });
});
