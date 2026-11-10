import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

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
import { giveNewsletterRight, takeNewsletterRight } from '../../../helpers/newsletterManager.js';
import { moveClock } from '../../../helpers/payments.js';

// The alerts of the newsletters: seven kinds that only root and the admins root allowed to run the
// newsletters see. Three watch the share of the mails of a campaign that were not accepted, did not
// arrive or were marked as spam (only when enough mails are counted for a share to mean anything; the
// complaints in thousandths), one a campaign that goes out for too long, one a campaign that is
// scheduled to start soon, one a campaign the limit of the campaigns called off. The cases of these six
// are campaigns: the list of the campaigns counts them with the same filters, so a test finds its own
// campaign in the list of the kind and among the cases the server lets an admin put aside. The seventh,
// the stop of the sending worker, is a single state (no cases, no threshold); it and the numbers of
// the whole shop are in alertsNewsletters.shopwide.test.ts

let app: FastifyInstance;
let csrf: Csrf;
let api: CampaignApi;
let root: TestUser;
let plainAdmin: TestUser;
let buyer: TestUser;
const userIds: number[] = [];
const scheduled: number[] = [];
let clock: { restore: () => void } | null = null;

const DAY = 86_400_000;
const HOUR = 3_600_000;

const KINDS = [
  'newsletter_undelivered',
  'newsletter_rejected',
  'newsletter_complaints',
  'newsletter_running_long',
  'newsletter_starting_soon',
  'newsletter_cancelled_by_limit',
  'newsletter_sending_halted',
] as const;

// the kinds with a threshold and with cases that have an id; the stop of the worker has neither
const CASE_KINDS = KINDS.filter((kind) => kind !== 'newsletter_sending_halted');

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

// an admin root allowed to run the newsletters
const newManager = async () => {
  const admin = await newUser({ role: 'ADMIN' });
  await giveNewsletterRight(root.id, admin.id);
  return admin;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  api = campaignApi(app, csrf);
  root = await newUser({ role: 'ROOT' });
  plainAdmin = await newUser({ role: 'ADMIN' });
  buyer = await newUser();
});

afterEach(() => {
  clock?.restore();
  clock = null;
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

type Alert = {
  kind: string;
  subscribed: boolean;
  count: number;
  dismissed: number;
  threshold: number | null;
  list: { path: string; query: Record<string, string> } | null;
};
type Alerts = { alerts: Alert[]; total: number; dismissalsAvailable: boolean };

const get = (actor: Pick<TestUser, 'id' | 'role'>, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: accessCookie(actor) } });

const change = (
  actor: Pick<TestUser, 'id' | 'role'>,
  method: 'PUT' | 'DELETE',
  url: string,
  payload?: object,
) =>
  app.inject({
    method,
    url,
    headers: withCsrf(csrf, accessCookie(actor)),
    ...(payload ? { payload } : {}),
  });

const alertsOf = async (actor: TestUser, query = '') => {
  const res = await get(actor, `/api/admin/alerts${query}`);
  expect(res.statusCode).toBe(200);
  return res.json() as Alerts;
};

const kindsOf = async (actor: TestUser, query = '') =>
  (await alertsOf(actor, query)).alerts.map((alert) => alert.kind);

const alertOf = async (actor: TestUser, kind: string) =>
  (await alertsOf(actor)).alerts.find((alert) => alert.kind === kind)!;

const subscriptionsOf = async (actor: TestUser) => {
  const res = await get(actor, '/api/admin/alerts/subscriptions');
  expect(res.statusCode).toBe(200);
  return res.json().items as Array<{ kind: string; subscribed: boolean; threshold: unknown }>;
};

const turn = (actor: TestUser, kind: string, on: boolean) =>
  change(actor, on ? 'PUT' : 'DELETE', `/api/admin/alerts/subscriptions/${kind}`);

const setThreshold = (actor: TestUser, kind: string, value: unknown) =>
  change(actor, 'PUT', `/api/admin/alerts/subscriptions/${kind}/threshold`, { value });

const resetThreshold = (actor: TestUser, kind: string) =>
  change(actor, 'DELETE', `/api/admin/alerts/subscriptions/${kind}/threshold`);

const dismiss = (actor: TestUser, kind: string, id: number | string, on = true) =>
  change(actor, on ? 'PUT' : 'DELETE', `/api/admin/alerts/dismissals/${kind}/${id}`);

const dismissalsOf = async (actor: TestUser) => {
  const res = await get(actor, '/api/admin/alerts/dismissals');
  expect(res.statusCode).toBe(200);
  return res.json().items as Array<{ kind: string; id: string }>;
};

// the campaigns the list of a kind shows for the actor (their threshold decides the filters)
async function listedIds(actor: TestUser, kind: string): Promise<number[]> {
  const { list } = await alertOf(actor, kind);
  const query = new URLSearchParams({ ...list!.query, limit: '100' });
  const res = await get(actor, `${list!.path}?${query}`);
  expect(res.statusCode).toBe(200);

  return (res.json().items as Array<{ id: number }>).map((item) => item.id);
}

