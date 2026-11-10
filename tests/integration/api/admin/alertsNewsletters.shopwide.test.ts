import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { getRedis } from '@redis/client.js';
import { redisKeys } from '@redis/keys.js';
import {
  clearSendingHalt,
  markSendingHalted,
} from '@routes/api/newsletters/services/helpers/sendingHalt.helper.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { closeSessions, createUser, type TestUser } from '../../../helpers/factories.js';
import {
  campaignApi,
  campaignWithTotals,
  cancelledCampaign,
  draftOf,
  forgetCampaigns,
  type CampaignApi,
  type CampaignTotals,
} from '../../../helpers/newsletterCampaigns.js';
import { utc } from '../../../helpers/newsletterDb.js';
import { giveNewsletterRight } from '../../../helpers/newsletterManager.js';

// The alerts of the newsletters count what the list of the campaigns they name shows. The count is of
// the whole shop, so this file runs alone (shopwide) and reads the numbers before and after each step

let app: FastifyInstance;
let api: CampaignApi;
let csrf: Csrf;
let root: TestUser;
let manager: TestUser;
let plainAdmin: TestUser;
const userIds: number[] = [];
const scheduled: number[] = [];

const DAY = 86_400_000;
const HOUR = 3_600_000;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  api = campaignApi(app, csrf);
  root = await createUser({ role: 'ROOT' });
  manager = await createUser({ role: 'ADMIN' });
  plainAdmin = await createUser({ role: 'ADMIN' });
  userIds.push(root.id, manager.id, plainAdmin.id);
  await giveNewsletterRight(root.id, manager.id);
});

