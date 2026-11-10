import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  campaignApi,
  campaignLinesOf,
  campaignRowOf,
  cancelledCampaign,
  completeContentOf,
  contentOf,
  draftOf,
  moveTo,
  requestWaitsForScheduleLock,
  SCHEDULE_LOCK,
  writeWaitsForLock,
  type CampaignApi,
} from '../../../helpers/newsletterCampaigns.js';
import {
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../../helpers/newsletterStaff.js';
import { inOwnerTx } from '../../../helpers/ownerDb.js';
import { resetShopSettings, setShopSettings } from '../../../helpers/shopSettings.js';

// POST /api/newsletters/campaigns/:campaignId/schedule: a manager schedules a draft for a time, or for
// now, and may move the time of a scheduled campaign. The refusals come in an order (the body, the
// campaign, its state, the past, the content, the limit of the shop). The limit counts every campaign
// of the database, whoever made it, and a campaign that was scheduled or went out can never be deleted,
// so this file is *.shopwide: it runs alone, sets the limit through the route of root and puts it
// back, puts every campaign it schedules at a time of a year of its own (a year no other test and no
// earlier run has used), and cancels what it scheduled at the end

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
let api: CampaignApi;
const made: number[] = [];
let limitBefore: { count: number; days: number };

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

// each test takes a year of its own, drawn far away and different for every run, and counts its
// moments from the first of June of it at noon, UTC (the middle of the year, the hours of the day
// well away from a change of the clock of any zone)
const runYear = 2100 + Math.floor(Math.random() * 6000);
let yearsUsed = 0;
const freshTime = (): number => Date.UTC(runYear + yearsUsed++, 5, 1, 12, 0, 0);

const iso = (ms: number) => new Date(ms).toISOString();

const draft = async (over: Record<string, unknown> = {}, user = staff.manager) => {
  const id = await draftOf(api, user, { content: completeContentOf('s'), ...over });
  made.push(id);
  return id;
};

// schedules a draft at a moment, as the manager unless told otherwise
const scheduleAt = (id: number, ms: number, user = staff.manager) =>
  api.schedule(user, id, { scheduledAt: iso(ms) });

// a draft made and scheduled at once; the response of the schedule is kept
async function scheduled(ms: number, over: Record<string, unknown> = {}) {
  const id = await draft(over);
  const res = await scheduleAt(id, ms);
  expect(res.statusCode).toBe(200);

  return { id, name: res.json().name as string };
}

const put = (key: string, value: number) =>
  app.inject({
    method: 'PUT',
    url: `/api/root/shop-settings/${key}`,
    headers: withCsrf(csrf, accessCookie(staff.root)),
    payload: { value },
  });

async function setLimit(count: number, days: number): Promise<void> {
  expect((await put('newsletterLimitCount', count)).statusCode).toBe(200);
  expect((await put('newsletterLimitDays', days)).statusCode).toBe(200);
}

// the limit for the length of a test, put back to the default of the file after it
async function withLimit(count: number, days: number, run: () => Promise<void>): Promise<void> {
  await setLimit(count, days);
  try {
    await run();
  } finally {
    await setLimit(2, 7);
  }
}

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  staff = await createNewsletterStaff();
  api = campaignApi(app, csrf);

  const values = (
    await app.inject({
      method: 'GET',
      url: '/api/admin/shop-settings',
      headers: { cookie: accessCookie(staff.root) },
    })
  ).json();
  limitBefore = { count: values.newsletterLimitCount, days: values.newsletterLimitDays };
  await setLimit(2, 7);
});

afterAll(async () => {
  try {
    await closeStaff(staff);
  } finally {
    await stopApp();
  }
});

