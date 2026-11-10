import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  bodyOf,
  campaignApi,
  cancelledCampaign,
  contentOf,
  draftOf,
  forgetCampaigns,
  moveTo,
  type CampaignApi,
} from '../../../helpers/newsletterCampaigns.js';
import {
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../../helpers/newsletterStaff.js';
import { inOwnerTx } from '../../../helpers/ownerDb.js';

// GET /api/newsletters/campaigns and GET /api/newsletters/campaigns/:campaignId. The list has the
// campaigns of every manager and no content; one campaign has everything. The exact numbers of the
// list, which every other file of the run changes, are the test of campaignsList.shopwide

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
let api: CampaignApi;
const made: number[] = [];

const draft = async (user = staff.manager, payload: Record<string, unknown> = {}) => {
  const id = await draftOf(api, user, payload);
  made.push(id);
  return id;
};

// every page of the list from the first, until the cursor ends; what the pages held, in order
async function walk(query: string, user = staff.manager) {
  const items: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    const res = await api.list(user, `${query}${cursor ? `&cursor=${cursor}` : ''}`);
    expect(res.statusCode).toBe(200);
    const page = bodyOf(res) as { items: Record<string, unknown>[]; nextCursor: string | null };
    items.push(...page.items);
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor && pages < 500);

  return items;
}

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
  } finally {
    await stopApp();
  }
});

describe('GET /api/newsletters/campaigns/:campaignId', () => {
  it('gives the whole campaign: the content, the totals and the makers', async () => {
    const content = contentOf('read');
    const id = await draft(staff.manager, { name: 'Whole one', content, missingLocale: 'skip' });

    const res = await api.get(staff.manager, id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id,
      name: 'Whole one',
      status: 'draft',
      scheduledAt: null,
      missingLocale: 'skip',
      content,
      counters: {
        planned: 0,
        sent: 0,
        rejected: 0,
        undelivered: 0,
        complaints: 0,
        unsubscribed: 0,
      },
      createdById: staff.manager.id,
      updatedById: staff.manager.id,
      copiedFromId: null,
      startedAt: null,
      finishedAt: null,
      stoppedAt: null,
      cancelledAt: null,
      cancelReason: null,
    });
  });

  it('gives the same campaign that was made', async () => {
    const created = await api.create(staff.manager, {
      name: 'Same one',
      content: contentOf('same'),
    });
    made.push(created.json().id);

    expect((await api.get(staff.manager, created.json().id)).json()).toEqual(created.json());
  });

  it('shows the totals and the times of a campaign that went out', async () => {
    const id = await draft();
    await moveTo(staff.manager, id, 'finished');
    await inOwnerTx(
      (db) =>
        db.rows(
          `update cartlify.newsletter_campaigns
           set "sentCount" = 11, "rejectedCount" = 2, "undeliveredCount" = 3,
               "complaintCount" = 4, "unsubscribedCount" = 5
           where id = $1`,
          id,
        ),
      { commit: true },
    );

    const res = await api.get(staff.manager, id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'finished',
      counters: {
        planned: 1,
        sent: 11,
        rejected: 2,
        undelivered: 3,
        complaints: 4,
        unsubscribed: 5,
      },
    });
    expect(res.json().scheduledAt).not.toBeNull();
    expect(res.json().startedAt).not.toBeNull();
    expect(res.json().finishedAt).not.toBeNull();
    expect(res.json().stoppedAt).toBeNull();
    expect(res.json().cancelledAt).toBeNull();
    expect(res.json().cancelReason).toBeNull();
  });

  // a campaign the limit of the campaigns called off when its time came says why, so the manager
  // knows to copy it and schedule it again; one a manager called off says nothing
  it('says why a campaign was called off: the limit, or nobody (a manager did)', async () => {
    const byLimit = await cancelledCampaign(staff.manager, { by: 'limit' });
    const byManager = await cancelledCampaign(staff.manager);

    const limited = await api.get(staff.manager, byLimit);
    const manual = await api.get(staff.manager, byManager);

    expect(limited.json()).toMatchObject({ status: 'cancelled', cancelReason: 'limit' });
    expect(limited.json().cancelledAt).not.toBeNull();
    expect(manual.json()).toMatchObject({ status: 'cancelled', cancelReason: null });

    // the row of the list has it too
    const listed = await walk('limit=100');
    const row = (id: number) => listed.find((item) => item.id === id);
    expect(row(byLimit)).toMatchObject({ status: 'cancelled', cancelReason: 'limit' });
    expect(row(byManager)).toMatchObject({ status: 'cancelled', cancelReason: null });
    expect(listed.every((item) => 'cancelReason' in item)).toBe(true);
  });

  it('shows the campaign of one manager to another and to root', async () => {
    const id = await draft(staff.manager);

    expect((await api.get(staff.root, id)).json().createdById).toBe(staff.manager.id);

    const byRoot = await draft(staff.root);
    expect((await api.get(staff.manager, byRoot)).json().createdById).toBe(staff.root.id);
  });

  it('answers 404 for a campaign there is none of', async () => {
    const res = await api.get(staff.manager, 2_147_483_647);

    expect(res.statusCode).toBe(404);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_FOUND');
  });

  it.each(['0', '-1', 'abc', '1.5', '1e3', '2147483648', '01'])(
    'refuses %s as an id',
    async (id) => {
      const res = await api.get(staff.manager, id);

      expect(res.statusCode).toBe(400);
      expect(['INVALID_ID_PARAM', 'VALIDATION_ERROR']).toContain(res.json().errorCode);
    },
  );
});