afterAll(async () => {
  try {
    await clearSendingHalt();
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

type Alert = {
  kind: string;
  count: number;
  subscribed: boolean;
  occurredAt: string | null;
  list: { path: string; query: Record<string, string> };
};

const get = (actor: TestUser, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: accessCookie(actor) } });

// the alert of a kind and the total of the list it names, read one after the other
async function alertAndList(actor: TestUser, kind: string) {
  const res = await get(actor, '/api/admin/alerts');
  expect(res.statusCode).toBe(200);
  const alert = (res.json().alerts as Alert[]).find((item) => item.kind === kind)!;

  const list = await get(
    actor,
    `${alert.list.path}?${new URLSearchParams({ ...alert.list.query, limit: '1' })}`,
  );
  expect(list.statusCode).toBe(200);

  return { count: alert.count, total: list.json().total as number };
}

const setThreshold = (actor: TestUser, kind: string, value: number) =>
  app.inject({
    method: 'PUT',
    url: `/api/admin/alerts/subscriptions/${kind}/threshold`,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload: { value },
  });

const wentOut = (
  totals: CampaignTotals,
  state: 'sending' | 'finished' | 'stopped' = 'finished',
  startedDaysAgo = 3,
) => campaignWithTotals(root, state, totals, utc(), { startedAt: utc(-startedDaysAgo * DAY) });

const scheduledIn = async (inMs: number) => {
  const id = await campaignWithTotals(root, 'scheduled', {}, utc(), { scheduledAt: utc(inMs) });
  scheduled.push(id);
  return id;
};

// the campaigns a share of the mails is over, and the ones it is not over, for a kind
const SHARE_CASES = [
  {
    kind: 'newsletter_undelivered',
    over: (): CampaignTotals[] => [
      { sent: 100, undelivered: 6 },
      { sent: 50, undelivered: 30 },
    ],
    under: (): CampaignTotals[] => [
      { sent: 100, undelivered: 5 },
      { sent: 2, undelivered: 1 },
      { sent: 19, undelivered: 19 },
      { sent: 0 },
    ],
  },
  {
    kind: 'newsletter_rejected',
    over: (): CampaignTotals[] => [
      { sent: 94, rejected: 6 },
      { sent: 0, rejected: 20 },
    ],
    under: (): CampaignTotals[] => [
      { sent: 95, rejected: 5 },
      { sent: 1, rejected: 1 },
      { sent: 0, rejected: 19 },
    ],
  },
  {
    kind: 'newsletter_complaints',
    // in thousandths: 4 of 1000 is over the 3 the server gives, 3 of 1000 is at it
    over: (): CampaignTotals[] => [
      { sent: 1000, complaints: 4 },
      { sent: 20, complaints: 20 },
    ],
    under: (): CampaignTotals[] => [
      { sent: 1000, complaints: 3 },
      { sent: 2, complaints: 1 },
      { sent: 19, complaints: 19 },
    ],
  },
] as const;

describe.each(SHARE_CASES)('the alert $kind', ({ kind, over, under }) => {
  // a campaign whose share is 60 (per cent, and for the complaints thousandths): over every
  // threshold up to 59 and not over 60
  const sixty = (): CampaignTotals[] =>
    kind === 'newsletter_complaints'
      ? [{ sent: 1000, complaints: 60 }]
      : [
          { sent: 100, undelivered: 60 },
          { sent: 40, rejected: 60 },
        ];

  it('counts the campaigns its list shows, before and after the campaigns come', async () => {
    for (const actor of [manager, root]) {
      const before = await alertAndList(actor, kind);
      expect(before.count).toBe(before.total);
    }
    const before = await alertAndList(manager, kind);

    for (const totals of over()) await wentOut(totals);
    for (const totals of under()) await wentOut(totals);
    // a campaign that went out long ago, and one that is only a draft or is waiting for its time
    await wentOut(over()[0]!, 'finished', 20);
    const draft = await draftOf(api, root);
    scheduled.push(draft);
    await scheduledIn(2 * HOUR);

    const after = await alertAndList(manager, kind);

    expect(after.count).toBe(before.count + over().length);
    expect(after.total).toBe(after.count);
    expect((await alertAndList(root, kind)).count).toBe(after.count);
  });

  it('counts for each admin by the threshold of that admin, and its list agrees', async () => {
    const strict = await createUser({ role: 'ADMIN' });
    const lenient = await createUser({ role: 'ADMIN' });
    userIds.push(strict.id, lenient.id);
    await giveNewsletterRight(root.id, strict.id);
    await giveNewsletterRight(root.id, lenient.id);
    for (const totals of sixty()) await wentOut(totals);
    expect((await setThreshold(strict, kind, 1)).statusCode).toBe(200);
    expect((await setThreshold(lenient, kind, 60)).statusCode).toBe(200);

    const tight = await alertAndList(strict, kind);
    const loose = await alertAndList(lenient, kind);

    expect(tight.count).toBe(tight.total);
    expect(loose.count).toBe(loose.total);
    expect(tight.count).toBeGreaterThan(loose.count);
  });
});

describe('the alert of a campaign that goes out for too long', () => {
  const kind = 'newsletter_running_long';

  it('counts the campaigns its list shows, before and after the campaigns come', async () => {
    const before = await alertAndList(manager, kind);
    expect(before.count).toBe(before.total);

    await wentOut({}, 'sending', 4);
    await wentOut({}, 'sending', 90);
    // a campaign that goes out for a day, and campaigns that went out and are over
    await wentOut({}, 'sending', 1);
    await wentOut({}, 'finished', 10);
    await wentOut({}, 'stopped', 10);
    await scheduledIn(-10 * DAY);

    const after = await alertAndList(manager, kind);

    expect(after.count).toBe(before.count + 2);
    expect(after.total).toBe(after.count);
  });

  it('counts for each admin by the threshold of that admin, and its list agrees', async () => {
    const strict = await createUser({ role: 'ADMIN' });
    userIds.push(strict.id);
    await giveNewsletterRight(root.id, strict.id);
    await wentOut({}, 'sending', 2);
    expect((await setThreshold(strict, kind, 1)).statusCode).toBe(200);

    const tight = await alertAndList(strict, kind);
    const normal = await alertAndList(manager, kind);

    expect(tight.count).toBe(tight.total);
    expect(tight.count).toBeGreaterThan(normal.count);
  });
});

describe('the alert of a campaign that is scheduled to start soon', () => {
  const kind = 'newsletter_starting_soon';

  it('counts the campaigns its list shows, before and after the campaigns come', async () => {
    const before = await alertAndList(manager, kind);
    expect(before.count).toBe(before.total);

    await scheduledIn(2 * HOUR);
    await scheduledIn(23 * HOUR);
    // a campaign whose time passed and that nothing started yet waits too
    await scheduledIn(-HOUR);
    // just after the hours of the threshold, and a day and more after
    await scheduledIn(24 * HOUR + 30 * 60_000);
    await scheduledIn(30 * HOUR);
    scheduled.push(await draftOf(api, root));
    await wentOut({}, 'sending', 0);

    const after = await alertAndList(manager, kind);

    expect(after.count).toBe(before.count + 3);
    expect(after.total).toBe(after.count);
  });
});

describe('the alert of a campaign the limit of the campaigns called off', () => {
  const kind = 'newsletter_cancelled_by_limit';

  it('counts the campaigns its list shows, before and after the campaigns come', async () => {
    const before = await alertAndList(manager, kind);
    expect(before.count).toBe(before.total);

    await cancelledCampaign(root, { by: 'limit', endedAt: utc(-DAY) });
    await cancelledCampaign(root, { by: 'limit', endedAt: utc(-6 * DAY) });
    // called off by a manager, called off by the limit long ago, and states that were not called off
    await cancelledCampaign(root);
    await cancelledCampaign(root, { by: 'limit', endedAt: utc(-30 * DAY) });
    await wentOut({});
    await scheduledIn(HOUR);

    const after = await alertAndList(manager, kind);

    expect(after.count).toBe(before.count + 2);
    expect(after.total).toBe(after.count);
    expect((await alertAndList(root, kind)).count).toBe(after.count);
  });

  it('counts for each admin by the days of that admin, and its list agrees', async () => {
    const tight = await createUser({ role: 'ADMIN' });
    userIds.push(tight.id);
    await giveNewsletterRight(root.id, tight.id);
    await cancelledCampaign(root, { by: 'limit', endedAt: utc(-4 * DAY) });
    expect((await setThreshold(tight, kind, 2)).statusCode).toBe(200);

    const narrow = await alertAndList(tight, kind);
    const normal = await alertAndList(manager, kind);

    expect(narrow.count).toBe(narrow.total);
    expect(normal.count).toBe(normal.total);
    expect(normal.count).toBeGreaterThan(narrow.count);
  });
});

// The stop of the sending worker is a mark in redis the pass writes when it stops on a problem of the
// whole stream (and clears when a pass goes through), so the alert is shared by everyone who sees the
// kind and shows the time of the last stop
describe('the alert of the stop of the sending worker', () => {
  const kind = 'newsletter_sending_halted';

  const alertOf = async (actor: TestUser) => {
    const res = await get(actor, '/api/admin/alerts');
    expect(res.statusCode).toBe(200);
    return (res.json().alerts as Alert[]).find((item) => item.kind === kind);
  };

  it('is quiet while the worker has not stopped: no count, no time', async () => {
    await clearSendingHalt();

    for (const actor of [manager, root]) {
      expect(await alertOf(actor)).toMatchObject({
        count: 0,
        occurredAt: null,
        subscribed: true,
        list: null,
      });
    }
  });

  it('tells root and the admin who may run the newsletters of a stop, with the time of the stop', async () => {
    const at = new Date(Date.now() - 90 * 60_000);
    await markSendingHalted('every_mail_refused', at);

    for (const actor of [manager, root]) {
      expect(await alertOf(actor)).toMatchObject({ count: 1, occurredAt: at.toISOString() });
    }
  });

  it('counts the stop in the total of the alerts', async () => {
    await markSendingHalted('access_refused', new Date());

    const before = await get(manager, '/api/admin/alerts');
    const sum = (before.json().alerts as Alert[]).reduce((n, item) => n + item.count, 0);
    expect(before.json().total).toBe(sum);

    await clearSendingHalt();
    const after = await get(manager, '/api/admin/alerts');
    expect(after.json().total).toBe(before.json().total - 1);
  });

  it('shows the time of the last stop when it stopped again', async () => {
    const first = new Date(Date.now() - 3 * HOUR);
    const second = new Date(Date.now() - HOUR);
    await markSendingHalted('provider_unavailable', first);
    await markSendingHalted('provider_unavailable', second);

    expect((await alertOf(manager))!.occurredAt).toBe(second.toISOString());
  });

  it('goes out once the mark is cleared (a pass went through)', async () => {
    await markSendingHalted('stream_broken', new Date());
    expect((await alertOf(manager))!.count).toBe(1);

    await clearSendingHalt();

    expect(await alertOf(manager)).toMatchObject({ count: 0, occurredAt: null });
  });

  it('is not told to an admin without the right, who has no such kind', async () => {
    await markSendingHalted('stream_broken', new Date());

    expect(await alertOf(plainAdmin)).toBeUndefined();
    const total = (await get(plainAdmin, '/api/admin/alerts')).json() as {
      total: number;
      alerts: Alert[];
    };
    expect(total.total).toBe(total.alerts.reduce((n, item) => n + item.count, 0));
    await clearSendingHalt();
  });

  it('is left out of the alerts an admin who turned the kind off follows', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    userIds.push(admin.id);
    await giveNewsletterRight(root.id, admin.id);
    await markSendingHalted('stream_broken', new Date());

    const off = await app.inject({
      method: 'DELETE',
      url: `/api/admin/alerts/subscriptions/${kind}`,
      headers: withCsrf(csrf, accessCookie(admin)),
    });
    expect(off.statusCode).toBe(200);

    const followed = await get(admin, '/api/admin/alerts?subscribed=true');
    expect((followed.json().alerts as Alert[]).map((item) => item.kind)).not.toContain(kind);
    expect(await alertOf(admin)).toMatchObject({ subscribed: false, count: 1 });
    await clearSendingHalt();
  });

  // a value nobody wrote is no stop: the alert stays quiet and the read does not fail
  it('treats a mark that cannot be read as no stop', async () => {
    const redis = await getRedis();
    await redis.set(redisKeys.newsletterSendingHalt, 'not json at all');
    try {
      expect(await alertOf(manager)).toMatchObject({ count: 0, occurredAt: null });

      await redis.set(redisKeys.newsletterSendingHalt, JSON.stringify({ at: 'yesterday' }));
      expect(await alertOf(manager)).toMatchObject({ count: 0, occurredAt: null });
    } finally {
      await clearSendingHalt();
    }
  });
});

describe('the alerts of an admin without the right', () => {
  it('do not change when the campaigns come, and show no kind of the newsletters', async () => {
    const read = async () => {
      const res = await get(plainAdmin, '/api/admin/alerts');
      expect(res.statusCode).toBe(200);
      return res.json() as { total: number; alerts: Alert[] };
    };
    const before = await read();

    await wentOut({ sent: 100, undelivered: 60 });
    await wentOut({}, 'sending', 9);
    await scheduledIn(HOUR);

    const after = await read();

    expect(after.total).toBe(before.total);
    expect(after.alerts.map((alert) => alert.kind)).toEqual(
      before.alerts.map((alert) => alert.kind),
    );
    expect(after.alerts.map((alert) => alert.kind).join()).not.toContain('newsletter_');
  });
});

// Last, while the file still holds its lock of the shop: the afterAll hooks run after the lock is
// given back, and drafts taken away then would change the total of campaigns a shopwide file counts
describe('the end of the file', () => {
  it('takes away the drafts and the scheduled campaigns it made', async () => {
    await forgetCampaigns(api, root, scheduled);
  });
});