describe('what scheduling does', () => {
  it('schedules a draft for a time with an offset, to that exact instant', async () => {
    const t = freshTime();
    const id = await draft({ name: 'Offset' });

    const res = await api.schedule(staff.manager, id, {
      scheduledAt: new Date(t).toISOString().replace('Z', '+00:00'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id,
      name: 'Offset',
      status: 'scheduled',
      scheduledAt: iso(t),
      updatedById: staff.manager.id,
      createdById: staff.manager.id,
      startedAt: null,
      cancelledAt: null,
      counters: { planned: 0, sent: 0 },
    });
    expect(res.json().content).toEqual(completeContentOf('s'));
    const row = (await campaignRowOf(id))!;
    expect(row.status).toBe('scheduled');
    expect(row.scheduledAt?.toISOString()).toBe(iso(t));
  });

  it('reads an offset of a zone other than UTC as that instant', async () => {
    const t = freshTime();
    const id = await draft();

    const res = await api.schedule(staff.manager, id, {
      scheduledAt: `${iso(t).slice(0, 19)}+05:30`,
    });

    // the wall time of the instant plus the offset of India is five and a half hours later than UTC
    expect(res.statusCode).toBe(200);
    expect(res.json().scheduledAt).toBe(iso(t - (5 * HOUR + 30 * MINUTE)));
  });

  it('reads a time with no offset in the time zone of the shop, the same instant as one with the offset', async () => {
    const zone = env.SHOP_TIME_ZONE;
    const wallOf = (ms: number) =>
      new Date(ms).toLocaleString('sv-SE', { timeZone: zone, hourCycle: 'h23' }).replace(' ', 'T');

    // a summer and a winter day: the zone of the shop has its own offset on each
    for (const month of [6, 0]) {
      const t = Date.UTC(runYear + yearsUsed++, month, 15, 10, 0, 0);
      const id = await draft();

      const res = await api.schedule(staff.manager, id, { scheduledAt: wallOf(t) });

      expect(res.statusCode).toBe(200);
      expect(res.json().scheduledAt).toBe(iso(t));
    }
  });

  it('keeps the seconds and the milliseconds, and takes a time to the minute', async () => {
    const t = freshTime();
    const first = await draft();
    const second = await draft();

    const withMs = await api.schedule(staff.manager, first, {
      scheduledAt: `${iso(t).slice(0, 19)}.250Z`,
    });
    const toMinute = await api.schedule(staff.manager, second, {
      scheduledAt: `${iso(t + DAY).slice(0, 16)}Z`,
    });

    expect(withMs.json().scheduledAt).toBe(iso(t + 250));
    expect(toMinute.json().scheduledAt).toBe(iso(t + DAY));
  });

  it('schedules for now with runNow: the time is the moment of the request', async () => {
    await withLimit(100, 1, async () => {
      const id = await draft({ name: 'Now' });
      const before = Date.now();

      const res = await api.schedule(staff.manager, id, { runNow: true });

      const after = Date.now();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id, status: 'scheduled', updatedById: staff.manager.id });
      const at = new Date(res.json().scheduledAt).getTime();
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeLessThanOrEqual(after);
    });
  });

  it('can run a scheduled campaign now: the time moves to the moment of the request', async () => {
    await withLimit(100, 1, async () => {
      const { id } = await scheduled(freshTime());
      const before = Date.now();

      const res = await api.schedule(staff.manager, id, { runNow: true });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('scheduled');
      expect(new Date(res.json().scheduledAt).getTime()).toBeGreaterThanOrEqual(before);
    });
  });

  it('moves the time of a scheduled campaign, which stays scheduled', async () => {
    const t = freshTime();
    const { id } = await scheduled(t);
    const planned = (await campaignRowOf(id))!;

    const res = await scheduleAt(id, t + 3 * DAY, staff.root);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'scheduled',
      scheduledAt: iso(t + 3 * DAY),
      createdById: staff.manager.id,
      updatedById: staff.root.id,
    });
    const row = (await campaignRowOf(id))!;
    expect(row.scheduledAt?.toISOString()).toBe(iso(t + 3 * DAY));
    expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(planned.updatedAt.getTime());
  });

  it('lets any manager schedule the campaign of another, and names who did', async () => {
    const id = await draft({}, staff.root);

    const res = await scheduleAt(id, freshTime(), staff.manager);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ createdById: staff.root.id, updatedById: staff.manager.id });
  });

  it('leaves the content, the name and the totals as they were', async () => {
    const id = await draft({ name: 'Untouched', missingLocale: 'skip' });
    const before = (await campaignRowOf(id))!;

    await scheduleAt(id, freshTime());

    const row = (await campaignRowOf(id))!;
    expect(row).toMatchObject({
      name: 'Untouched',
      missingLocale: 'skip',
      content: before.content,
      plannedCount: 0,
      sentCount: 0,
      startedAt: null,
      productsSnapshot: null,
    });
  });

  it('answers with the same campaign GET gives', async () => {
    const id = await draft();

    const res = await scheduleAt(id, freshTime());

    expect((await api.get(staff.manager, id)).json()).toEqual(res.json());
  });
});

// A campaign the limit called off when its time came is cancelled for good: it cannot be scheduled
// again, so the manager copies it and schedules the copy for a time that fits
describe('a campaign the limit of the campaigns called off', () => {
  it('cannot be scheduled again, but its copy can, for a time that fits the limit', async () => {
    const t = freshTime();
    const original = await cancelledCampaign(staff.manager, {
      by: 'limit',
      content: completeContentOf('limit'),
    });
    made.push(original);

    const again = await scheduleAt(original, t);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ errorCode: 'NEWSLETTER_CAMPAIGN_NOT_SCHEDULABLE' });

    const copied = await api.copy(staff.manager, original);
    expect(copied.statusCode).toBe(201);
    const copy = copied.json().id as number;
    made.push(copy);

    const res = await scheduleAt(copy, t);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: copy,
      status: 'scheduled',
      cancelReason: null,
      scheduledAt: iso(t),
      copiedFromId: original,
    });
    // the original is still the record of what the limit did
    expect(await campaignRowOf(original)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'limit',
    });
  });

  it('does not count against the limit', async () => {
    const t = freshTime();
    const called = await cancelledCampaign(staff.manager, {
      by: 'limit',
      scheduledAt: iso(t),
      content: completeContentOf('limit'),
    });
    made.push(called);

    await withLimit(1, 7, async () => {
      const { id } = await scheduled(t);

      expect(id).not.toBe(called);
    });
  });
});

describe('the admin log', () => {
  it('names the old and the new time, and the state when it changed', async () => {
    const t = freshTime();
    const id = await draft();
    const created = await campaignLinesOf(id);

    await scheduleAt(id, t, staff.root);
    await scheduleAt(id, t + DAY, staff.manager);
    const lines = await campaignLinesOf(id);

    expect(lines).toHaveLength(created.length + 2);
    expect(lines.at(-2)).toEqual({
      actorId: staff.root.id,
      actorRole: 'ROOT',
      entityType: 'newsletter_campaign',
      entityId: id,
      action: 'NEWSLETTER_CAMPAIGN_CHANGE',
      event: 'newsletter.campaign_scheduled',
      meta: [
        { field: 'status', old: 'draft', new: 'scheduled' },
        { field: 'scheduledAt', old: null, new: iso(t) },
      ],
    });
    expect(lines.at(-1)).toMatchObject({
      actorId: staff.manager.id,
      actorRole: 'ADMIN',
      event: 'newsletter.campaign_scheduled',
      meta: [{ field: 'scheduledAt', old: iso(t), new: iso(t + DAY) }],
    });
  });

  it('writes no line for a request that was refused', async () => {
    const id = await draft({ content: contentOf('incomplete') });
    const before = await campaignLinesOf(id);

    await scheduleAt(id, freshTime());
    await scheduleAt(id, Date.now() - DAY);
    await api.schedule(staff.manager, id, {});

    expect(await campaignLinesOf(id)).toEqual(before);
  });
});

