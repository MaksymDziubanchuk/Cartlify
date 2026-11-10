import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie, sessionCookie, signIn, type Session } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';
import { BASE, arrange, forget, newsletterApi } from '../../helpers/newsletterApi.js';
import { campaignContent, newsletterDesk, reportOf } from '../../helpers/newsletterFlow.js';
import { deliverEvents } from '../../helpers/newsletterWebhook.js';

// What the managers of the newsletters see of a campaign that went out, and what they do about it.
// Root gives an admin the right; a campaign goes out to a crowd of readers, and SendGrid tells that
// some of the mails bounced and one reader marked a mail as spam. The admin with the right and root
// read the campaign in the alerts of the newsletters (the list of each alert names the campaign), the
// admin without the right sees none of them. The admin sets a threshold of the own, and the campaign
// leaves the alert of the admin while it stays in the alert of root; the threshold taken back, it
// returns. A campaign scheduled for the next hours is in the alert "starts soon" until the admin calls
// it off. A reader writes to support to be taken off the list: the admin finds the subscription,
// deletes it, and the reader is mailed no more. The next campaign is stopped after its first mails:
// those who have not got one never do. At the end root takes the right away and the admin, in the
// session already open, loses the area and the alerts at the next request. The thresholds, the shares
// and the states the alerts count are the tests of the alerts (api/admin); the route of the stop is a
// test of the routes (api/newsletters). *.shopwide: a campaign mails every subscription in force in the
// database, and a limit of the campaigns near the clock of the shop is set for the time of one step.

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
let manager: TestUser;
let plainAdmin: TestUser;
const emails: string[] = [];
const userIds: number[] = [];
// the campaigns this file leaves scheduled when it breaks half way: they are called off at the end
const planned: number[] = [];

const READERS = 24;
const HOUR = 3_600_000;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT', name: 'Watch Root' });
  manager = await createUser({ role: 'ADMIN', name: 'Watch Manager' });
  plainAdmin = await createUser({ role: 'ADMIN', name: 'Watch Plain' });
  userIds.push(root.id, manager.id, plainAdmin.id);
});