// the alert counts the campaign for the actor: its list shows it, and the server lets the actor put
// it aside (which it does for a case the kind counts now only)
async function expectCounted(actor: TestUser, kind: string, id: number) {
  expect(await listedIds(actor, kind)).toContain(id);

  const res = await dismiss(actor, kind, id);
  expect(res.statusCode).toBe(200);
  expect((await alertOf(actor, kind)).dismissed).toBe(1);
  expect((await dismiss(actor, kind, id, false)).statusCode).toBe(200);
}

async function expectNotCounted(actor: TestUser, kind: string, id: number) {
  expect(await listedIds(actor, kind)).not.toContain(id);

  const res = await dismiss(actor, kind, id);
  expect(res.statusCode).toBe(404);
  expect(res.json()).toMatchObject({ errorCode: 'ALERT_ITEM_NOT_FOUND' });
}

const runClock = (ms: number) => {
  clock?.restore();
  clock = moveClock(ms);
};

// a campaign that went out `startedDaysAgo` days ago with the totals given, in a state a campaign
// that went out can be in
const wentOut = (
  totals: CampaignTotals,
  state: 'sending' | 'finished' | 'stopped' = 'finished',
  startedDaysAgo = 3,
) => campaignWithTotals(root, state, totals, utc(), { startedAt: utc(-startedDaysAgo * DAY) });

// a campaign scheduled for a time `inMs` from now (a negative number: a time that has passed and
// that nothing started yet); it is taken away at the end of the file
async function scheduledIn(inMs: number): Promise<number> {
  const id = await campaignWithTotals(root, 'scheduled', {}, utc(), {
    scheduledAt: utc(inMs),
  });
  scheduled.push(id);
  return id;
}