describe('the body', () => {
  it.each([
    ['nothing', {}],
    ['both a time and now', { scheduledAt: '2999-01-01T10:00:00Z', runNow: true }],
    ['now as false', { runNow: false }],
    ['now as the text "true"', { runNow: 'true' }],
    ['a time that is not text', { scheduledAt: 20990101 }],
    ['an empty time', { scheduledAt: '' }],
    ['a word for a time', { scheduledAt: 'tomorrow' }],
    ['a date with no time', { scheduledAt: '2999-01-01' }],
    ['a month that does not exist', { scheduledAt: '2999-13-01T10:00:00Z' }],
    ['the 30th of February', { scheduledAt: '2996-02-30T10:00:00Z' }],
    ['an hour that does not exist', { scheduledAt: '2999-01-01T24:00:00Z' }],
    ['an offset with no colon', { scheduledAt: '2999-01-01T10:00:00+0200' }],
    ['a field it does not know', { scheduledAt: '2999-01-01T10:00:00Z', name: 'x' }],
  ])('refuses %s (VALIDATION_ERROR) and changes nothing', async (_case, payload) => {
    const id = await draft();
    const before = await campaignLinesOf(id);

    const res = await api.schedule(staff.manager, id, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('VALIDATION_ERROR');
    expect((await campaignRowOf(id))?.status).toBe('draft');
    expect(await campaignLinesOf(id)).toEqual(before);
  });

  it('names the field of a time that does not exist, as the schema names its own', async () => {
    const id = await draft();

    const res = await api.schedule(staff.manager, id, { scheduledAt: '2996-02-30T10:00:00Z' });

    expect(res.json().details).toEqual([
      { in: 'body', field: 'scheduledAt', message: expect.any(String) },
    ]);
  });

  it('refuses the body before it looks for the campaign', async () => {
    const res = await api.schedule(staff.manager, 2_147_483_647, { runNow: 'yes' });

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('VALIDATION_ERROR');
  });

  it('answers 404 for a campaign there is not', async () => {
    const res = await api.schedule(staff.manager, 2_147_483_647, { runNow: true });

    expect(res.statusCode).toBe(404);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_FOUND');
  });
});

describe('the state of the campaign', () => {
  it.each(['sending', 'finished', 'stopped', 'cancelled'] as const)(
    'refuses a campaign that is %s, and changes nothing of it',
    async (state) => {
      const id = await draft({ name: `Was ${state}` });
      const t = freshTime();
      await moveTo(staff.manager, id, state, iso(t + HOUR), {
        scheduledAt: iso(t),
        startedAt: iso(t),
      });
      const before = (await campaignRowOf(id))!;
      const linesBefore = await campaignLinesOf(id);

      for (const payload of [{ scheduledAt: iso(t + 30 * DAY) }, { runNow: true }]) {
        const res = await api.schedule(staff.manager, id, payload);

        expect(res.statusCode).toBe(409);
        expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_SCHEDULABLE');
      }

      expect(await campaignRowOf(id)).toEqual(before);
      expect(await campaignLinesOf(id)).toEqual(linesBefore);
    },
  );
});

describe('a time in the past', () => {
  it('is refused, with the time asked and the moment of the request', async () => {
    const id = await draft();
    const before = Date.now();

    const res = await api.schedule(staff.manager, id, { scheduledAt: '2001-01-01T10:00:00Z' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'NEWSLETTER_SCHEDULE_IN_PAST',
      details: { scheduledAt: '2001-01-01T10:00:00.000Z' },
    });
    expect(new Date(res.json().details.now).getTime()).toBeGreaterThanOrEqual(before);
    expect((await campaignRowOf(id))?.status).toBe('draft');
  });

  it('is refused a minute ago, and taken a minute ahead', async () => {
    await withLimit(100, 1, async () => {
      const id = await draft();

      const ago = await scheduleAt(id, Date.now() - MINUTE);
      const ahead = await scheduleAt(id, Date.now() + 5 * MINUTE);

      expect(ago.statusCode).toBe(400);
      expect(ago.json().errorCode).toBe('NEWSLETTER_SCHEDULE_IN_PAST');
      expect(ahead.statusCode).toBe(200);
    });
  });

  it('is refused for a scheduled campaign too, which keeps its time', async () => {
    const t = freshTime();
    const { id } = await scheduled(t);

    const res = await scheduleAt(id, Date.now() - HOUR);

    expect(res.statusCode).toBe(400);
    expect((await campaignRowOf(id))?.scheduledAt?.toISOString()).toBe(iso(t));
  });

  it('is judged in the zone of a time with no offset', async () => {
    const id = await draft();

    const res = await api.schedule(staff.manager, id, { scheduledAt: '2001-01-01T10:00' });

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('NEWSLETTER_SCHEDULE_IN_PAST');
  });

  it('is no matter for runNow', async () => {
    await withLimit(100, 1, async () => {
      const id = await draft();

      const res = await api.schedule(staff.manager, id, { runNow: true });

      expect(res.statusCode).toBe(200);
    });
  });
});

describe('a content that is not whole', () => {
  const block = { type: 'button', kind: 'shop', url: '/' };

  const incomplete = async (
    content: unknown,
    missing: { field: string; locale: string | null }[],
  ) => {
    const id = await draft({ content });
    const before = await campaignLinesOf(id);

    const res = await scheduleAt(id, freshTime());

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'NEWSLETTER_CONTENT_INCOMPLETE',
      details: { missing },
    });
    expect((await campaignRowOf(id))?.status).toBe('draft');
    expect((await campaignRowOf(id))?.scheduledAt).toBeNull();
    expect(await campaignLinesOf(id)).toEqual(before);
  };

  it('is refused for a draft made with no content', async () => {
    const id = await draftOf(api, staff.manager, {});
    made.push(id);

    const res = await scheduleAt(id, freshTime());

    expect(res.statusCode).toBe(400);
    expect(res.json().details.missing).toEqual([
      { field: 'content.blocks', locale: null },
      { field: 'content.subject.en', locale: 'en' },
    ]);
  });

  it('wants a block at least', async () => {
    await incomplete({ subject: { en: 'Subject' }, blocks: [] }, [
      { field: 'content.blocks', locale: null },
    ]);
  });

  it('wants the subject of the language of the shop', async () => {
    await incomplete({ subject: { es: 'Asunto' }, blocks: [block] }, [
      { field: 'content.subject.en', locale: 'en' },
    ]);
  });

  it('wants the text of a text block in the language of the shop', async () => {
    await incomplete(
      {
        subject: { en: 'Subject' },
        blocks: [
          { type: 'text', text: { en: 'One' } },
          { type: 'text', text: {} },
        ],
      },
      [{ field: 'content.blocks[1].text.en', locale: 'en' }],
    );
  });

  it('wants the title of a block in the language of the shop when it has one in another', async () => {
    await incomplete(
      {
        subject: { en: 'Subject', es: 'Asunto' },
        blocks: [
          { type: 'text', text: { en: 'One', es: 'Uno' } },
          { type: 'products', source: 'manual', productIds: [1], title: { es: 'Ideas' } },
        ],
      },
      [{ field: 'content.blocks[1].title.en', locale: 'en' }],
    );
  });

  it('wants every text of another language that has a subject', async () => {
    await incomplete(
      {
        subject: { en: 'Subject', es: 'Asunto' },
        blocks: [
          { type: 'text', text: { en: 'One' } },
          { type: 'category', categoryId: 3, title: { en: 'Shoes' } },
        ],
      },
      [
        { field: 'content.blocks[0].text.es', locale: 'es' },
        { field: 'content.blocks[1].title.es', locale: 'es' },
      ],
    );
  });

  it('lists everything that is missing, the language of the shop first', async () => {
    await incomplete(
      {
        subject: { es: 'Asunto', en: 'Subject' },
        blocks: [
          { type: 'text', text: {} },
          { type: 'text', text: { es: 'Uno' } },
        ],
      },
      [
        { field: 'content.blocks[0].text.en', locale: 'en' },
        { field: 'content.blocks[1].text.en', locale: 'en' },
        { field: 'content.blocks[0].text.es', locale: 'es' },
      ],
    );
  });

  it('wants no preview, and no title on a block that has none', async () => {
    const id = await draft({
      content: {
        subject: { en: 'Subject', es: 'Asunto' },
        blocks: [
          { type: 'text', text: { en: 'One', es: 'Uno' } },
          { type: 'products', source: 'rule', rule: 'new' },
          { type: 'category', categoryId: 3 },
          block,
        ],
      },
    });

    const res = await scheduleAt(id, freshTime());

    expect(res.statusCode).toBe(200);
  });

  it('takes a campaign of one language', async () => {
    const id = await draft({
      content: { subject: { en: 'Subject' }, blocks: [{ type: 'text', text: { en: 'One' } }] },
    });

    expect((await scheduleAt(id, freshTime())).statusCode).toBe(200);
  });

  it('judges the content again: a link that does not lead to the shop any more is refused', async () => {
    const id = await draft();
    // the address of the shop changed after the text was written: the text holds a link elsewhere
    await inOwnerTx(
      async (db) => {
        await db.as({ role: 'ROOT', userId: staff.root.id });
        await db.rows(
          `update cartlify.newsletter_campaigns
           set content = jsonb_set(content, '{blocks,4,url}', '"https://elsewhere.example/sale"'),
               "updatedById" = $2::int
           where id = $1`,
          id,
          staff.root.id,
        );
      },
      { commit: true },
    );

    const res = await scheduleAt(id, freshTime());

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'NEWSLETTER_LINK_NOT_ALLOWED',
      details: { field: 'content.blocks[4].url' },
    });
    expect((await campaignRowOf(id))?.status).toBe('draft');
  });

  it('judges the content again: an address of a site root does not trust any more is refused', async () => {
    // the text names a site root trusted when it was written
    setShopSettings({ newsletterTrustedDomains: ['partner.test'] });
    const content = completeContentOf('s') as { blocks: Array<Record<string, unknown>> };
    content.blocks[0] = {
      type: 'text',
      text: { en: 'Read https://blog.partner.test/post', es: 'Lee https://blog.partner.test/post' },
    };
    const id = await draft({ content });

    // while it is trusted the campaign can be scheduled (a time out of the way: it is put back below)
    const trusted = await draft({ content });
    expect((await scheduleAt(trusted, freshTime())).statusCode).toBe(200);

    resetShopSettings();
    const res = await scheduleAt(id, freshTime());

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'NEWSLETTER_ADDRESS_NOT_ALLOWED',
      details: { field: 'content.blocks[0].text.en', address: 'https://blog.partner.test/post' },
    });
    expect((await campaignRowOf(id))?.status).toBe('draft');
  });

  it('judges the languages again: a language that has no dictionary is refused', async () => {
    const id = await draft();
    await inOwnerTx(
      async (db) => {
        await db.as({ role: 'ROOT', userId: staff.root.id });
        await db.rows(
          `update cartlify.newsletter_campaigns
           set content = jsonb_set(content, '{subject,xx}', '"Xx"'), "updatedById" = $2::int
           where id = $1`,
          id,
          staff.root.id,
        );
      },
      { commit: true },
    );

    const res = await scheduleAt(id, freshTime());

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('LOCALE_INVALID');
  });
});

