import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  campaignApi,
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

// The numbers of the list of campaigns count the campaigns of the whole shop, which every other file
// of the run makes and removes, so they are exact only when the file runs alone (a shopwide file does).
//
// The shop is not small: a campaign past "scheduled" cannot be deleted, so the campaigns the other files
// of a run make stay, and a full run leaves hundreds. The requests of this file must not grow with them:
// the app counts the requests of an address (RATE_LIMIT_MAX a minute, the same address for every test),
// and a walk by pages of one row over the whole shop is a request for each campaign. So the pages of a
// few rows walk only the states this file makes itself and removes (OWN), and the states of the others
// walk by the biggest page; the number of requests of a walk is held to WALK_MAX

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
let api: CampaignApi;
const made: number[] = [];

// the states this file makes and removes itself: drafts, and the one it schedules
const OWN = 'draft,scheduled';
// the most requests a walk may take, far below what the app lets an address make in a minute
const WALK_MAX = 100;

type Page = {
  items: { id: number; status: string }[];
  limit: number;
  nextCursor: string | null;
  total: number;
};

// every page of the list, from the first to the last; the rows, and the total each page gave
async function walk(query: string) {
  const rows: Page['items'] = [];
  const totals: number[] = [];
  let cursor: string | null = null;
  let requests = 0;

  do {
    requests += 1;
    if (requests > WALK_MAX) {
      throw new Error(`the walk "${query}" took more than ${WALK_MAX} requests: use a bigger page`);
    }
    const res = await api.list(staff.manager, `${query}${cursor ? `&cursor=${cursor}` : ''}`);
    expect(res.statusCode).toBe(200);
    const page = res.json() as Page;
    rows.push(...page.items);
    totals.push(page.total);
    cursor = page.nextCursor;
  } while (cursor);

  return { rows, totals };
}

const draft = async () => {
  const id = await draftOf(api, staff.manager);
  made.push(id);
  return id;
};

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

describe('the total of the list of campaigns', () => {
  it('is the number of the rows on all the pages, whatever the size of a page', async () => {
    await draft();
    await draft();
    await draft();

    // the pages of a few rows over the states of this file, and the biggest page over the whole shop
    const walks = [1, 2, 7].map((size) => `status=${OWN}&limit=${size}`);
    for (const query of [...walks, 'limit=100']) {
      const { rows, totals } = await walk(query);

      expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
      expect(new Set(totals)).toEqual(new Set([rows.length]));
    }
  });

  it('is the number of the rows of the filter, for each state and for several', async () => {
    const scheduled = await draft();
    await moveTo(staff.manager, scheduled, 'scheduled');
    await draft();

    for (const status of ['draft', 'scheduled', 'sending', 'finished', 'stopped', 'cancelled']) {
      // the states of the others hold what a whole run left: they walk by the biggest page
      const size = OWN.split(',').includes(status) ? 3 : 100;
      const { rows, totals } = await walk(`status=${status}&limit=${size}`);

      expect(rows.every((row) => row.status === status)).toBe(true);
      expect(new Set(totals)).toEqual(new Set([rows.length]));
    }

    const both = await walk(`status=${OWN}&limit=3`);
    const drafts = await walk('status=draft&limit=100');
    const waiting = await walk('status=scheduled&limit=100');
    expect(both.rows).toHaveLength(drafts.rows.length + waiting.rows.length);
    expect(new Set(both.totals)).toEqual(new Set([both.rows.length]));
  });

  it('grows by one for a draft made and falls by one for a draft deleted', async () => {
    const before = (await api.list(staff.manager, 'limit=1')).json().total as number;

    const id = await draft();
    expect((await api.list(staff.manager, 'limit=1')).json().total).toBe(before + 1);
    expect((await api.list(staff.manager, 'status=draft&limit=1')).json().total).toBeGreaterThan(0);

    expect((await api.remove(staff.manager, id)).statusCode).toBe(200);
    expect((await api.list(staff.manager, 'limit=1')).json().total).toBe(before);
  });

  it('gives no next page when the rows fit, and a cursor when they do not', async () => {
    const all = await walk('limit=100');
    const exact = (
      await api.list(staff.manager, `limit=${Math.min(all.rows.length, 100)}`)
    ).json() as Page;

    if (all.rows.length <= 100) expect(exact.nextCursor).toBeNull();
    if (all.rows.length > 1) {
      expect((await api.list(staff.manager, 'limit=1')).json().nextCursor).not.toBeNull();
    }
  });
});