describe('who sees the alerts of the newsletters', () => {
  it('gives root the seven kinds between the kinds of every admin and the actions of the admins', async () => {
    const { alerts } = await alertsOf(root);
    const kinds = alerts.map((alert) => alert.kind);

    expect(kinds.slice(-8)).toEqual([...KINDS, 'admin_actions']);
    expect(kinds.indexOf('shop_locale_missing')).toBe(kinds.indexOf(KINDS[0]) - 1);
  });

  it('gives each kind a state to follow, no put-aside case and the threshold and list of its own', async () => {
    const { alerts } = await alertsOf(root);
    const of = (kind: string) => alerts.find((alert) => alert.kind === kind);

    expect(of('newsletter_undelivered')).toMatchObject({
      subscribed: true,
      dismissed: 0,
      threshold: 5,
      list: {
        path: '/api/newsletters/campaigns',
        query: { status: 'sending,finished,stopped', undeliveredOver: '5' },
      },
    });
    expect(of('newsletter_rejected')).toMatchObject({
      threshold: 5,
      list: { query: { status: 'sending,finished,stopped', rejectedOver: '5' } },
    });
    // the complaints are told in thousandths: 3 of a thousand mails, not 3 per cent
    expect(of('newsletter_complaints')).toMatchObject({
      threshold: 3,
      list: { query: { status: 'sending,finished,stopped', complaintsOver: '3' } },
    });
    expect(of('newsletter_running_long')).toMatchObject({
      threshold: 3,
      list: { path: '/api/newsletters/campaigns', query: { status: 'sending' } },
    });
    expect(of('newsletter_starting_soon')).toMatchObject({
      threshold: 24,
      list: { path: '/api/newsletters/campaigns', query: { status: 'scheduled' } },
    });
    expect(of('newsletter_running_long')!.list!.query.startedTo).toEqual(expect.any(String));
    expect(of('newsletter_starting_soon')!.list!.query.scheduledTo).toEqual(expect.any(String));
    expect(of('newsletter_cancelled_by_limit')).toMatchObject({
      subscribed: true,
      dismissed: 0,
      threshold: 7,
      list: {
        path: '/api/newsletters/campaigns',
        query: { status: 'cancelled', cancelReason: 'limit' },
      },
    });
    expect(of('newsletter_cancelled_by_limit')!.list!.query.cancelledFrom).toEqual(
      expect.any(String),
    );
    // the stop of the worker is a single state: no threshold, no list, the time of the stop apart
    expect(of('newsletter_sending_halted')).toMatchObject({
      subscribed: true,
      dismissed: 0,
      threshold: null,
      list: null,
    });
  });

  it('gives an admin root allowed the seven kinds and not the actions of the admins', async () => {
    const manager = await newManager();
    const kinds = await kindsOf(manager);

    expect(kinds.slice(-7)).toEqual([...KINDS]);
    expect(kinds).not.toContain('admin_actions');
  });

  it('gives an admin without the right none of the seven kinds', async () => {
    const kinds = await kindsOf(plainAdmin);

    for (const kind of KINDS) expect(kinds).not.toContain(kind);
    expect(await kindsOf(plainAdmin, '?subscribed=true')).not.toContain(KINDS[0]);
  });

  it('counts the total of an admin over the kinds the admin sees', async () => {
    for (const actor of [plainAdmin, await newManager(), root]) {
      const { alerts, total } = await alertsOf(actor);
      expect(total).toBe(alerts.reduce((sum, alert) => sum + alert.count, 0));
    }
  });

  // a visitor is the role GUEST, refused as a buyer is
  it('refuses a buyer and a visitor', async () => {
    const asBuyer = await get(buyer, '/api/admin/alerts');
    expect(asBuyer.statusCode).toBe(403);
    expect(asBuyer.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });

    const visitor = await app.inject({ method: 'GET', url: '/api/admin/alerts' });
    expect(visitor.statusCode).toBe(403);
    expect(visitor.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('starts showing the kinds to an admin the moment root allows the admin, in the session that is open', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    expect(await kindsOf(admin)).not.toContain(KINDS[0]);

    await giveNewsletterRight(root.id, admin.id);

    expect((await kindsOf(admin)).slice(-7)).toEqual([...KINDS]);
    expect((await subscriptionsOf(admin)).map((item) => item.kind).slice(-7)).toEqual([...KINDS]);
  });

  it('stops showing and counting the kinds the moment root takes the right, in the session that is open', async () => {
    const admin = await newManager();
    const id = await wentOut({ sent: 100, undelivered: 20 });
    expect((await kindsOf(admin)).slice(-7)).toEqual([...KINDS]);
    expect((await dismiss(admin, 'newsletter_undelivered', id)).statusCode).toBe(200);

    await takeNewsletterRight(root.id, admin.id);

    const after = await alertsOf(admin);
    expect(after.alerts.map((alert) => alert.kind)).toEqual(await kindsOf(plainAdmin));
    expect(after.total).toBe(after.alerts.reduce((sum, alert) => sum + alert.count, 0));
    expect((await subscriptionsOf(admin)).map((item) => item.kind)).not.toContain(KINDS[0]);
  });

  // the read of the cases put aside is the first read after the right is gone: it lists none of the
  // newsletters and forgets their marks, though the cases still wait
  it('lists none of the cases put aside for the newsletters once the right is gone, and forgets them', async () => {
    const admin = await newManager();
    const id = await wentOut({ sent: 100, undelivered: 20 });
    expect((await dismiss(admin, 'newsletter_undelivered', id)).statusCode).toBe(200);
    expect((await dismissalsOf(admin)).length).toBe(1);

    await takeNewsletterRight(root.id, admin.id);

    expect(await dismissalsOf(admin)).toEqual([]);
    await giveNewsletterRight(root.id, admin.id);
    expect(await dismissalsOf(admin)).toEqual([]);
    expect((await alertOf(admin, 'newsletter_undelivered')).dismissed).toBe(0);
  });

  // the read of the alerts is the first read after the right is gone: it forgets the marks of the
  // newsletters on its own
  it('forgets the cases put aside for the newsletters at the first read of the alerts after the right is gone', async () => {
    const admin = await newManager();
    const id = await wentOut({ sent: 100, undelivered: 20 });
    expect((await dismiss(admin, 'newsletter_undelivered', id)).statusCode).toBe(200);

    await takeNewsletterRight(root.id, admin.id);
    await alertsOf(admin);
    await giveNewsletterRight(root.id, admin.id);

    expect(await dismissalsOf(admin)).toEqual([]);
    expect((await alertOf(admin, 'newsletter_undelivered')).dismissed).toBe(0);
  });

  it('answers 404 for a kind of the newsletters to an admin who lost the right, on every route of the alerts', async () => {
    const admin = await newManager();
    const id = await wentOut({ sent: 100, undelivered: 20 });
    await takeNewsletterRight(root.id, admin.id);

    const answers = [
      await turn(admin, 'newsletter_undelivered', false),
      await turn(admin, 'newsletter_undelivered', true),
      await setThreshold(admin, 'newsletter_undelivered', 9),
      await resetThreshold(admin, 'newsletter_undelivered'),
      await dismiss(admin, 'newsletter_undelivered', id),
      await dismiss(admin, 'newsletter_undelivered', id, false),
    ];

    for (const res of answers) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'ALERT_KIND_NOT_FOUND' });
    }
  });

  it('answers 404 for a kind of the newsletters to an admin who never had the right', async () => {
    for (const kind of KINDS) {
      for (const res of [
        await turn(plainAdmin, kind, false),
        await setThreshold(plainAdmin, kind, 3),
        await dismiss(plainAdmin, kind, 1),
      ]) {
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ errorCode: 'ALERT_KIND_NOT_FOUND' });
      }
    }
  });

  // what an admin set and put aside while they had the right: the threshold they set is theirs and
  // stays; the case they put aside is forgotten with the right (they must not stay counted for it)
  it('keeps the threshold of an admin who lost the right and got it back, and forgets what was put aside', async () => {
    const admin = await newManager();
    const id = await wentOut({ sent: 100, undelivered: 20 });
    expect((await setThreshold(admin, 'newsletter_rejected', 7)).statusCode).toBe(200);
    expect((await dismiss(admin, 'newsletter_undelivered', id)).statusCode).toBe(200);

    await takeNewsletterRight(root.id, admin.id);
    await alertsOf(admin);
    await giveNewsletterRight(root.id, admin.id);

    expect(await alertOf(admin, 'newsletter_rejected')).toMatchObject({ threshold: 7 });
    expect(await dismissalsOf(admin)).toEqual([]);
    await expectCounted(admin, 'newsletter_undelivered', id);
  });
});