describe('GET /api/newsletters/campaigns', () => {
  it('lists the campaigns the newest first, with no content', async () => {
    const first = await draft(staff.manager, { name: 'List one', content: contentOf('l1') });
    const second = await draft(staff.manager, { name: 'List two' });
    const third = await draft(staff.root, { name: 'List three' });

    const items = await walk('limit=100');
    const mine = items.filter((item) => [first, second, third].includes(item.id as number));

    expect(mine.map((item) => item.id)).toEqual([third, second, first]);
    for (const item of mine) {
      expect(Object.keys(item).sort()).toEqual(
        [
          'cancelReason',
          'counters',
          'createdAt',
          'createdById',
          'disabledLocales',
          'id',
          'missingLocale',
          'name',
          'scheduledAt',
          'status',
          'updatedAt',
        ].sort(),
      );
    }
    expect(mine[2]).toMatchObject({
      name: 'List one',
      status: 'draft',
      scheduledAt: null,
      missingLocale: 'shop_locale',
      disabledLocales: [],
      counters: {
        planned: 0,
        sent: 0,
        rejected: 0,
        undelivered: 0,
        complaints: 0,
        unsubscribed: 0,
      },
      createdById: staff.manager.id,
    });
  });

  it('walks the pages with the cursor, each row once and none out of order', async () => {
    const ids = [await draft(), await draft(), await draft(), await draft(), await draft()];

    const items = await walk('limit=2');
    const seen = items.map((item) => item.id as number);

    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
    expect(seen).toEqual(expect.arrayContaining(ids));

    const page = bodyOf(await api.list(staff.manager, 'limit=2')) as {
      items: unknown[];
      limit: number;
      nextCursor: string | null;
      total: number;
    };
    expect(page.items).toHaveLength(2);
    expect(page.limit).toBe(2);
    expect(typeof page.nextCursor).toBe('string');
    expect(page.total).toBeGreaterThanOrEqual(5);
  });

  it('gives twenty rows when no limit is given, and an end to the cursor on the last page', async () => {
    const page = bodyOf(await api.list(staff.manager)) as {
      items: unknown[];
      limit: number;
      nextCursor: string | null;
    };

    expect(page.limit).toBe(20);
    expect(page.items.length).toBeLessThanOrEqual(20);

    const last = bodyOf(await api.list(staff.manager, 'limit=100')) as {
      items: unknown[];
      total: number;
      nextCursor: string | null;
    };
    if (last.total <= 100) expect(last.nextCursor).toBeNull();
  });

  it('keeps the rows of the filter of the state and no others', async () => {
    const scheduled = await draft();
    await moveTo(staff.manager, scheduled, 'scheduled');
    const plain = await draft();

    const drafts = await walk('status=draft&limit=100');
    expect(drafts.every((item) => item.status === 'draft')).toBe(true);
    expect(drafts.map((item) => item.id)).toContain(plain);
    expect(drafts.map((item) => item.id)).not.toContain(scheduled);

    const waiting = await walk('status=scheduled&limit=100');
    expect(waiting.every((item) => item.status === 'scheduled')).toBe(true);
    expect(waiting.map((item) => item.id)).toContain(scheduled);

    const both = await walk('status=draft,scheduled&limit=100');
    expect(both.map((item) => item.id)).toEqual(expect.arrayContaining([plain, scheduled]));
    expect(both.every((item) => ['draft', 'scheduled'].includes(item.status as string))).toBe(true);

    const other = await walk('status=finished,stopped,cancelled,sending&limit=100');
    expect(other.map((item) => item.id)).not.toContain(plain);
    expect(other.map((item) => item.id)).not.toContain(scheduled);
  });

  it('shows the campaigns of all the managers to each', async () => {
    const byManager = await draft(staff.manager);
    const byRoot = await draft(staff.root);

    for (const viewer of [staff.manager, staff.root]) {
      const ids = (await walk('limit=100', viewer)).map((item) => item.id);

      expect(ids).toEqual(expect.arrayContaining([byManager, byRoot]));
    }
  });

  it.each([
    ['a state that is not one', 'status=bogus'],
    ['a state and a comma', 'status=draft,'],
    ['a state with a space', 'status=draft,%20scheduled'],
    ['a state in capitals', 'status=DRAFT'],
    ['a limit of zero', 'limit=0'],
    ['a limit above the most', 'limit=101'],
    ['a limit that is not a number', 'limit=many'],
  ])('refuses %s', async (_name, query) => {
    const res = await api.list(staff.manager, query);

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('VALIDATION_ERROR');
  });

  it('does not take a field of the query it has no use for', async () => {
    // as everywhere in the app, the validator drops it
    const res = await api.list(staff.manager, 'sort=name&limit=1');

    expect(res.statusCode).toBe(200);
    expect(res.json().limit).toBe(1);
  });

  it.each([
    ['a text that is no cursor', 'not-a-cursor'],
    ['a cursor with no id', Buffer.from('{"v":null}').toString('base64url')],
    ['a cursor with a negative id', Buffer.from('{"id":-1,"v":null}').toString('base64url')],
    [
      'a cursor with an id past the largest',
      Buffer.from('{"id":2147483648,"v":null}').toString('base64url'),
    ],
  ])('refuses %s', async (_name, cursor) => {
    const res = await api.list(staff.manager, `cursor=${cursor}`);

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('CURSOR_INVALID');
  });
});