// A language root turned off after the text was written: the text stays in the campaign and does not
// go out (nobody has the language any more, and the sending takes the languages of the people at the
// start), so it is neither a reason to refuse the campaign nor a text that must be whole. A language
// that is on is judged as ever. The languages of the shop here are the memory of the server of this
// file (setShopSettings), the rows are not touched
describe('a language the shop has turned off', () => {
  const ALL = ['en', 'es', 'uk'];

  // both languages of the shop whole, and a third one with a subject and no text at all
  const withUnfinishedUk = () => {
    const whole = completeContentOf('s') as { subject: Record<string, string> };
    return { ...whole, subject: { ...whole.subject, uk: 'Весна' } };
  };

  afterEach(() => resetShopSettings());

  it('lets the campaign be scheduled though the text of that language is not whole', async () => {
    const id = await draft({ content: withUnfinishedUk() });
    setShopSettings({ enabledLocales: ['en', 'es'] });

    const res = await scheduleAt(id, freshTime());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'scheduled', disabledLocales: ['uk'] });
    // the text is still there
    expect((await campaignRowOf(id))?.content).toMatchObject({
      subject: { en: expect.any(String), es: expect.any(String), uk: 'Весна' },
    });
  });

  it('asks the text of that language to be whole once the language is on', async () => {
    const id = await draft({ content: withUnfinishedUk() });
    setShopSettings({ enabledLocales: ALL });

    const res = await scheduleAt(id, freshTime());

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_CONTENT_INCOMPLETE' });
    expect(res.json().details.missing).toEqual(
      expect.arrayContaining([expect.objectContaining({ locale: 'uk' })]),
    );
    expect((await campaignRowOf(id))?.status).toBe('draft');
  });

  it('still asks what a language that is on lacks', async () => {
    const id = await draft({
      content: {
        subject: { en: 'S', es: 'S', uk: 'С' },
        blocks: [{ type: 'text', text: { en: 'Hello' } }],
      },
    });
    setShopSettings({ enabledLocales: ['en', 'es'] });

    const res = await scheduleAt(id, freshTime());

    expect(res.statusCode).toBe(400);
    expect(res.json().details.missing).toEqual([
      { field: 'content.blocks[0].text.es', locale: 'es' },
    ]);
  });

  it('moves the time of a campaign that was scheduled before the language was turned off', async () => {
    const t = freshTime();
    // whole in the three languages: it passes while all of them are on
    const whole = completeContentOf('s') as {
      subject: Record<string, string>;
      blocks: Array<Record<string, unknown> & { text?: object; title?: object }>;
    };
    const id = await draft({
      content: {
        ...whole,
        subject: { ...whole.subject, uk: 'Весна' },
        blocks: whole.blocks.map((block) =>
          block.type === 'text'
            ? { ...block, text: { ...block.text, uk: 'Привіт' } }
            : block.title
              ? { ...block, title: { ...block.title, uk: 'Заголовок' } }
              : block,
        ),
      },
    });
    expect((await scheduleAt(id, t)).statusCode).toBe(200);
    setShopSettings({ enabledLocales: ['en', 'es'] });

    const moved = await scheduleAt(id, t + HOUR);

    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ scheduledAt: iso(t + HOUR), disabledLocales: ['uk'] });
  });

  it('still checks the links of the text of that language', async () => {
    const id = await draft({ content: withUnfinishedUk() });
    // a text that leads away from the shop, put into the row by hand: the route would not have kept it
    await inOwnerTx(
      async (db) => {
        await db.as({ role: 'ROOT', userId: staff.root.id });
        await db.rows(
          `update cartlify.newsletter_campaigns
           set content = jsonb_set(content, '{blocks,0,text,uk}', to_jsonb($3::text)),
               "updatedById" = $2::int
           where id = $1`,
          id,
          staff.root.id,
          '[x](https://elsewhere.example/phish)',
        );
      },
      { commit: true },
    );
    setShopSettings({ enabledLocales: ['en', 'es'] });

    const res = await scheduleAt(id, freshTime());

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'NEWSLETTER_LINK_NOT_ALLOWED',
      details: { field: 'content.blocks[0].text.uk' },
    });
  });
});