describe('the settings of the newsletter kinds', () => {
  it('names the threshold of each kind with its unit and its bounds', async () => {
    const items = await subscriptionsOf(await newManager());
    const byKind = Object.fromEntries(items.map((item) => [item.kind, item.threshold]));

    expect(byKind).toMatchObject({
      newsletter_undelivered: { value: 5, default: 5, min: 1, max: 100, unit: 'percent' },
      newsletter_rejected: { value: 5, default: 5, min: 1, max: 100, unit: 'percent' },
      newsletter_complaints: { value: 3, default: 3, min: 1, max: 1000, unit: 'permille' },
      newsletter_running_long: { value: 3, default: 3, min: 1, max: 365, unit: 'days' },
      newsletter_starting_soon: { value: 24, default: 24, min: 1, max: 720, unit: 'hours' },
      newsletter_cancelled_by_limit: { value: 7, default: 7, min: 1, max: 365, unit: 'days' },
      newsletter_sending_halted: null,
    });
    expect(items.filter((item) => KINDS.includes(item.kind as (typeof KINDS)[number]))).toEqual(
      KINDS.map((kind) => expect.objectContaining({ kind, subscribed: true })),
    );
  });

  it.each(CASE_KINDS)(
    'keeps the threshold a manager sets for %s for that manager only, until it is reset',
    async (kind) => {
      const first = await newManager();
      const second = await newManager();

      const set = await setThreshold(first, kind, 2);

      expect(set.statusCode).toBe(200);
      expect(set.json()).toMatchObject({ kind, threshold: { value: 2, custom: true } });
      expect(await alertOf(first, kind)).toMatchObject({ threshold: 2 });
      expect(await alertOf(second, kind)).not.toMatchObject({ threshold: 2 });

      const reset = await resetThreshold(first, kind);

      expect(reset.statusCode).toBe(200);
      expect(reset.json()).toMatchObject({ threshold: { custom: false } });
      expect((await alertOf(first, kind)).threshold).toBe((await alertOf(second, kind)).threshold);
    },
  );

  it.each([
    ['newsletter_undelivered', 101, 1, 100],
    ['newsletter_rejected', 101, 1, 100],
    ['newsletter_complaints', 1001, 1, 1000],
    ['newsletter_running_long', 366, 1, 365],
    ['newsletter_starting_soon', 721, 1, 720],
    ['newsletter_cancelled_by_limit', 366, 1, 365],
  ] as const)('refuses %s at %p and names the bounds', async (kind, value, min, max) => {
    const res = await setThreshold(await newManager(), kind, value);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'ALERT_THRESHOLD_INVALID',
      details: { min, max },
    });
  });

  // the complaints take the whole of thousandths: 101 is no more than 10 per cent and is allowed
  it('takes a threshold of the complaints up to 1000 and one of the shares in per cent up to 100', async () => {
    const manager = await newManager();

    for (const value of [1, 101, 1000]) {
      expect((await setThreshold(manager, 'newsletter_complaints', value)).statusCode).toBe(200);
    }
    expect((await setThreshold(manager, 'newsletter_undelivered', 100)).statusCode).toBe(200);
    expect((await setThreshold(manager, 'newsletter_undelivered', 101)).statusCode).toBe(400);
  });

  // the body takes whole numbers from 1: zero is no threshold of any kind
  it.each(CASE_KINDS)(
    'refuses a threshold of zero for %s as no whole number from 1',
    async (kind) => {
      const res = await setThreshold(await newManager(), kind, 0);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    },
  );

  // the stop of the worker is a state, not a count over a threshold
  it('has no threshold to set or to give back for the stop of the sending worker', async () => {
    const manager = await newManager();

    for (const res of [
      await setThreshold(manager, 'newsletter_sending_halted', 3),
      await resetThreshold(manager, 'newsletter_sending_halted'),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'ALERT_THRESHOLD_NOT_FOUND' });
    }
  });

  // and it has no case to put aside: it is one state, the same for everyone
  it('has no case to put aside for the stop of the sending worker', async () => {
    const res = await dismiss(await newManager(), 'newsletter_sending_halted', 1);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ALERT_KIND_NOT_FOUND' });
  });

  it('lets root and a manager turn a kind off and on, and keeps its threshold', async () => {
    for (const actor of [root, await newManager()]) {
      await setThreshold(actor, 'newsletter_rejected', 9);

      const off = await turn(actor, 'newsletter_rejected', false);
      expect(off.json()).toMatchObject({ subscribed: false, threshold: { value: 9 } });
      expect(await kindsOf(actor, '?subscribed=true')).not.toContain('newsletter_rejected');
      expect(await kindsOf(actor)).toContain('newsletter_rejected');

      const on = await turn(actor, 'newsletter_rejected', true);
      expect(on.json()).toMatchObject({ subscribed: true, threshold: { value: 9 } });
      await resetThreshold(actor, 'newsletter_rejected');
    }
  });

  it('turns a kind off for one admin only', async () => {
    const first = await newManager();
    const second = await newManager();

    await turn(first, 'newsletter_complaints', false);

    expect((await alertOf(first, 'newsletter_complaints')).subscribed).toBe(false);
    expect((await alertOf(second, 'newsletter_complaints')).subscribed).toBe(true);
  });
});

