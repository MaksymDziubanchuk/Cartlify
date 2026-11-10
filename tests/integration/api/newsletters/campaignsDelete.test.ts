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

// DELETE /api/newsletters/campaigns/:campaignId: a manager deletes a draft. A campaign in any other
// state stays, with its totals and its lines in the logs: what was scheduled is called off, not
// deleted. The delete itself carries the condition of the state

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

describe('a draft', () => {
  it('is deleted, and is gone from the campaign and from the list', async () => {
    const id = await draft({ name: 'To delete', content: contentOf('gone') });

    const res = await api.remove(staff.manager, id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
    expect(await campaignRowOf(id)).toBeNull();
    expect((await api.get(staff.manager, id)).statusCode).toBe(404);

    const items = (await api.list(staff.manager, 'limit=100')).json().items as { id: number }[];
    expect(items.map((item) => item.id)).not.toContain(id);
  });

  it('is deleted by another manager, and by root', async () => {
    const byRoot = await draft({}, staff.manager);
    const byManager = await draft({}, staff.root);

    expect((await api.remove(staff.root, byRoot)).statusCode).toBe(200);
    expect((await api.remove(staff.manager, byManager)).statusCode).toBe(200);
  });

  it('leaves a line in the admin log with the name, and the line stays when the draft is gone', async () => {
    const id = await draft({ name: 'Logged name', content: contentOf('SECRET-TEXT') });

    await api.remove(staff.root, id);
    const lines = await campaignLinesOf(id);

    expect(lines.map((line) => line.event)).toEqual([
      'newsletter.campaign_created',
      'newsletter.campaign_deleted',
    ]);
    expect(lines[1]).toEqual({
      actorId: staff.root.id,
      actorRole: 'ROOT',
      entityType: 'newsletter_campaign',
      entityId: id,
      action: 'NEWSLETTER_CAMPAIGN_CHANGE',
      event: 'newsletter.campaign_deleted',
      meta: [{ field: 'name', old: 'Logged name', new: null }],
    });
    expect(JSON.stringify(lines)).not.toContain('SECRET-TEXT');
  });

  it('answers 404 when it is deleted again, and writes no second line', async () => {
    const id = await draft();
    await api.remove(staff.manager, id);

    const res = await api.remove(staff.manager, id);

    expect(res.statusCode).toBe(404);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_FOUND');
    expect(
      (await campaignLinesOf(id)).filter((l) => l.event === 'newsletter.campaign_deleted'),
    ).toHaveLength(1);
  });

  it('leaves its copy a campaign of its own, without the link to the original', async () => {
    const original = await draft({ name: 'Original' });
    const copy = (await api.copy(staff.manager, original)).json().id as number;
    made.push(copy);
    expect((await campaignRowOf(copy))?.copiedFromId).toBe(original);

    expect((await api.remove(staff.manager, original)).statusCode).toBe(200);

    const row = await campaignRowOf(copy);
    expect(row).toMatchObject({ name: 'Copy of Original', status: 'draft', copiedFromId: null });
    expect((await api.get(staff.manager, copy)).json().copiedFromId).toBeNull();
  });
});

describe('a campaign that is not a draft', () => {
  it.each(['scheduled', 'sending', 'finished', 'stopped', 'cancelled'] as const)(
    'is kept when it is %s',
    async (state) => {
      const id = await draft({ name: `Kept ${state}` });
      await moveTo(staff.manager, id, state);
      const linesBefore = await campaignLinesOf(id);

      const res = await api.remove(staff.manager, id);

      expect(res.statusCode).toBe(409);
      expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_DELETABLE');
      expect(await campaignRowOf(id)).toMatchObject({ name: `Kept ${state}`, status: state });
      expect(await campaignLinesOf(id)).toEqual(linesBefore);
    },
  );
});

describe('a refusal', () => {
  it('answers 404 for a campaign there is none of', async () => {
    const res = await api.remove(staff.manager, 2_147_483_647);

    expect(res.statusCode).toBe(404);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_FOUND');
  });

  it.each(['0', '-1', 'abc', '2147483648'])('refuses %s as an id', async (id) => {
    expect((await api.remove(staff.manager, id)).statusCode).toBe(400);
  });
});

describe('another manager at the same time', () => {
  it('keeps a draft that is scheduled between the read and the delete', async () => {
    const id = await draft({ name: 'Scheduled in time' });
    let removal!: Promise<LightMyRequestResponse>;

    // the draft is scheduled and not committed yet: the route reads it as a draft, and its delete
    // has to wait for the row
    await inOwnerTx(
      async (db) => {
        await db.as({ role: 'ROOT', userId: staff.root.id });
        await db.rows(
          `update cartlify.newsletter_campaigns
           set status = 'scheduled', "scheduledAt" = ((now() at time zone 'utc') + interval '1 day'),
               "updatedById" = $2::int
           where id = $1`,
          id,
          staff.root.id,
        );
        removal = api.remove(staff.manager, id);
        await writeWaitsForLock();
      },
      { commit: true },
    );

    const res = await removal;

    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_DELETABLE');
    expect(await campaignRowOf(id)).toMatchObject({
      name: 'Scheduled in time',
      status: 'scheduled',
    });
    expect((await campaignLinesOf(id)).map((line) => line.event)).toEqual([
      'newsletter.campaign_created',
    ]);
  });

  it('answers 404 for a draft the other manager deleted in the meantime, and writes one line only', async () => {
    const id = await draft({ name: 'Deleted twice' });
    let removal!: Promise<LightMyRequestResponse>;

    await inOwnerTx(
      async (db) => {
        await db.as({ role: 'ROOT', userId: staff.root.id });
        await db.rows('delete from cartlify.newsletter_campaigns where id = $1', id);
        removal = api.remove(staff.manager, id);
        await writeWaitsForLock();
      },
      { commit: true },
    );

    const res = await removal;

    expect(res.statusCode).toBe(404);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_FOUND');
    expect(await campaignRowOf(id)).toBeNull();
    expect((await campaignLinesOf(id)).map((line) => line.event)).toEqual([
      'newsletter.campaign_created',
    ]);
  });
});