describe('the order of the refusals', () => {
  it('judges the state before the time', async () => {
    const id = await draft();
    const t = freshTime();
    await moveTo(staff.manager, id, 'cancelled', iso(t + HOUR), { scheduledAt: iso(t) });

    const res = await scheduleAt(id, Date.now() - DAY);

    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_SCHEDULABLE');
  });

  it('judges the time before the content', async () => {
    const id = await draft({ content: contentOf('incomplete') });

    const res = await scheduleAt(id, Date.now() - DAY);

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('NEWSLETTER_SCHEDULE_IN_PAST');
  });

  it('judges the content before the limit', async () => {
    await withLimit(1, 7, async () => {
      const t = freshTime();
      await scheduled(t);
      const id = await draft({ content: contentOf('incomplete') });

      const res = await scheduleAt(id, t + HOUR);

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('NEWSLETTER_CONTENT_INCOMPLETE');
    });
  });
});

describe('the limit of the shop', () => {
  it('takes campaigns up to the count and refuses the one more, naming the ones in the window', async () => {
    const t = freshTime();
    const a = await scheduled(t);
    const b = await scheduled(t + DAY);
    const id = await draft({ name: 'One too many' });

    const res = await scheduleAt(id, t + 2 * DAY);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'NEWSLETTER_LIMIT_REACHED',
      details: {
        campaigns: [
          { id: a.id, name: a.name, at: iso(t) },
          { id: b.id, name: b.name, at: iso(t + DAY) },
        ],
        limit: { count: 2, days: 7 },
      },
    });
    expect(res.json().details.campaigns).toHaveLength(2);
    const row = (await campaignRowOf(id))!;
    expect(row.status).toBe('draft');
    expect(row.scheduledAt).toBeNull();
    expect(await campaignLinesOf(id)).toHaveLength(1);
  });

  it('refuses a campaign before the ones in the window, and after them', async () => {
    const t = freshTime();
    const a = await scheduled(t + 3 * DAY);
    const b = await scheduled(t + 5 * DAY);
    const before = await draft();
    const after = await draft();

    const early = await scheduleAt(before, t + DAY);
    const late = await scheduleAt(after, t + 8 * DAY);

    for (const res of [early, late]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().details.campaigns.map((c: { id: number }) => c.id)).toEqual([a.id, b.id]);
    }
  });

  it('reads the window as it slides: a campaign beyond the two that share one is taken', async () => {
    const t = freshTime();
    await scheduled(t);
    await scheduled(t + DAY);
    const id = await draft();

    // 8 days from the first, 7 from the second: no window holds it and both of them
    const res = await scheduleAt(id, t + 8 * DAY);

    expect(res.statusCode).toBe(200);
  });

  it('takes a campaign between two that are too far apart to share a window with it', async () => {
    const t = freshTime();
    await scheduled(t);
    await scheduled(t + 10 * DAY);
    const id = await draft();

    expect((await scheduleAt(id, t + 5 * DAY)).statusCode).toBe(200);
  });

  it('puts two campaigns exactly the days apart in different windows', async () => {
    await withLimit(1, 7, async () => {
      const t = freshTime();
      const a = await scheduled(t);
      const toosoon = await draft();
      const after = await draft();
      const before = await draft();
      const justBefore = await draft();

      const soon = await scheduleAt(toosoon, t + 7 * DAY - MINUTE);
      const afterRes = await scheduleAt(after, t + 7 * DAY);
      const beforeRes = await scheduleAt(before, t - 7 * DAY);
      const justBeforeRes = await scheduleAt(justBefore, t - 7 * DAY + MINUTE);

      expect(soon.statusCode).toBe(409);
      expect(soon.json().details.campaigns.map((c: { id: number }) => c.id)).toEqual([a.id]);
      expect(afterRes.statusCode).toBe(200);
      expect(beforeRes.statusCode).toBe(200);
      expect(justBeforeRes.statusCode).toBe(409);
    });
  });

  it('takes the count of 1 and the window of 1 day', async () => {
    await withLimit(1, 1, async () => {
      const t = freshTime();
      await scheduled(t);
      const near = await draft();
      const far = await draft();

      expect((await scheduleAt(near, t + 23 * HOUR)).statusCode).toBe(409);
      expect((await scheduleAt(far, t + 24 * HOUR)).statusCode).toBe(200);
    });
  });

  it('counts the campaigns that went out at the time they began, not at the time they were scheduled for', async () => {
    await withLimit(1, 3, async () => {
      for (const state of ['sending', 'finished', 'stopped'] as const) {
        const t = freshTime();
        const gone = await draft({ name: `Late ${state}` });
        // scheduled for the start of the year, and picked up five days later
        await moveTo(staff.manager, gone, state, iso(t + 5 * DAY + HOUR), {
          scheduledAt: iso(t),
          startedAt: iso(t + 5 * DAY),
        });
        const nearItsStart = await draft();
        const nearItsSchedule = await draft();

        const refused = await scheduleAt(nearItsStart, t + 6 * DAY);
        const taken = await scheduleAt(nearItsSchedule, t + DAY);

        expect(refused.statusCode).toBe(409);
        expect(refused.json().details.campaigns).toEqual([
          { id: gone, name: `Late ${state}`, at: iso(t + 5 * DAY) },
        ]);
        expect(taken.statusCode).toBe(200);
      }
    });
  });

  it('counts a scheduled campaign at its time', async () => {
    await withLimit(1, 3, async () => {
      const t = freshTime();
      const planned = await draft();
      await moveTo(staff.manager, planned, 'scheduled', iso(t + HOUR), { scheduledAt: iso(t) });
      const id = await draft();

      const res = await scheduleAt(id, t + DAY);

      expect(res.statusCode).toBe(409);
      expect(res.json().details.campaigns).toMatchObject([{ id: planned, at: iso(t) }]);
    });
  });

  it('does not count a draft or a cancelled campaign', async () => {
    await withLimit(1, 7, async () => {
      const t = freshTime();
      // a draft and a campaign that was scheduled for this very time and called off
      await draft({ name: 'Only a draft' });
      const called = await scheduled(t);
      expect((await api.cancel(staff.manager, called.id)).statusCode).toBe(200);
      const id = await draft();

      const res = await scheduleAt(id, t + HOUR);

      expect(res.statusCode).toBe(200);
    });
  });

  it('frees the window when a campaign is cancelled, and the next one takes it', async () => {
    await withLimit(1, 7, async () => {
      const t = freshTime();
      const first = await scheduled(t);
      const second = await draft();
      expect((await scheduleAt(second, t + DAY)).statusCode).toBe(409);

      expect((await api.cancel(staff.manager, first.id)).statusCode).toBe(200);
      const taken = await scheduleAt(second, t + DAY);

      expect(taken.statusCode).toBe(200);
    });
  });

  it('keeps counting a campaign that was stopped', async () => {
    await withLimit(1, 7, async () => {
      const t = freshTime();
      const gone = await draft();
      await moveTo(staff.manager, gone, 'sending', iso(t + HOUR), { startedAt: iso(t) });
      expect((await api.stop(staff.manager, gone)).statusCode).toBe(200);
      const id = await draft();

      const res = await scheduleAt(id, t + DAY);

      expect(res.statusCode).toBe(409);
      expect(res.json().details.campaigns).toMatchObject([{ id: gone, at: iso(t) }]);
    });
  });

  it('does not count the campaign against itself when its time moves', async () => {
    await withLimit(1, 7, async () => {
      const t = freshTime();
      const a = await scheduled(t);

      const res = await scheduleAt(a.id, t + 3 * DAY);

      expect(res.statusCode).toBe(200);
      expect(res.json().scheduledAt).toBe(iso(t + 3 * DAY));
    });
  });

  it('counts a scheduled campaign at its new time once it moved, and not at its old one', async () => {
    await withLimit(1, 7, async () => {
      const t = freshTime();
      const a = await scheduled(t);
      expect((await scheduleAt(a.id, t + 3 * DAY)).statusCode).toBe(200);
      const nearNew = await draft();
      const nearOld = await draft();

      const refused = await scheduleAt(nearNew, t + 5 * DAY);
      // at the old time, 7 days from the new one, the window is free
      const taken = await scheduleAt(nearOld, t - 4 * DAY);

      expect(refused.statusCode).toBe(409);
      expect(refused.json().details.campaigns).toMatchObject([{ id: a.id, at: iso(t + 3 * DAY) }]);
      expect(taken.statusCode).toBe(200);
    });
  });

  it('refuses to move a campaign next to another, and names only the other', async () => {
    await withLimit(1, 7, async () => {
      const t = freshTime();
      const a = await scheduled(t);
      const b = await scheduled(t + 20 * DAY);

      const res = await scheduleAt(a.id, t + 19 * DAY);

      expect(res.statusCode).toBe(409);
      expect(res.json().details.campaigns).toMatchObject([{ id: b.id }]);
      expect((await campaignRowOf(a.id))?.scheduledAt?.toISOString()).toBe(iso(t));
    });
  });

  it('refuses a campaign for now when one is already scheduled for now', async () => {
    await withLimit(100, 1, async () => {
      const first = await draft({ name: 'First now' });
      expect((await api.schedule(staff.manager, first, { runNow: true })).statusCode).toBe(200);
      const second = await draft();

      await setLimit(1, 7);
      const res = await api.schedule(staff.manager, second, { runNow: true });

      expect(res.statusCode).toBe(409);
      expect(res.json().details.campaigns).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: first, name: 'First now' })]),
      );
    });
  });

  it('reads the limit that stands now: root raises it and the next request is taken', async () => {
    await withLimit(1, 7, async () => {
      const t = freshTime();
      await scheduled(t);
      const id = await draft();
      expect((await scheduleAt(id, t + DAY)).statusCode).toBe(409);

      await setLimit(2, 7);

      expect((await scheduleAt(id, t + DAY)).statusCode).toBe(200);
    });
  });

  it('lets root lower the limit without touching a campaign that is scheduled', async () => {
    const t = freshTime();
    const a = await scheduled(t);
    const b = await scheduled(t + DAY);

    await withLimit(1, 7, async () => {
      for (const { id } of [a, b]) {
        const row = (await campaignRowOf(id))!;
        expect(row.status).toBe('scheduled');
      }

      // the new limit holds for a new campaign, in the windows the two fill
      const near = await draft();
      const far = await draft();
      const refused = await scheduleAt(near, t + 2 * DAY);
      const taken = await scheduleAt(far, t + 30 * DAY);

      expect(refused.statusCode).toBe(409);
      expect(refused.json().details.campaigns.map((c: { id: number }) => c.id)).toEqual([
        a.id,
        b.id,
      ]);
      expect(refused.json().details.limit).toEqual({ count: 1, days: 7 });
      expect(taken.statusCode).toBe(200);
    });

    for (const { id } of [a, b]) expect((await campaignRowOf(id))?.status).toBe('scheduled');
  });

  it('is asked for a large window and a large count too', async () => {
    await withLimit(100, 365, async () => {
      const t = freshTime();
      const id = await draft();

      expect((await scheduleAt(id, t)).statusCode).toBe(200);
    });
  });
});

