import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf } from '../../../helpers/csrf.js';
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
import {
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../../helpers/newsletterStaff.js';

// The filters of the list of campaigns the alerts of the newsletters send to (GET
// /api/newsletters/campaigns): when a campaign started, when it is scheduled for, and the share of its
// mails that were not taken, did not arrive or were complained of. The list is of the whole shop, so a
// test looks for its own campaigns in it, by their ids; the numbers are in the shopwide files

let app: FastifyInstance;
let staff: NewsletterStaff;
let api: CampaignApi;
const drafts: number[] = [];

const DAY = 86_400_000;
const HOUR = 3_600_000;

beforeAll(async () => {
  app = await startApp();
  api = campaignApi(app, await getCsrf(app));
  staff = await createNewsletterStaff();
});

afterAll(async () => {
  try {
    await closeStaff(staff);
  } finally {
    await stopApp();
  }
});

// the ids of the campaigns the list gives for a query (the newest first, so the campaigns a test just
// made are on the first page)
async function idsFor(query: string): Promise<number[]> {
  const res = await api.list(staff.manager, `${query}&limit=100`);
  expect(res.statusCode).toBe(200);

  return (res.json().items as Array<{ id: number }>).map((item) => item.id);
}

const wentOut = (
  totals: CampaignTotals,
  state: 'sending' | 'finished' | 'stopped' = 'finished',
  startedDaysAgo = 3,
) =>
  campaignWithTotals(staff.root, state, totals, utc(), { startedAt: utc(-startedDaysAgo * DAY) });

async function scheduledIn(inMs: number): Promise<number> {
  const id = await campaignWithTotals(staff.root, 'scheduled', {}, utc(), {
    scheduledAt: utc(inMs),
  });
  drafts.push(id);
  return id;
}

const iso = (offsetMs: number) => encodeURIComponent(new Date(Date.now() + offsetMs).toISOString());

describe('the filters startedFrom and startedTo', () => {
  it('keep the campaigns that started in the period, from taken in and to left out', async () => {
    const old = await wentOut({}, 'finished', 20);
    const middle = await wentOut({}, 'finished', 5);
    const recent = await wentOut({}, 'sending', 1);

    const since = await idsFor(`startedFrom=${iso(-7 * DAY)}`);
    expect(since).toEqual(expect.arrayContaining([middle, recent]));
    expect(since).not.toContain(old);

    const before = await idsFor(`startedTo=${iso(-3 * DAY)}`);
    expect(before).toEqual(expect.arrayContaining([old, middle]));
    expect(before).not.toContain(recent);

    const between = await idsFor(`startedFrom=${iso(-7 * DAY)}&startedTo=${iso(-3 * DAY)}`);
    expect(between).toContain(middle);
    expect(between).not.toContain(old);
    expect(between).not.toContain(recent);
  });

  it('take the moment of the start itself in with from and leave it out with to', async () => {
    const id = await wentOut({}, 'finished', 4);
    const { startedAt } = (await api.get(staff.manager, id)).json() as { startedAt: string };
    const at = encodeURIComponent(startedAt);

    expect(await idsFor(`startedFrom=${at}`)).toContain(id);
    expect(await idsFor(`startedTo=${at}`)).not.toContain(id);
  });

  it('leave out the campaigns that have not started', async () => {
    const draft = await draftOf(api, staff.root);
    drafts.push(draft);
    const waiting = await scheduledIn(2 * HOUR);

    const all = await idsFor(`startedFrom=${iso(-365 * DAY)}`);
    const before = await idsFor(`startedTo=${iso(365 * DAY)}`);

    for (const found of [all, before]) {
      expect(found).not.toContain(draft);
      expect(found).not.toContain(waiting);
    }
  });

  it('work with the state', async () => {
    const stopped = await wentOut({}, 'stopped', 5);
    const finished = await wentOut({}, 'finished', 5);

    const found = await idsFor(`status=stopped&startedFrom=${iso(-7 * DAY)}`);

    expect(found).toContain(stopped);
    expect(found).not.toContain(finished);
  });
});

describe('the filter scheduledTo', () => {
  it('keeps the campaigns scheduled before the time, those whose time has passed too', async () => {
    const soon = await scheduledIn(2 * HOUR);
    const later = await scheduledIn(30 * HOUR);
    const passed = await scheduledIn(-HOUR);

    const found = await idsFor(`status=scheduled&scheduledTo=${iso(24 * HOUR)}`);

    expect(found).toEqual(expect.arrayContaining([soon, passed]));
    expect(found).not.toContain(later);
  });

  it('leaves out the time itself', async () => {
    const id = await scheduledIn(5 * HOUR);
    const { scheduledAt } = (await api.get(staff.manager, id)).json() as { scheduledAt: string };
    const at = encodeURIComponent(scheduledAt);

    expect(await idsFor(`scheduledTo=${at}`)).not.toContain(id);
    expect(await idsFor(`scheduledTo=${iso(5 * HOUR + 1000)}`)).toContain(id);
  });

  it('leaves out the draft, which has no time', async () => {
    const draft = await draftOf(api, staff.root);
    drafts.push(draft);

    expect(await idsFor(`scheduledTo=${iso(365 * DAY)}`)).not.toContain(draft);
  });
});

describe('the filters undeliveredOver, rejectedOver and complaintsOver', () => {
  // the share is over the mails the provider took (the rejected: the ones it took and the ones it did
  // not), and only when at least 20 mails are counted. The first two are told in per cent, the
  // complaints in thousandths (a complaint is a rare thing): `unit` is how many mails make the whole
  const FILTERS = [
    [
      'undeliveredOver',
      100,
      (bad: number, counted: number) => ({ sent: counted, undelivered: bad }),
    ],
    [
      'rejectedOver',
      100,
      (bad: number, counted: number) => ({ sent: counted - bad, rejected: bad }),
    ],
    [
      'complaintsOver',
      1000,
      (bad: number, counted: number) => ({ sent: counted, complaints: bad }),
    ],
  ] as const;

  it.each(FILTERS)(
    '%s keeps the campaigns whose share is over the number given',
    async (name, unit, totals) => {
      const over = await wentOut(totals(11, unit));
      const at = await wentOut(totals(10, unit));
      const under = await wentOut(totals(9, unit));

      const found = await idsFor(`${name}=10`);

      expect(found).toContain(over);
      expect(found).not.toContain(at);
      expect(found).not.toContain(under);
    },
  );

  it.each(FILTERS)(
    '%s compares whole numbers: a hundredth over is over',
    async (name, unit, totals) => {
      const over = await wentOut(totals(101, unit * 10));
      const at = await wentOut(totals(100, unit * 10));

      const found = await idsFor(`${name}=10`);

      expect(found).toContain(over);
      expect(found).not.toContain(at);
    },
  );

  // the complaints are in thousandths: 5 of 1000 is over 4 and not over 5, and 1 per cent is 10
  it('tells the complaints in thousandths, not in per cent', async () => {
    const five = await wentOut({ sent: 1000, complaints: 5 });
    const eleven = await wentOut({ sent: 1000, complaints: 11 });

    const over4 = await idsFor('complaintsOver=4');
    const over5 = await idsFor('complaintsOver=5');
    const over10 = await idsFor('complaintsOver=10');
    const over1000 = await idsFor('complaintsOver=1000');

    expect(over4).toContain(five);
    expect(over5).not.toContain(five);
    expect(over10).toContain(eleven);
    expect(over10).not.toContain(five);
    expect(over1000).not.toContain(eleven);
  });

  it('keeps the other two shares in per cent: 5 of 1000 is not over 1 per cent', async () => {
    const five = await wentOut({ sent: 1000, undelivered: 5 });
    const twenty = await wentOut({ sent: 1000, undelivered: 20 });

    const found = await idsFor('undeliveredOver=1');

    expect(found).toContain(twenty);
    expect(found).not.toContain(five);
  });

  it.each(FILTERS)('%s leaves out a share of fewer than 20 mails', async (name, _unit, totals) => {
    const oneOfTwo = await wentOut(totals(1, 2));
    const nineteen = await wentOut(totals(19, 19));
    const twenty = await wentOut(totals(20, 20));

    const found = await idsFor(`${name}=50`);

    expect(found).not.toContain(oneOfTwo);
    expect(found).not.toContain(nineteen);
    expect(found).toContain(twenty);
  });

  it('keeps the campaigns that pass every share asked, the shares together', async () => {
    const both = await wentOut({ sent: 100, undelivered: 30, complaints: 30 });
    const onlyUndelivered = await wentOut({ sent: 100, undelivered: 30 });
    const onlyComplaints = await wentOut({ sent: 100, complaints: 30 });

    const found = await idsFor('undeliveredOver=20&complaintsOver=20');

    expect(found).toContain(both);
    expect(found).not.toContain(onlyUndelivered);
    expect(found).not.toContain(onlyComplaints);
  });

  it('work with the state and the start, the way the alerts ask', async () => {
    const recent = await wentOut({ sent: 100, undelivered: 30 }, 'finished', 5);
    const old = await wentOut({ sent: 100, undelivered: 30 }, 'finished', 20);
    const sending = await wentOut({ sent: 100, undelivered: 30 }, 'sending', 5);

    const found = await idsFor(
      `status=sending,finished,stopped&startedFrom=${iso(-14 * DAY)}&undeliveredOver=20`,
    );

    expect(found).toEqual(expect.arrayContaining([recent, sending]));
    expect(found).not.toContain(old);
  });

  // the pages of a filtered list: the filter and the cursor together lose and repeat nothing
  it('page through the campaigns of the filter, each once, the newest first', async () => {
    const made = [
      await wentOut({ sent: 100, undelivered: 40 }),
      await wentOut({ sent: 100, undelivered: 41 }),
      await wentOut({ sent: 100, undelivered: 42 }),
    ];
    const seen: Array<{ id: number; counters: { sent: number; undelivered: number } }> = [];
    let cursor: string | null = null;

    do {
      const res = await api.list(
        staff.manager,
        `undeliveredOver=30&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(res.statusCode).toBe(200);
      const page = res.json() as {
        items: typeof seen;
        nextCursor: string | null;
      };
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    const ids = seen.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(ids).toEqual(expect.arrayContaining(made));
    for (const item of seen) {
      expect(item.counters.undelivered * 100).toBeGreaterThan(30 * item.counters.sent);
    }
  });
});

describe('the filters cancelReason and cancelledFrom', () => {
  it('cancelReason=limit keeps the campaigns the limit called off, not the ones a manager did', async () => {
    const byLimit = await cancelledCampaign(staff.manager, { by: 'limit' });
    const byManager = await cancelledCampaign(staff.manager);
    const sent = await wentOut({});

    const found = await idsFor('cancelReason=limit');

    expect(found).toContain(byLimit);
    expect(found).not.toContain(byManager);
    expect(found).not.toContain(sent);
  });

  it('cancelledFrom keeps the campaigns called off at that time or later, the time taken in', async () => {
    const old = await cancelledCampaign(staff.manager, { by: 'limit', endedAt: utc(-20 * DAY) });
    const recent = await cancelledCampaign(staff.manager, { by: 'limit', endedAt: utc(-2 * DAY) });
    const never = await wentOut({});

    const found = await idsFor(`cancelReason=limit&cancelledFrom=${iso(-7 * DAY)}`);

    expect(found).toContain(recent);
    expect(found).not.toContain(old);
    expect(found).not.toContain(never);

    const { cancelledAt } = (await api.get(staff.manager, recent)).json() as {
      cancelledAt: string;
    };
    expect(await idsFor(`cancelledFrom=${encodeURIComponent(cancelledAt)}`)).toContain(recent);
  });

  it('work with the state, the way the alert asks', async () => {
    const byLimit = await cancelledCampaign(staff.manager, { by: 'limit' });

    const found = await idsFor(
      `status=cancelled&cancelReason=limit&cancelledFrom=${iso(-7 * DAY)}`,
    );

    expect(found).toContain(byLimit);
    expect(await idsFor('status=scheduled&cancelReason=limit')).not.toContain(byLimit);
  });
});

describe('the validation of the filters', () => {
  it.each([
    'undeliveredOver=0',
    'undeliveredOver=101',
    'undeliveredOver=-1',
    'undeliveredOver=five',
    'undeliveredOver=5.5',
    'rejectedOver=0',
    'rejectedOver=101',
    'complaintsOver=0',
    'complaintsOver=1001',
    'complaintsOver=-1',
    'complaintsOver=three',
    'complaintsOver=2.5',
    'cancelReason=other',
    'cancelReason=',
    'cancelledFrom=yesterday',
    'startedFrom=yesterday',
    'startedTo=2026-13-45',
    'scheduledTo=soon',
  ])('refuses %s', async (query) => {
    const res = await api.list(staff.manager, query);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('takes a share of 1 and of 100, and of the complaints from 1 to 1000', async () => {
    for (const query of [
      'undeliveredOver=1',
      'rejectedOver=100',
      'complaintsOver=1',
      'complaintsOver=100',
      'complaintsOver=101',
      'complaintsOver=1000',
      'cancelReason=limit',
    ]) {
      expect((await api.list(staff.manager, query)).statusCode).toBe(200);
    }
  });

  it('refuses the filters to an admin without the right', async () => {
    const res = await api.list(staff.plainAdmin, 'undeliveredOver=5');

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_MANAGER_REQUIRED' });
  });
});

// Last, while the file still holds its lock of the shop: the afterAll hooks run after the lock is
// given back, and drafts taken away then would change the total of campaigns a shopwide file counts
describe('the end of the file', () => {
  it('takes away the drafts and the scheduled campaigns it made', async () => {
    await forgetCampaigns(api, staff.root, drafts);
  });
});
