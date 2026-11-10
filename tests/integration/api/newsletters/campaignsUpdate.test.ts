import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  campaignApi,
  campaignLinesOf,
  campaignRowOf,
  contentOf,
  draftOf,
  forgetCampaigns,
  moveTo,
  writeWaitsForLock,
  type CampaignApi,
} from '../../../helpers/newsletterCampaigns.js';
import {
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../../helpers/newsletterStaff.js';
import { inOwnerTx } from '../../../helpers/ownerDb.js';

// PATCH /api/newsletters/campaigns/:campaignId: a manager changes the name, the rule for a language
// without a text or the whole content of a campaign that is a draft or scheduled. The write itself
// carries the condition of the state, so a campaign the system started a moment before is refused
// too. What a content may hold is the test of the content (campaignsContent)

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

const SYSTEM = { role: 'ADMIN' as const };

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

describe('what is changed', () => {
  it('changes the name and nothing else', async () => {
    const id = await draft({ name: 'Before', content: contentOf('keep'), missingLocale: 'skip' });
    const before = (await campaignRowOf(id))!;

    const res = await api.update(staff.manager, id, { name: 'After' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id,
      name: 'After',
      status: 'draft',
      missingLocale: 'skip',
      content: contentOf('keep'),
      createdById: staff.manager.id,
      updatedById: staff.manager.id,
    });
    const row = (await campaignRowOf(id))!;
    expect(row.name).toBe('After');
    expect(row.content).toEqual(before.content);
    expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
  });

  it('changes the rule for a language without a text', async () => {
    const id = await draft();

    const res = await api.update(staff.manager, id, { missingLocale: 'skip' });

    expect(res.statusCode).toBe(200);
    expect(res.json().missingLocale).toBe('skip');
    expect((await campaignRowOf(id))?.missingLocale).toBe('skip');
  });

  it('replaces the content: a language or a block that is left out is gone', async () => {
    const id = await draft({ content: contentOf('old') });
    const next = {
      subject: { en: 'Only English' },
      preview: { en: 'New preview' },
      blocks: [{ type: 'button', kind: 'shop', url: '/' }],
    };

    const res = await api.update(staff.manager, id, { content: next });

    expect(res.statusCode).toBe(200);
    expect(res.json().content).toEqual(next);
    expect((await campaignRowOf(id))?.content).toEqual(next);
  });

  it('can empty the content', async () => {
    const id = await draft({ content: contentOf('old') });

    const res = await api.update(staff.manager, id, { content: { subject: {}, blocks: [] } });

    expect(res.statusCode).toBe(200);
    expect(res.json().content).toEqual({ subject: {}, preview: {}, blocks: [] });
  });

  it('changes all three in one request', async () => {
    const id = await draft({ content: contentOf('old') });
    const next = contentOf('new');

    const res = await api.update(staff.manager, id, {
      name: 'All three',
      missingLocale: 'skip',
      content: next,
    });

    expect(res.json()).toMatchObject({ name: 'All three', missingLocale: 'skip', content: next });
  });

  it('cuts the spaces around the name', async () => {
    const id = await draft();

    const res = await api.update(staff.manager, id, { name: '   Spaced  ' });

    expect(res.json().name).toBe('Spaced');
  });

  it('does not touch the time, the state or the totals', async () => {
    const id = await draft();
    await moveTo(staff.manager, id, 'scheduled');
    const before = (await campaignRowOf(id))!;

    const res = await api.update(staff.manager, id, { name: 'Still scheduled' });

    expect(res.statusCode).toBe(200);
    const row = (await campaignRowOf(id))!;
    expect(row.status).toBe('scheduled');
    expect(row.scheduledAt?.getTime()).toBe(before.scheduledAt?.getTime());
    expect(row.plannedCount).toBe(0);
  });

  it('names the manager who changed it last, and keeps the one who made it', async () => {
    const id = await draft({ name: 'By manager' }, staff.manager);

    const res = await api.update(staff.root, id, { name: 'By root' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      createdById: staff.manager.id,
      updatedById: staff.root.id,
    });
    expect(await campaignRowOf(id)).toMatchObject({
      createdById: staff.manager.id,
      updatedById: staff.root.id,
    });
  });

  it('lets a manager change the campaign of another manager', async () => {
    const id = await draft({}, staff.root);

    const res = await api.update(staff.manager, id, { name: 'Taken over' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ createdById: staff.root.id, updatedById: staff.manager.id });
  });
});

describe('a request that changes nothing', () => {
  it('writes nothing: the editor and the time stay, and no line is written', async () => {
    const id = await draft({ name: 'Same', content: contentOf('same') }, staff.root);
    const before = (await campaignRowOf(id))!;
    const linesBefore = await campaignLinesOf(id);

    const res = await api.update(staff.manager, id, {
      name: 'Same',
      missingLocale: 'shop_locale',
      content: contentOf('same'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Same', updatedById: staff.root.id });
    const row = (await campaignRowOf(id))!;
    expect(row.updatedById).toBe(staff.root.id);
    expect(row.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await campaignLinesOf(id)).toEqual(linesBefore);
  });

  it('sees the same content when the keys come in another order', async () => {
    const content = {
      subject: { en: 'S', es: 'T' },
      preview: { es: 'P', en: 'Q' },
      blocks: [{ type: 'button', url: '/', kind: 'shop' }],
    };
    const id = await draft({ content });
    const linesBefore = await campaignLinesOf(id);

    const res = await api.update(staff.manager, id, {
      content: {
        blocks: [{ kind: 'shop', type: 'button', url: '/' }],
        preview: { en: 'Q', es: 'P' },
        subject: { es: 'T', en: 'S' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(await campaignLinesOf(id)).toEqual(linesBefore);
  });

  it('still answers 409 for a campaign that cannot be changed, though nothing would change', async () => {
    const id = await draft({ name: 'Gone out' });
    await moveTo(staff.manager, id, 'finished');

    const res = await api.update(staff.manager, id, { name: 'Gone out' });

    expect(res.statusCode).toBe(409);
  });
});

describe('the states', () => {
  it('changes a scheduled campaign', async () => {
    const id = await draft({ name: 'Waiting' });
    await moveTo(staff.manager, id, 'scheduled');

    // a scheduled campaign takes a content that can go out (contentOf is a draft's, unfinished in es)
    const res = await api.update(staff.manager, id, {
      name: 'Waiting, changed',
      content: { subject: { en: 'Waiting' }, blocks: [{ type: 'text', text: { en: 'Hello' } }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'scheduled', name: 'Waiting, changed' });
  });

  it.each(['sending', 'finished', 'stopped', 'cancelled'] as const)(
    'refuses a campaign that is %s, and changes nothing of it',
    async (state) => {
      const id = await draft({ name: `Was ${state}`, content: contentOf(state) });
      await moveTo(staff.manager, id, state);
      const before = (await campaignRowOf(id))!;
      const linesBefore = await campaignLinesOf(id);

      for (const payload of [
        { name: 'New name' },
        { missingLocale: 'skip' },
        { content: contentOf('other') },
      ]) {
        const res = await api.update(staff.manager, id, payload);

        expect(res.statusCode).toBe(409);
        expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_EDITABLE');
      }

      const row = (await campaignRowOf(id))!;
      expect(row).toMatchObject({
        name: before.name,
        missingLocale: before.missingLocale,
        content: before.content,
        status: state,
      });
      expect(await campaignLinesOf(id)).toEqual(linesBefore);
    },
  );

  it('refuses a campaign the system started between the read and the write', async () => {
    const id = await draft({ name: 'Race' });
    await moveTo(staff.manager, id, 'scheduled');
    let patch!: Promise<LightMyRequestResponse>;

    // the system starts the campaign and has not committed yet: the route reads it as scheduled,
    // and its write has to wait for the row
    await inOwnerTx(
      async (db) => {
        await db.as(SYSTEM);
        await db.rows(
          `update cartlify.newsletter_campaigns
           set status = 'sending', "startedAt" = (now() at time zone 'utc'), "plannedCount" = 1
           where id = $1`,
          id,
        );
        patch = api.update(staff.manager, id, { name: 'Too late' });
        await writeWaitsForLock();
      },
      { commit: true },
    );

    const res = await patch;

    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_EDITABLE');
    expect(await campaignRowOf(id)).toMatchObject({ name: 'Race', status: 'sending' });
    expect(await campaignLinesOf(id)).toHaveLength(1);
  });

  it('answers 404 when another manager deletes the draft between the read and the write', async () => {
    const id = await draft({ name: 'Vanishing' });
    let patch!: Promise<LightMyRequestResponse>;

    await inOwnerTx(
      async (db) => {
        await db.as({ role: 'ROOT', userId: staff.root.id });
        await db.rows('delete from cartlify.newsletter_campaigns where id = $1', id);
        patch = api.update(staff.manager, id, { name: 'Too late' });
        await writeWaitsForLock();
      },
      { commit: true },
    );

    const res = await patch;

    expect(res.statusCode).toBe(404);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_FOUND');
    expect(await campaignRowOf(id)).toBeNull();
  });
});

describe('the admin log', () => {
  it('names the fields that changed with the old and the new name and rule, and never the texts', async () => {
    const id = await draft({ name: 'Old name', content: contentOf('TEXT-ONE') });
    const created = await campaignLinesOf(id);

    const res = await api.update(staff.root, id, {
      name: 'New name',
      missingLocale: 'skip',
      content: contentOf('TEXT-TWO'),
    });
    const lines = await campaignLinesOf(id);

    expect(res.statusCode).toBe(200);
    expect(lines).toHaveLength(created.length + 1);
    expect(lines.at(-1)).toEqual({
      actorId: staff.root.id,
      actorRole: 'ROOT',
      entityType: 'newsletter_campaign',
      entityId: id,
      action: 'NEWSLETTER_CAMPAIGN_CHANGE',
      event: 'newsletter.campaign_updated',
      meta: [
        { field: 'name', old: 'Old name', new: 'New name' },
        { field: 'missingLocale', old: 'shop_locale', new: 'skip' },
        { field: 'content', old: null, new: null },
      ],
    });
    expect(JSON.stringify(lines)).not.toContain('TEXT-ONE');
    expect(JSON.stringify(lines)).not.toContain('TEXT-TWO');
  });

  it('writes only the fields that did change', async () => {
    const id = await draft({ name: 'Old', content: contentOf('c') });

    await api.update(staff.manager, id, { name: 'New', content: contentOf('c') });
    await api.update(staff.manager, id, { content: contentOf('d') });
    const lines = await campaignLinesOf(id);

    expect(lines.slice(1).map((line) => line.meta)).toEqual([
      [{ field: 'name', old: 'Old', new: 'New' }],
      [{ field: 'content', old: null, new: null }],
    ]);
  });

  it('writes a line for each change', async () => {
    const id = await draft();

    await api.update(staff.manager, id, { name: 'One' });
    await api.update(staff.manager, id, { name: 'Two' });

    expect((await campaignLinesOf(id)).map((line) => line.event)).toEqual([
      'newsletter.campaign_created',
      'newsletter.campaign_updated',
      'newsletter.campaign_updated',
    ]);
  });
});

describe('what is refused', () => {
  it('answers 404 for a campaign there is none of', async () => {
    const res = await api.update(staff.manager, 2_147_483_647, { name: 'x' });

    expect(res.statusCode).toBe(404);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_FOUND');
  });

  it.each(['0', '-1', 'abc', '2147483648'])('refuses %s as an id', async (id) => {
    const res = await api.update(staff.manager, id, { name: 'x' });

    expect(res.statusCode).toBe(400);
  });

  it.each([
    ['nothing', {}],
    ['a state', { status: 'sending' }],
    ['the time', { scheduledAt: '2030-01-01T00:00:00.000Z' }],
    ['the maker', { createdById: 1 }],
    ['the editor', { updatedById: 1 }],
    ['the totals', { sentCount: 5 }],
    ['the products', { productsSnapshot: {} }],
    ['an empty name', { name: '' }],
    ['a name of spaces', { name: '   ' }],
    ['a name that is too long', { name: 'N'.repeat(201) }],
    ['a name with a new line', { name: 'a\nb' }],
    ['a rule that is not one', { missingLocale: 'all' }],
    ['a content that is not whole', { content: { subject: {} } }],
    ['a content that is null', { content: null }],
    [
      'a content with a block of a kind there is none of',
      { content: { subject: {}, blocks: [{ type: 'x' }] } },
    ],
  ])('refuses %s', async (_name, payload) => {
    const id = await draft({ name: 'Untouched' });

    const res = await api.update(staff.manager, id, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('VALIDATION_ERROR');
    expect((await campaignRowOf(id))?.name).toBe('Untouched');
  });

  it('changes none of the fields when one of them is wrong', async () => {
    const id = await draft({ name: 'Untouched', content: contentOf('keep') });

    const res = await api.update(staff.manager, id, {
      name: 'Changed',
      missingLocale: 'skip',
      content: { subject: { xx: 'No such language' }, blocks: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('LOCALE_INVALID');
    expect(await campaignRowOf(id)).toMatchObject({
      name: 'Untouched',
      missingLocale: 'shop_locale',
      content: contentOf('keep'),
    });
    expect(await campaignLinesOf(id)).toHaveLength(1);
  });
});