// the share of the mails of a campaign: what it is over, and the totals that make a share of a size.
// `scale` is how many mails make the whole of a share: the shares are told in per cent (100), the
// complaints in thousandths (1000)
const SHARES = [
  {
    kind: 'newsletter_undelivered',
    scale: 100,
    threshold: 5,
    // `bad` mails among `counted` ones: the share is over the mails the provider took
    totals: (bad: number, counted: number): CampaignTotals => ({
      sent: counted,
      undelivered: bad,
    }),
  },
  {
    kind: 'newsletter_rejected',
    scale: 100,
    threshold: 5,
    // over the mails the provider answered for: the ones it took and the ones it did not
    totals: (bad: number, counted: number): CampaignTotals => ({
      sent: counted - bad,
      rejected: bad,
    }),
  },
  {
    kind: 'newsletter_complaints',
    scale: 1000,
    threshold: 3,
    totals: (bad: number, counted: number): CampaignTotals => ({
      sent: counted,
      complaints: bad,
    }),
  },
] as const;

describe.each(SHARES)(
  'the share of the mails behind $kind',
  ({ kind, scale, threshold, totals }) => {
    it('counts a campaign whose share is over the threshold, and not one at it', async () => {
      const manager = await newManager();
      const at = await wentOut(totals(threshold, scale));
      const over = await wentOut(totals(threshold + 1, scale));
      const under = await wentOut(totals(threshold - 1, scale));

      await expectNotCounted(manager, kind, under);
      await expectNotCounted(manager, kind, at);
      await expectCounted(manager, kind, over);
    });

    // the comparison is done on whole numbers, not on rounded percents: a share just over is over
    it('counts a share just over the threshold on a large campaign', async () => {
      const manager = await newManager();
      const justOver = await wentOut(totals(threshold * 10 + 1, scale * 10));
      const justAt = await wentOut(totals(threshold * 10, scale * 10));

      await expectCounted(manager, kind, justOver);
      await expectNotCounted(manager, kind, justAt);
    });

    it('counts no share while fewer than 20 mails are counted, and counts it from the 20th', async () => {
      const manager = await newManager();
      // one mail of two is half of the mails, and tells nothing
      const oneOfTwo = await wentOut(totals(1, 2));
      const allOfNineteen = await wentOut(totals(19, 19));
      const allOfTwenty = await wentOut(totals(20, 20));

      await expectNotCounted(manager, kind, oneOfTwo);
      await expectNotCounted(manager, kind, allOfNineteen);
      await expectCounted(manager, kind, allOfTwenty);
    });

    it('counts nothing for a campaign without a bad mail', async () => {
      const manager = await newManager();

      await expectNotCounted(manager, kind, await wentOut(totals(0, scale * 10)));
      await expectNotCounted(manager, kind, await wentOut({}));
    });

    it.each(['sending', 'finished', 'stopped'] as const)(
      'counts a campaign that is %s',
      async (state) => {
        const manager = await newManager();

        await expectCounted(manager, kind, await wentOut(totals(threshold + 5, scale), state));
      },
    );

    it('counts a campaign for the admins whose threshold it is over, and for them only', async () => {
      const strict = await newManager();
      const lenient = await newManager();
      const equal = await newManager();
      const id = await wentOut(totals(threshold + 5, scale));
      const share = threshold + 5;
      await setThreshold(strict, kind, threshold);
      await setThreshold(lenient, kind, share + 1);
      await setThreshold(equal, kind, share);

      await expectCounted(strict, kind, id);
      await expectCounted(root, kind, id);
      await expectNotCounted(lenient, kind, id);
      // the share is at the threshold, not over it
      await expectNotCounted(equal, kind, id);
      // the list of an admin carries their own threshold
      expect((await alertOf(lenient, kind)).list!.query).toMatchObject({
        [`${kind.replace('newsletter_', '')}Over`]: String(share + 1),
      });
    });

    it('stops counting a campaign when the admin raises the threshold over its share, and counts it again when the threshold is given back', async () => {
      const manager = await newManager();
      const id = await wentOut(totals(threshold + 5, scale));
      await expectCounted(manager, kind, id);

      await setThreshold(manager, kind, threshold + 5);
      await expectNotCounted(manager, kind, id);

      await resetThreshold(manager, kind);
      await expectCounted(manager, kind, id);
    });

    // the share is watched while a campaign goes out and for two weeks after it started: a campaign of
    // last month would otherwise stay in the alert for good, and nothing can be done for it
    it('counts a campaign that started within two weeks, and not one that started earlier', async () => {
      const manager = await newManager();
      const recent = await wentOut(totals(threshold + 5, scale), 'finished', 13);
      const old = await wentOut(totals(threshold + 5, scale), 'finished', 15);

      await expectCounted(manager, kind, recent);
      await expectNotCounted(manager, kind, old);
    });

    it('stops counting a campaign by itself once it is two weeks old', async () => {
      const manager = await newManager();
      const id = await wentOut(totals(threshold + 5, scale), 'finished', 13);
      await expectCounted(manager, kind, id);

      runClock(2 * DAY);

      await expectNotCounted(manager, kind, id);
    });

    it('counts nothing for a campaign that has not gone out', async () => {
      const manager = await newManager();
      const draft = await draftOf(api, root);
      scheduled.push(draft);
      const waiting = await scheduledIn(2 * HOUR);

      await expectNotCounted(manager, kind, draft);
      await expectNotCounted(manager, kind, waiting);
    });
  },
);

