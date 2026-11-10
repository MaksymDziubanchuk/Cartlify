import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  campaignApi,
  campaignLinesOf,
  campaignRowOf,
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

// POST /api/newsletters/campaigns/:campaignId/copy: a manager makes a new draft from a campaign of
// any state. It has the name "Copy of" and the old one, the same rule for a language without a text
// and the same content, and the link to the original; the data of the products is not copied, it is
// taken again when the copy starts

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
let api: CampaignApi;
const made: number[] = [];

const draft = async (payload: Record<string, unknown> = {}, user = staff.manager) => {
  const id = await draftOf(api, user, payload);
  made.push(id);
  return id;
};

const copyOf = async (id: number, user = staff.manager) => {
  const res = await api.copy(user, id);
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

describe('the copy', () => {
  it('is a new draft with the name, the rule and the content of the original', async () => {
    const content = contentOf('copy');
    const original = await draft({ name: 'Spring sale', missingLocale: 'skip', content });

    const res = await copyOf(original);
    const copy = res.json();

    expect(res.statusCode).toBe(201);
    expect(copy.id).not.toBe(original);
    expect(copy).toMatchObject({
      name: 'Copy of Spring sale',
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
      copiedFromId: original,
      startedAt: null,
      finishedAt: null,
      stoppedAt: null,
      cancelledAt: null,
    });
  });

  it('is made in the name of whoever copies, and leaves the original as it was', async () => {
    const original = await draft({ name: 'Mine', content: contentOf('mine') }, staff.root);
    const before = (await campaignRowOf(original))!;

    const copy = (await copyOf(original, staff.manager)).json();

    expect(copy).toMatchObject({ createdById: staff.manager.id, updatedById: staff.manager.id });
    const after = (await campaignRowOf(original))!;
    expect(after).toMatchObject({
      name: 'Mine',
      createdById: staff.root.id,
      updatedById: staff.root.id,
      content: before.content,
    });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('is independent of the original: changing one does not change the other', async () => {
    const original = await draft({ name: 'First', content: contentOf('first') });
    const copy = (await copyOf(original)).json().id as number;

    await api.update(staff.manager, copy, { name: 'Second', content: contentOf('second') });

    expect(await campaignRowOf(original)).toMatchObject({
      name: 'First',
      content: contentOf('first'),
    });
  });

  it('can be copied again, and a copy of a copy names the one it came from', async () => {
    const original = await draft({ name: 'Base' });
    const copy = (await copyOf(original)).json();
    const second = (await copyOf(copy.id)).json();

    expect(second).toMatchObject({ name: 'Copy of Copy of Base', copiedFromId: copy.id });
  });

  it.each(['scheduled', 'sending', 'finished', 'stopped', 'cancelled'] as const)(
    'is made from a campaign that is %s, as a draft that has not started',
    async (state) => {
      const original = await draft({ name: `Was ${state}`, content: contentOf(state) });
      await moveTo(staff.manager, original, state);

      const res = await copyOf(original);

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        name: `Copy of Was ${state}`,
        status: 'draft',
        scheduledAt: null,
        content: contentOf(state),
        counters: {
          planned: 0,
          sent: 0,
          rejected: 0,
          undelivered: 0,
          complaints: 0,
          unsubscribed: 0,
        },
        copiedFromId: original,
        startedAt: null,
        finishedAt: null,
        stoppedAt: null,
        cancelledAt: null,
      });
    },
  );

  it('does not carry the data of the products over: it is taken again when the copy starts', async () => {
    const original = await draft({ name: 'Started' });
    await moveTo(staff.manager, original, 'scheduled');
    await inOwnerTx(
      async (db) => {
        await db.as({ role: 'ADMIN' });
        await db.rows(
          `update cartlify.newsletter_campaigns
           set status = 'sending', "startedAt" = (now() at time zone 'utc'), "plannedCount" = 3,
               "productsSnapshot" = '[{"productId": 1}]'::jsonb
           where id = $1`,
          original,
        );
      },
      { commit: true },
    );
    expect((await campaignRowOf(original))?.productsSnapshot).not.toBeNull();

    const copy = (await copyOf(original)).json();

    expect(copy).not.toHaveProperty('productsSnapshot');
    expect((await campaignRowOf(copy.id))?.productsSnapshot).toBeNull();
    expect((await campaignRowOf(copy.id))?.plannedCount).toBe(0);
  });
});

// A campaign the limit of the campaigns called off when its time came is cancelled for good. The way
// back for the manager is the copy: a draft with the same text, which can be scheduled for a time that
// fits (the schedule of the copy is in campaignsSchedule.shopwide)
describe('the copy of a campaign the limit called off', () => {
  it('is a draft like any other: not cancelled, with no reason, linked to the original', async () => {
    const content = contentOf('limit');
    const original = await cancelledCampaign(staff.manager, { by: 'limit', content });
    made.push(original);
    expect(await campaignRowOf(original)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'limit',
    });

    const res = await copyOf(original);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: 'draft',
      cancelReason: null,
      cancelledAt: null,
      scheduledAt: null,
      copiedFromId: original,
      content,
    });
    // and the original is as it was
    expect(await campaignRowOf(original)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'limit',
    });
  });

  it('is made by any manager, the one who made the original or another', async () => {
    const original = await cancelledCampaign(staff.manager, { by: 'limit' });

    const byRoot = await copyOf(original, staff.root);

    expect(byRoot.statusCode).toBe(201);
    expect(byRoot.json()).toMatchObject({ createdById: staff.root.id, cancelReason: null });
  });

  it('is made of a campaign a manager called off too, with no reason on either', async () => {
    const original = await cancelledCampaign(staff.manager);

    const res = await copyOf(original);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'draft', cancelReason: null });
  });
});

