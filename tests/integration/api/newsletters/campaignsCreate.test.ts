import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import type { TestUser } from '../../../helpers/factories.js';
import {
  bodyOf,
  campaignApi,
  campaignLinesOf,
  campaignRowOf,
  contentOf,
  forgetCampaigns,
  type CampaignApi,
} from '../../../helpers/newsletterCampaigns.js';
import {
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../../helpers/newsletterStaff.js';

// POST /api/newsletters/campaigns: a manager makes a draft in their own name. The content may be left
// out and a draft may be incomplete; what a content may hold is the test of the content
// (campaignsContent). The answer is the whole campaign, and a line is written to the admin log

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
let api: CampaignApi;
const made: number[] = [];

const create = async (user: Pick<TestUser, 'id' | 'role'>, payload: unknown) => {
  const res = await api.create(user, payload);
  if (res.statusCode === 201) made.push(res.json().id as number);
  return res;
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

describe('POST /api/newsletters/campaigns', () => {
  it('makes a draft of a name alone, with no language and no block', async () => {
    const res = await create(staff.manager, { name: 'Spring sale' });
    const campaign = bodyOf(res);

    expect(res.statusCode).toBe(201);
    expect(campaign).toMatchObject({
      name: 'Spring sale',
      status: 'draft',
      scheduledAt: null,
      missingLocale: 'shop_locale',
      content: { subject: {}, preview: {}, blocks: [] },
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
    });
    expect(typeof campaign.id).toBe('number');
    expect(Date.parse(campaign.createdAt as string)).not.toBeNaN();
    expect(campaign.updatedAt).toBe(campaign.createdAt);
    // the data of products is taken when the campaign starts, and is no part of the answer
    expect(campaign).not.toHaveProperty('productsSnapshot');
  });

  it('keeps the draft as the answer says', async () => {
    const res = await create(staff.manager, { name: 'Kept', missingLocale: 'skip' });
    const row = await campaignRowOf(res.json().id);

    expect(row).toMatchObject({
      name: 'Kept',
      status: 'draft',
      missingLocale: 'skip',
      content: { subject: {}, preview: {}, blocks: [] },
      productsSnapshot: null,
      scheduledAt: null,
      createdById: staff.manager.id,
      updatedById: staff.manager.id,
      copiedFromId: null,
      plannedCount: 0,
      sentCount: 0,
    });
  });

  it('makes the draft in the name of whoever asks, root as well', async () => {
    const byRoot = await create(staff.root, { name: 'By root' });

    expect(byRoot.statusCode).toBe(201);
    expect(byRoot.json()).toMatchObject({
      createdById: staff.root.id,
      updatedById: staff.root.id,
    });
  });

  it('takes a whole content and gives it back as it was sent', async () => {
    const content = contentOf('whole');
    const res = await create(staff.manager, { name: 'Whole', content });

    expect(res.statusCode).toBe(201);
    expect(res.json().content).toEqual(content);
    expect((await campaignRowOf(res.json().id))?.content).toEqual(content);
  });

  it('makes a preview of nothing when the content has none', async () => {
    const res = await create(staff.manager, {
      name: 'No preview',
      content: { subject: { en: 'S' }, blocks: [] },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().content).toEqual({ subject: { en: 'S' }, preview: {}, blocks: [] });
  });

  it('cuts the spaces around the name and around the lines of the content', async () => {
    const res = await create(staff.manager, {
      name: '   Trimmed name  ',
      content: { subject: { en: '  S  ' }, preview: { en: ' P ' }, blocks: [] },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Trimmed name');
    expect(res.json().content).toMatchObject({ subject: { en: 'S' }, preview: { en: 'P' } });
  });

  it('takes a draft that is not finished: the language of the shop has no text yet', async () => {
    const res = await create(staff.manager, {
      name: 'Draft',
      content: {
        subject: { es: 'Solo es' },
        blocks: [
          { type: 'text', text: {} },
          { type: 'products', source: 'manual', productIds: [5] },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
  });

  it('keeps html in a text as the plain text it is', async () => {
    const html = '<script>alert(1)</script> <b onclick="x">hi</b>';
    const res = await create(staff.manager, {
      name: 'Html',
      content: { subject: { en: 'S' }, blocks: [{ type: 'text', text: { en: html } }] },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().content.blocks[0].text.en).toBe(html);
  });

  it('takes a name of the longest size and refuses one a sign longer', async () => {
    expect((await create(staff.manager, { name: 'N'.repeat(200) })).statusCode).toBe(201);

    const res = await api.create(staff.manager, { name: 'N'.repeat(201) });
    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('VALIDATION_ERROR');
  });

  it('writes a line to the admin log with the name and the rule, never the texts', async () => {
    const res = await create(staff.manager, {
      name: 'Logged',
      missingLocale: 'skip',
      content: contentOf('SECRET-TEXT'),
    });
    const lines = await campaignLinesOf(res.json().id);

    expect(lines).toEqual([
      {
        actorId: staff.manager.id,
        actorRole: 'ADMIN',
        entityType: 'newsletter_campaign',
        entityId: res.json().id,
        action: 'NEWSLETTER_CAMPAIGN_CHANGE',
        event: 'newsletter.campaign_created',
        meta: [
          { field: 'name', old: null, new: 'Logged' },
          { field: 'missingLocale', old: null, new: 'skip' },
          { field: 'content', old: null, new: null },
        ],
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain('SECRET-TEXT');
  });

  it('writes the line of root with its role', async () => {
    const res = await create(staff.root, { name: 'Root logged' });

    expect(await campaignLinesOf(res.json().id)).toMatchObject([
      { actorId: staff.root.id, actorRole: 'ROOT', event: 'newsletter.campaign_created' },
    ]);
  });

  it('writes no row and no line when the request is refused', async () => {
    const mine = () =>
      asAdmin(async (tx) => ({
        rows: await tx.newsletterCampaign.count({ where: { createdById: staff.manager.id } }),
        lines: await tx.adminAuditLog.count({
          where: { actorId: staff.manager.id, event: 'newsletter.campaign_created' },
        }),
      }));
    const before = await mine();

    const res = await api.create(staff.manager, {
      name: 'Refused',
      content: { subject: { xx: 'S' }, blocks: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('LOCALE_INVALID');
    expect(await mine()).toEqual(before);
  });

  it.each([
    ['no name', {}],
    ['a name of spaces', { name: '   ' }],
    ['a name that is not a text', { name: 5 }],
    ['a rule that is not one', { name: 'a', missingLocale: 'other' }],
    ['a field that is not known', { name: 'a', status: 'scheduled' }],
    ['the time of the start', { name: 'a', scheduledAt: '2030-01-01T00:00:00.000Z' }],
    ['the maker', { name: 'a', createdById: 1 }],
    ['a content that is not whole', { name: 'a', content: { subject: {} } }],
  ])('refuses %s', async (_name, payload) => {
    const res = await api.create(staff.manager, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('VALIDATION_ERROR');
  });
});