// the complaints are the only share told in thousandths: the threshold is a part of a thousand mails
describe('the complaints, told in thousandths', () => {
  it('counts 4 complaints in 1000 mails and not 3, with the threshold the server gives (3)', async () => {
    const manager = await newManager();
    const four = await wentOut({ sent: 1000, complaints: 4 });
    const three = await wentOut({ sent: 1000, complaints: 3 });

    await expectCounted(manager, 'newsletter_complaints', four);
    await expectNotCounted(manager, 'newsletter_complaints', three);
  });

  // 3 per cent would be 30 in a thousand: the threshold is not in per cent
  it('does not take the threshold for a per cent: 30 in 1000 is far over 3', async () => {
    const manager = await newManager();
    const thirty = await wentOut({ sent: 1000, complaints: 30 });

    await expectCounted(manager, 'newsletter_complaints', thirty);
    await setThreshold(manager, 'newsletter_complaints', 30);
    await expectNotCounted(manager, 'newsletter_complaints', thirty);
    await setThreshold(manager, 'newsletter_complaints', 29);
    await expectCounted(manager, 'newsletter_complaints', thirty);
  });

  it('puts the threshold in the list it names, in thousandths too', async () => {
    const manager = await newManager();
    await setThreshold(manager, 'newsletter_complaints', 250);

    expect((await alertOf(manager, 'newsletter_complaints')).list!.query).toMatchObject({
      complaintsOver: '250',
    });
  });
});

describe('the share of the mails of a campaign, each kind over the mails of its own', () => {
  // one campaign, three shares: every mail that did not arrive was taken first, while a mail the
  // provider did not take was never in the mails that were taken
  it('counts the rejected mails over the mails taken and not taken, and the others over the mails taken', async () => {
    const manager = await newManager();
    // 90 taken, 10 not taken: 10 of 100 are rejected; none of the 90 taken is a problem
    const id = await wentOut({ sent: 90, rejected: 10 });

    await expectCounted(manager, 'newsletter_rejected', id);
    await expectNotCounted(manager, 'newsletter_undelivered', id);
    await expectNotCounted(manager, 'newsletter_complaints', id);
  });

  it('counts the three shares of a campaign each on its own', async () => {
    const manager = await newManager();
    const bad = await wentOut({ sent: 100, undelivered: 50, complaints: 5, rejected: 1 });

    await expectCounted(manager, 'newsletter_undelivered', bad);
    await expectCounted(manager, 'newsletter_complaints', bad);
    await expectNotCounted(manager, 'newsletter_rejected', bad);
  });

  it('counts the rejected mails of a campaign taken by none, over the mails not taken', async () => {
    const manager = await newManager();
    const refused = await wentOut({ rejected: 20 });
    const fewRefused = await wentOut({ rejected: 19 });

    await expectCounted(manager, 'newsletter_rejected', refused);
    await expectNotCounted(manager, 'newsletter_rejected', fewRefused);
  });
});