afterEach(async () => {
  // nothing stays scheduled whatever happened in the test
  for (const id of planned.splice(0)) {
    await app.inject({
      method: 'POST',
      url: `${BASE}/campaigns/${id}/cancel`,
      headers: withCsrf(csrf, accessCookie(root)),
    });
  }
  // the readers of a flow are not the audience of the next *.shopwide file: the addresses go before
  // the shop lock does, which is before afterAll
  await forget(emails.splice(0));
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const as = (session: Session) => ({ cookie: sessionCookie(session) });

const put = (session: Session, url: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PUT',
    url,
    headers: withCsrf(csrf, sessionCookie(session)),
    payload,
  });

type Alert = {
  kind: string;
  subscribed: boolean;
  count: number;
  threshold: number | null;
  list: { path: string; query: Record<string, string> } | null;
};

describe('the managers of the newsletters watch a campaign that went out', () => {
  it('see its bounces and its complaints in the alerts, set a threshold, delete a reader, stop a campaign and lose it all with the right', async () => {
    const api = newsletterApi(app, csrf);
    const rootSession = await signIn(app, csrf, root);
    const managerSession = await signIn(app, csrf, manager);
    const plainSession = await signIn(app, csrf, plainAdmin);
    const get = (session: Session, url: string) => api.get(url, as(session));
    const post = (session: Session, url: string, body?: Record<string, unknown>) =>
      api.post(url, body, as(session));

    // what the alerts of an admin say: the kinds of the newsletters, and the campaigns the list of a
    // kind names
    const alertsOf = async (session: Session) => {
      const res = await get(session, '/api/admin/alerts');
      expect(res.statusCode).toBe(200);
      return res.json().alerts as Alert[];
    };
    const newsletterKinds = async (session: Session) =>
      (await alertsOf(session))
        .map((alert) => alert.kind)
        .filter((kind) => kind.startsWith('newsletter_'));
    const casesOf = async (session: Session, kind: string): Promise<number[]> => {
      const alert = (await alertsOf(session)).find((item) => item.kind === kind)!;
      const res = await get(
        session,
        `${alert.list!.path}?${new URLSearchParams({ ...alert.list!.query, limit: '100' })}`,
      );
      expect(res.statusCode).toBe(200);
      return (res.json().items as { id: number }[]).map((item) => item.id);
    };

    // root gives the admin the right
    const given = await api.patch(
      `/api/root/admins/${manager.id}`,
      { canManageNewsletters: true },
      as(rootSession),
    );
    expect(given.statusCode).toBe(200);
    const desk = newsletterDesk(app, csrf, sessionCookie(managerSession));

    // the crowd of readers of the shop and the campaign that goes out to them
    const readers = [];
    for (let index = 0; index < READERS; index++) {
      const reader = await arrange({ source: 'form', status: 'active', locale: 'en' });
      emails.push(reader.email);
      readers.push(reader);
    }
    const first = await desk.launch('A');
    const total = first.mails.length;
    expect(total).toBeGreaterThanOrEqual(READERS);

    // SendGrid reports that some addresses do not exist and that one reader marked the mail as spam:
    // enough of them to be over the share the alerts start at (5 % of the mails that did not arrive,
    // 3 in a thousand of the complaints), whatever else is in the database
    const bounced = Math.ceil(total * 0.06);
    const complained = Math.max(1, Math.ceil(total * 0.02));
    expect(bounced + complained).toBeLessThan(READERS);
    const events = [
      ...readers.slice(0, bounced).map((reader) => reportOf(first.to(reader.email)[0]!, 'bounce')),
      ...readers
        .slice(bounced, bounced + complained)
        .map((reader) => reportOf(first.to(reader.email)[0]!, 'spamreport')),
    ];
    const reported = await deliverEvents(app, events);
    expect(reported.statusCode).toBe(200);
    expect(reported.json()).toEqual({ received: true, applied: events.length, skipped: 0 });

    // the summary the admin reads
    expect((await desk.campaign(first.id)).counters).toMatchObject({
      sent: total,
      undelivered: bounced,
      complaints: complained,
    });

    // the admin and root see the campaign in the alerts of the mails that did not arrive and of the
    // complaints, and in no other; the admin without the right sees none of the newsletters
    for (const session of [managerSession, rootSession]) {
      expect(await casesOf(session, 'newsletter_undelivered')).toContain(first.id);
      expect(await casesOf(session, 'newsletter_complaints')).toContain(first.id);
      expect(await casesOf(session, 'newsletter_rejected')).not.toContain(first.id);
    }
    expect(await newsletterKinds(plainSession)).toEqual([]);
    expect(await newsletterKinds(managerSession)).toEqual([
      'newsletter_undelivered',
      'newsletter_rejected',
      'newsletter_complaints',
      'newsletter_running_long',
      'newsletter_starting_soon',
      'newsletter_cancelled_by_limit',
      'newsletter_sending_halted',
    ]);

    // the admin sets a threshold above the share of this campaign: it leaves the alert of the admin,
    // not the one of root, and comes back when the threshold is taken back
    const share = (bounced * 100) / total;
    const above = Math.ceil(share);
    const raised = await put(
      managerSession,
      '/api/admin/alerts/subscriptions/newsletter_undelivered/threshold',
      { value: above },
    );
    expect(raised.statusCode).toBe(200);
    expect(
      (await alertsOf(managerSession)).find((alert) => alert.kind === 'newsletter_undelivered'),
    ).toMatchObject({ threshold: above });
    expect(await casesOf(managerSession, 'newsletter_undelivered')).not.toContain(first.id);
    expect(await casesOf(rootSession, 'newsletter_undelivered')).toContain(first.id);

    const taken = await api.delete(
      '/api/admin/alerts/subscriptions/newsletter_undelivered/threshold',
      as(managerSession),
    );
    expect(taken.statusCode).toBe(200);
    expect(await casesOf(managerSession, 'newsletter_undelivered')).toContain(first.id);

    // a campaign scheduled for the next hours is in the alert "starts soon" until the admin calls it
    // off; it is scheduled near the clock of the shop, so the limit of the campaigns is set wide for
    // this step
    const limit = await get(rootSession, '/api/admin/shop-settings');
    const limitBefore = {
      count: limit.json().newsletterLimitCount as number,
      days: limit.json().newsletterLimitDays as number,
    };
    try {
      expect(
        (await put(rootSession, '/api/root/shop-settings/newsletterLimitCount', { value: 100 }))
          .statusCode,
      ).toBe(200);
      expect(
        (await put(rootSession, '/api/root/shop-settings/newsletterLimitDays', { value: 1 }))
          .statusCode,
      ).toBe(200);

      const soon = await post(managerSession, `${BASE}/campaigns`, {
        name: 'Soon flow',
        content: campaignContent('S'),
      });
      expect(soon.statusCode).toBe(201);
      const soonId = soon.json().id as number;
      const timed = await post(managerSession, `${BASE}/campaigns/${soonId}/schedule`, {
        scheduledAt: new Date(Date.now() + 2 * HOUR).toISOString(),
      });
      expect(timed.statusCode).toBe(200);
      planned.push(soonId);

      for (const session of [managerSession, rootSession]) {
        expect(await casesOf(session, 'newsletter_starting_soon')).toContain(soonId);
      }
      expect(await newsletterKinds(plainSession)).toEqual([]);

      const called = await post(managerSession, `${BASE}/campaigns/${soonId}/cancel`);
      expect(called.statusCode).toBe(200);
      planned.splice(0);
      for (const session of [managerSession, rootSession]) {
        expect(await casesOf(session, 'newsletter_starting_soon')).not.toContain(soonId);
      }
    } finally {
      for (const [key, value] of [
        ['newsletterLimitCount', limitBefore.count],
        ['newsletterLimitDays', limitBefore.days],
      ] as const) {
        await put(rootSession, `/api/root/shop-settings/${key}`, { value });
      }
    }

    // a reader writes to support to be taken off the list: the admin finds the subscription by the
    // address and erases it: the address is made anonymous in place and nothing is deleted
    const leaver = readers[READERS - 1]!;
    const found = await desk.subscribers(leaver.email);
    expect(found).toEqual([expect.objectContaining({ status: 'active', source: 'form' })]);
    const removed = await api.delete(`${BASE}/subscribers/${found[0]!.id}`, as(managerSession));
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ erased: true, subscriptions: 1 });
    expect(await desk.subscribers(leaver.email)).toEqual([]);

    // the next campaign goes out half way and the admin stops it: the pass has sent three mails and
    // the daily limit holds the rest; after the stop, even with the limit lifted, nobody else is mailed
    const day = desk.slot();
    const made = await post(managerSession, `${BASE}/campaigns`, {
      name: 'Stopped flow',
      content: campaignContent('B'),
    });
    expect(made.statusCode).toBe(201);
    const secondId = made.json().id as number;
    expect(
      (
        await post(managerSession, `${BASE}/campaigns/${secondId}/schedule`, {
          scheduledAt: day.toISOString(),
        })
      ).statusCode,
    ).toBe(200);
    planned.push(secondId);

    const half = await desk.pass([secondId], day, { dailyLimit: 3 });
    expect(half.summary).toMatchObject({ reason: 'daily_limit', launched: 1, sent: 3 });
    expect(half.mails).toHaveLength(3);
    const going = await desk.campaign(secondId);
    expect(going.status).toBe('sending');
    expect(going.counters.sent).toBe(3);
    expect(going.counters.planned).toBeGreaterThan(3);

    const stopped = await post(managerSession, `${BASE}/campaigns/${secondId}/stop`);
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ id: secondId, status: 'stopped' });
    planned.splice(0);

    const rest = await desk.pass([secondId], day);
    expect(rest.summary).toMatchObject({ reason: 'done', launched: 0, claimed: 0, sent: 0 });
    expect(rest.mails).toEqual([]);
    const after = await desk.campaign(secondId);
    expect(after.status).toBe('stopped');
    expect(after.counters).toMatchObject({ planned: going.counters.planned, sent: 3 });

    // those who were taken off, who bounced or who complained have no mail of either campaign; of
    // the ones who are left, three have the second campaign and the rest never will
    const mailed = new Set(half.mails.map((mail) => mail.to[0]));
    expect(mailed.has(leaver.email)).toBe(false);
    for (const reader of readers.slice(0, bounced + complained)) {
      expect(mailed.has(reader.email)).toBe(false);
    }
    expect(readers.filter((reader) => !mailed.has(reader.email)).length).toBeGreaterThan(0);

    // root reads what the admin did: the erasure of the subscriber by its number, the campaign
    // scheduled and stopped
    const deleted = await get(
      rootSession,
      `/api/admin/audit-log?entityType=newsletter_subscriber&entityId=${found[0]!.id}`,
    );
    expect(deleted.statusCode).toBe(200);
    const deletedLines = deleted.json().items as { event: string; actorId: number }[];
    expect(deletedLines.map((line) => [line.event, line.actorId])).toEqual([
      ['newsletter.subscriber_erased', manager.id],
    ]);
    expect(JSON.stringify(deletedLines)).not.toContain(leaver.email);
    const stopLog = await get(
      rootSession,
      `/api/admin/audit-log?entityType=newsletter_campaign&entityId=${secondId}&sortBy=id&sortOrder=asc`,
    );
    expect(
      (stopLog.json().items as { event: string; actorId: number }[]).map((line) => [
        line.event,
        line.actorId,
      ]),
    ).toEqual([
      ['newsletter.campaign_created', manager.id],
      ['newsletter.campaign_scheduled', manager.id],
      ['newsletter.campaign_stopped', manager.id],
    ]);

    // root takes the right away: in the session already open the admin loses the area and the alerts
    // at the next request, and root keeps both
    const revoked = await api.patch(
      `/api/root/admins/${manager.id}`,
      { canManageNewsletters: false },
      as(rootSession),
    );
    expect(revoked.statusCode).toBe(200);
    expect((await get(managerSession, '/api/users/me')).json()).toMatchObject({
      canManageNewsletters: false,
    });
    const refused = await get(managerSession, `${BASE}/campaigns/${first.id}`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ errorCode: 'NEWSLETTER_MANAGER_REQUIRED' });
    expect(await newsletterKinds(managerSession)).toEqual([]);
    expect(await casesOf(rootSession, 'newsletter_undelivered')).toContain(first.id);
    expect(desk.problems()).toEqual([]);
  });
});