describe('two requests at once', () => {
  it('lets exactly one of two managers take the last place of the limit', async () => {
    await withLimit(1, 7, async () => {
      for (let round = 0; round < 6; round += 1) {
        const t = freshTime();
        const x = await draft();
        const y = await draft();

        const [first, second] = await Promise.all([
          scheduleAt(x, t, staff.manager),
          scheduleAt(y, t + HOUR, staff.root),
        ]);

        const statuses = [first.statusCode, second.statusCode].sort();
        expect(statuses).toEqual([200, 409]);
        const refused = first.statusCode === 409 ? first : second;
        expect(refused.json().errorCode).toBe('NEWSLETTER_LIMIT_REACHED');
        const rows = await Promise.all([campaignRowOf(x), campaignRowOf(y)]);
        expect(rows.map((row) => row?.status).sort()).toEqual(['draft', 'scheduled']);
      }
    });
  });

  it('takes a lock first, and reads the campaigns that count again under it', async () => {
    await withLimit(1, 7, async () => {
      const t = freshTime();
      const x = await draft({ name: 'The other manager' });
      const y = await draft();
      let request!: Promise<LightMyRequestResponse>;

      // another manager holds the lock and is about to schedule x: y has to wait for it, and then
      // see x among the campaigns that count
      await inOwnerTx(
        async (db) => {
          await db.rows('select pg_advisory_xact_lock(hashtext($1))', SCHEDULE_LOCK);
          request = scheduleAt(y, t + HOUR);
          await requestWaitsForScheduleLock();

          await db.as({ role: 'ADMIN', userId: staff.manager.id });
          await db.rows(
            `update cartlify.newsletter_campaigns
             set status = 'scheduled', "scheduledAt" = $2::timestamp, "updatedById" = $3::int
             where id = $1`,
            x,
            iso(t),
            staff.manager.id,
          );
        },
        { commit: true },
      );

      const res = await request;

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        errorCode: 'NEWSLETTER_LIMIT_REACHED',
        details: { campaigns: [{ id: x, name: 'The other manager', at: iso(t) }] },
      });
      expect((await campaignRowOf(y))?.status).toBe('draft');
    });
  });
});