describe('a campaign that goes out for too long', () => {
  const kind = 'newsletter_running_long';

  it('counts a campaign that started before the days of the threshold, and not one that started later', async () => {
    const manager = await newManager();
    const late = await wentOut({}, 'sending', 4);
    const recent = await wentOut({}, 'sending', 2);

    await expectCounted(manager, kind, late);
    await expectNotCounted(manager, kind, recent);
  });

  it('counts a campaign a little past the days of the threshold, and not one a little before', async () => {
    const manager = await newManager();
    const justPast = await wentOut({}, 'sending', 3 + 1 / 24);
    const justBefore = await wentOut({}, 'sending', 3 - 1 / 24);

    await expectCounted(manager, kind, justPast);
    await expectNotCounted(manager, kind, justBefore);
  });

  it('counts a campaign for the admins whose threshold it is past, and for them only', async () => {
    const strict = await newManager();
    const lenient = await newManager();
    const id = await wentOut({}, 'sending', 2);
    await setThreshold(strict, kind, 1);
    await setThreshold(lenient, kind, 5);

    await expectCounted(strict, kind, id);
    await expectNotCounted(lenient, kind, id);
    await expectNotCounted(root, kind, id);
  });

  it('counts only a campaign that is still going out', async () => {
    const manager = await newManager();
    const finished = await wentOut({}, 'finished', 10);
    const stopped = await wentOut({}, 'stopped', 10);
    const scheduledOne = await scheduledIn(-10 * DAY);

    await expectNotCounted(manager, kind, finished);
    await expectNotCounted(manager, kind, stopped);
    await expectNotCounted(manager, kind, scheduledOne);
  });

  it('counts a campaign however long ago it started, as long as it goes out', async () => {
    const manager = await newManager();

    await expectCounted(manager, kind, await wentOut({}, 'sending', 90));
  });

  it('stops counting a campaign once a manager stops it', async () => {
    const manager = await newManager();
    const id = await wentOut({}, 'sending', 5);
    await expectCounted(manager, kind, id);

    expect((await api.stop(manager, id)).statusCode).toBe(200);

    await expectNotCounted(manager, kind, id);
  });

  it('counts a campaign by itself once the days of the threshold have passed', async () => {
    const manager = await newManager();
    const id = await wentOut({}, 'sending', 2);
    await expectNotCounted(manager, kind, id);

    runClock(2 * DAY);

    await expectCounted(manager, kind, id);
  });
});

describe('a campaign that is scheduled to start soon', () => {
  const kind = 'newsletter_starting_soon';

  it('counts a campaign that starts within the hours of the threshold, and not one that starts later', async () => {
    const manager = await newManager();
    const soon = await scheduledIn(2 * HOUR);
    const later = await scheduledIn(30 * HOUR);

    await expectCounted(manager, kind, soon);
    await expectNotCounted(manager, kind, later);
  });

  it('counts a campaign a little before the hours of the threshold, and not one a little after', async () => {
    const manager = await newManager();
    const justBefore = await scheduledIn(24 * HOUR - 30 * 60_000);
    const justAfter = await scheduledIn(24 * HOUR + 30 * 60_000);

    await expectCounted(manager, kind, justBefore);
    await expectNotCounted(manager, kind, justAfter);
  });

  it('counts a campaign for the admins whose threshold it is within, and for them only', async () => {
    const wide = await newManager();
    const tight = await newManager();
    const id = await scheduledIn(30 * HOUR);
    await setThreshold(wide, kind, 48);
    await setThreshold(tight, kind, 1);

    await expectCounted(wide, kind, id);
    await expectNotCounted(tight, kind, id);
    await expectNotCounted(root, kind, id);

    const near = await scheduledIn(30 * 60_000);
    await expectCounted(tight, kind, near);
  });

  // the time has come and nothing started the campaign: it waits, which is more to see, not less
  it('counts a campaign whose time has passed and that nothing started yet', async () => {
    const manager = await newManager();

    await expectCounted(manager, kind, await scheduledIn(-HOUR));
  });

  it('counts only a campaign that is scheduled', async () => {
    const manager = await newManager();
    const draft = await draftOf(api, root);
    scheduled.push(draft);
    const sending = await wentOut({}, 'sending', 0);
    const finished = await wentOut({}, 'finished', 0);

    await expectNotCounted(manager, kind, draft);
    await expectNotCounted(manager, kind, sending);
    await expectNotCounted(manager, kind, finished);
  });

  it('stops counting a campaign once a manager cancels it', async () => {
    const manager = await newManager();
    const id = await scheduledIn(2 * HOUR);
    await expectCounted(manager, kind, id);

    expect((await api.cancel(manager, id)).statusCode).toBe(200);

    await expectNotCounted(manager, kind, id);
  });

  it('counts a campaign by itself once the hours of the threshold come near', async () => {
    const manager = await newManager();
    const id = await scheduledIn(26 * HOUR);
    await expectNotCounted(manager, kind, id);

    runClock(3 * HOUR);

    await expectCounted(manager, kind, id);
  });
});