describe('the name of the copy', () => {
  it('is cut to the longest a name may be', async () => {
    const original = await draft({ name: 'N'.repeat(200) });

    const copy = (await copyOf(original)).json();

    expect(copy.name).toBe(`Copy of ${'N'.repeat(192)}`);
    expect(copy.name).toHaveLength(200);
  });

  it('does not end in a space the cut left', async () => {
    const original = await draft({ name: `${'a'.repeat(191)} ${'b'.repeat(8)}` });

    const copy = (await copyOf(original)).json();

    expect(copy.name).toBe(`Copy of ${'a'.repeat(191)}`);
  });

  it('is cut between characters and never inside a sign that is two halves', async () => {
    const original = await draft({ name: `${'a'.repeat(190)}\u{1F600}\u{1F600}\u{1F600}` });

    const res = await copyOf(original);
    const name = res.json().name as string;

    expect(res.statusCode).toBe(201);
    expect(Array.from(name)).toHaveLength(200);
    expect(name.endsWith('\u{1F600}\u{1F600}')).toBe(true);
    expect(name).toBe(Buffer.from(name, 'utf8').toString('utf8'));
  });
});

describe('the admin log', () => {
  it('has a line for the copy that names the original, and none for the original', async () => {
    const original = await draft({ name: 'Logged', content: contentOf('SECRET-TEXT') });
    const originalLines = await campaignLinesOf(original);

    const copy = (await copyOf(original, staff.root)).json();
    const lines = await campaignLinesOf(copy.id);

    expect(lines).toEqual([
      {
        actorId: staff.root.id,
        actorRole: 'ROOT',
        entityType: 'newsletter_campaign',
        entityId: copy.id,
        action: 'NEWSLETTER_CAMPAIGN_CHANGE',
        event: 'newsletter.campaign_copied',
        meta: [
          { field: 'name', old: null, new: 'Copy of Logged' },
          { field: 'copiedFromId', old: null, new: original },
        ],
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain('SECRET-TEXT');
    expect(await campaignLinesOf(original)).toEqual(originalLines);
  });
});

describe('a refusal', () => {
  it('answers 404 for a campaign there is none of', async () => {
    const res = await api.copy(staff.manager, 2_147_483_647);

    expect(res.statusCode).toBe(404);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_FOUND');
  });

  it.each(['0', '-1', 'abc', '2147483648'])('refuses %s as an id', async (id) => {
    expect((await api.copy(staff.manager, id)).statusCode).toBe(400);
  });
});