describe('a campaign that changes under the request', () => {
  it('refuses a campaign the system started between the read and the write', async () => {
    const t = freshTime();
    const { id } = await scheduled(t);
    let request!: Promise<LightMyRequestResponse>;

    // the system starts the campaign and has not committed yet: the request reads it as scheduled,
    // and its write has to wait for the row
    await inOwnerTx(
      async (db) => {
        await db.as({ role: 'ADMIN' });
        await db.rows(
          `update cartlify.newsletter_campaigns
           set status = 'sending', "startedAt" = (now() at time zone 'utc'), "plannedCount" = 1
           where id = $1`,
          id,
        );
        request = scheduleAt(id, t + 30 * DAY);
        await writeWaitsForLock();
      },
      { commit: true },
    );

    const res = await request;

    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_SCHEDULABLE');
    expect(await campaignRowOf(id)).toMatchObject({
      status: 'sending',
      scheduledAt: new Date(t),
    });
    expect(await campaignLinesOf(id)).toHaveLength(2);
  });

  it('answers 404 when another manager deletes the draft between the read and the write', async () => {
    const id = await draft();
    let request!: Promise<LightMyRequestResponse>;

    await inOwnerTx(
      async (db) => {
        await db.as({ role: 'ROOT', userId: staff.root.id });
        await db.rows('delete from cartlify.newsletter_campaigns where id = $1', id);
        request = scheduleAt(id, freshTime());
        await writeWaitsForLock();
      },
      { commit: true },
    );

    const res = await request;

    expect(res.statusCode).toBe(404);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_FOUND');
    expect(await campaignRowOf(id)).toBeNull();
  });

  it('refuses a campaign another manager called off between the read and the write', async () => {
    const t = freshTime();
    const { id } = await scheduled(t);
    let request!: Promise<LightMyRequestResponse>;

    await inOwnerTx(
      async (db) => {
        await db.as({ role: 'ROOT', userId: staff.root.id });
        await db.rows(
          `update cartlify.newsletter_campaigns
           set status = 'cancelled', "cancelledAt" = (now() at time zone 'utc'), "updatedById" = $2::int
           where id = $1`,
          id,
          staff.root.id,
        );
        request = scheduleAt(id, t + 30 * DAY);
        await writeWaitsForLock();
      },
      { commit: true },
    );

    const res = await request;

    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_SCHEDULABLE');
    expect((await campaignRowOf(id))?.status).toBe('cancelled');
  });
});

// The last test of the file takes back what the file made, because the shop lock is given up before
// afterAll runs and the next *.shopwide file would count the campaigns this one is still removing
describe('what the file leaves behind', () => {
  it('cancels what was scheduled, deletes the drafts and puts the limit of the shop back', async () => {
    // what was scheduled is cancelled (a cancelled campaign counts for nothing), a draft is deleted;
    // what went out cannot be either and stays
    for (const id of made) {
      const row = await campaignRowOf(id);
      if (row?.status === 'scheduled') await api.cancel(staff.manager, id);
      else if (row?.status === 'draft') await api.remove(staff.manager, id);
    }
    await setLimit(limitBefore.count, limitBefore.days);

    for (const id of made) {
      expect(['draft', 'scheduled']).not.toContain((await campaignRowOf(id))?.status);
    }
  });
});