describe('a campaign the limit of the campaigns called off', () => {
  const kind = 'newsletter_cancelled_by_limit';

  it('counts a campaign the limit called off within the days of the threshold, and not an older one', async () => {
    const manager = await newManager();
    const recent = await cancelledCampaign(root, { by: 'limit', endedAt: utc(-3 * DAY) });
    const old = await cancelledCampaign(root, { by: 'limit', endedAt: utc(-9 * DAY) });

    await expectCounted(manager, kind, recent);
    await expectNotCounted(manager, kind, old);
  });

  it('counts a campaign a little past the days of the threshold, and not one a little before', async () => {
    const manager = await newManager();
    const justIn = await cancelledCampaign(root, { by: 'limit', endedAt: utc(-7 * DAY + HOUR) });
    const justOut = await cancelledCampaign(root, { by: 'limit', endedAt: utc(-7 * DAY - HOUR) });

    await expectCounted(manager, kind, justIn);
    await expectNotCounted(manager, kind, justOut);
  });

  // a manager who called a campaign off knows it: only the system's reason tells the manager
  it('counts only a campaign the system called off, not one a manager did, and no other state', async () => {
    const manager = await newManager();
    const byManager = await cancelledCampaign(root);
    const sent = await wentOut({});
    const waiting = await scheduledIn(HOUR);

    await expectNotCounted(manager, kind, byManager);
    await expectNotCounted(manager, kind, sent);
    await expectNotCounted(manager, kind, waiting);
  });

  it('counts a campaign for the admins whose days it is within, and for them only', async () => {
    const wide = await newManager();
    const tight = await newManager();
    const id = await cancelledCampaign(root, { by: 'limit', endedAt: utc(-3 * DAY) });
    await setThreshold(wide, kind, 30);
    await setThreshold(tight, kind, 2);

    await expectCounted(wide, kind, id);
    await expectNotCounted(tight, kind, id);
    await expectCounted(root, kind, id);
  });

  it('stops counting a campaign by itself once the days have passed', async () => {
    const manager = await newManager();
    const id = await cancelledCampaign(root, { by: 'limit', endedAt: utc(-6 * DAY) });
    await expectCounted(manager, kind, id);

    runClock(2 * DAY);

    await expectNotCounted(manager, kind, id);
  });

  it('lets the admin put the case aside, for that admin only', async () => {
    const first = await newManager();
    const second = await newManager();
    const id = await cancelledCampaign(root, { by: 'limit' });
    const before = (await alertOf(first, kind)).count;

    expect((await dismiss(first, kind, id)).statusCode).toBe(200);

    const after = await alertOf(first, kind);
    expect(after.count).toBe(before - 1);
    expect(after.dismissed).toBe(1);
    expect(await listedIds(first, kind)).toContain(id);
    expect((await alertOf(second, kind)).dismissed).toBe(0);
  });
});

describe('a case of the newsletters put aside', () => {
  it('leaves the count of the admin who put it aside, for that admin only', async () => {
    const first = await newManager();
    const second = await newManager();
    const id = await wentOut({ sent: 100, complaints: 30 });
    const before = (await alertOf(first, 'newsletter_complaints')).count;

    expect((await dismiss(first, 'newsletter_complaints', id)).statusCode).toBe(200);

    const after = await alertOf(first, 'newsletter_complaints');
    expect(after.count).toBe(before - 1);
    expect(after.dismissed).toBe(1);
    // the list still shows the case: putting aside is a mark for the admin
    expect(await listedIds(first, 'newsletter_complaints')).toContain(id);
    expect((await alertOf(second, 'newsletter_complaints')).dismissed).toBe(0);
    expect((await dismissalsOf(first)).map((item) => `${item.kind}:${item.id}`)).toEqual([
      `newsletter_complaints:${id}`,
    ]);
  });

  it('forgets the case once it is over', async () => {
    const manager = await newManager();
    const id = await scheduledIn(2 * HOUR);
    expect((await dismiss(manager, 'newsletter_starting_soon', id)).statusCode).toBe(200);

    await api.cancel(manager, id);

    expect(await dismissalsOf(manager)).toEqual([]);
  });
});

// Last, while the file still holds its lock of the shop: the afterAll hooks run after the lock is
// given back, and drafts taken away then would change the total of campaigns a shopwide file counts
describe('the end of the file', () => {
  it('takes away the drafts and the scheduled campaigns it made', async () => {
    await forgetCampaigns(api, root, scheduled);
  });
});
