import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  campaignApi,
  campaignLinesOf,
  campaignRowOf,
  completeContentOf,
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

// POST /api/newsletters/campaigns/:campaignId/cancel and /stop: a manager calls off a campaign that is
// scheduled, or stops one that is going out. Each write carries the condition of the state it moves
// from, so a campaign the system moved a moment before is refused with a code and not overwritten.
// Neither asks the limit of the shop, so the file needs none of the shop's state (the moves of the
// limit are in campaignsSchedule.shopwide.test.ts)

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
let api: CampaignApi;
const made: number[] = [];

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

const draft = async (over: Record<string, unknown> = {}, user = staff.manager) => {
  const id = await draftOf(api, user, { content: completeContentOf('c'), ...over });
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

describe('POST /api/newsletters/campaigns/:campaignId/cancel', () => {
  it('calls off a scheduled campaign: it is cancelled, with the time, and the manager is named', async () => {
    const id = await draft({ name: 'To call off' });
    await moveTo(staff.manager, id, 'scheduled');
    const planned = (await campaignRowOf(id))!;
    const before = Date.now();

    const res = await api.cancel(staff.root, id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id,
      name: 'To call off',
      status: 'cancelled',
      cancelReason: null,
      scheduledAt: planned.scheduledAt?.toISOString(),
      startedAt: null,
      createdById: staff.manager.id,
      updatedById: staff.root.id,
    });
    expect(new Date(res.json().cancelledAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(res.json().cancelledAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const row = (await campaignRowOf(id))!;
    expect(row).toMatchObject({
      status: 'cancelled',
      updatedById: staff.root.id,
      cancelReason: null,
    });
    expect(row.cancelledAt).not.toBeNull();
    // the content and the totals are as they were
    expect(row.content).toEqual(planned.content);
    expect(row.plannedCount).toBe(0);
  });

  it('lets any manager call off the campaign of another', async () => {
    const id = await draft({}, staff.root);
    await moveTo(staff.root, id, 'scheduled');

    const res = await api.cancel(staff.manager, id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ createdById: staff.root.id, updatedById: staff.manager.id });
  });

  it('answers with the same campaign GET gives', async () => {
    const id = await draft();
    await moveTo(staff.manager, id, 'scheduled');

    const res = await api.cancel(staff.manager, id);

    expect((await api.get(staff.manager, id)).json()).toEqual(res.json());
  });

  it('writes a line to the admin log with the state it left and the one it reached', async () => {
    const id = await draft();
    await moveTo(staff.manager, id, 'scheduled');
    const before = await campaignLinesOf(id);

    await api.cancel(staff.root, id);
    const lines = await campaignLinesOf(id);

    expect(lines).toHaveLength(before.length + 1);
    expect(lines.at(-1)).toEqual({
      actorId: staff.root.id,
      actorRole: 'ROOT',
      entityType: 'newsletter_campaign',
      entityId: id,
      action: 'NEWSLETTER_CAMPAIGN_CHANGE',
      event: 'newsletter.campaign_cancelled',
      meta: [{ field: 'status', old: 'scheduled', new: 'cancelled' }],
    });
  });

  it('cannot be done twice: the second call is refused', async () => {
    const id = await draft();
    await moveTo(staff.manager, id, 'scheduled');
    expect((await api.cancel(staff.manager, id)).statusCode).toBe(200);
    const linesBefore = await campaignLinesOf(id);

    const res = await api.cancel(staff.manager, id);

    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_CANCELLABLE');
    expect(await campaignLinesOf(id)).toEqual(linesBefore);
  });

  it.each(['draft', 'sending', 'finished', 'stopped'] as const)(
    'refuses a campaign that is %s, and changes nothing of it',
    async (state) => {
      const id = await draft({ name: `Is ${state}` });
      if (state !== 'draft') await moveTo(staff.manager, id, state);
      const before = (await campaignRowOf(id))!;
      const linesBefore = await campaignLinesOf(id);

      const res = await api.cancel(staff.manager, id);

      expect(res.statusCode).toBe(409);
      expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_CANCELLABLE');
      expect(await campaignRowOf(id)).toEqual(before);
      expect(await campaignLinesOf(id)).toEqual(linesBefore);
    },
  );

  it('answers 404 for a campaign there is not', async () => {
    const res = await api.cancel(staff.manager, 2_147_483_647);

    expect(res.statusCode).toBe(404);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_FOUND');
  });

  it('refuses a campaign the system started between the read and the write', async () => {
    const id = await draft({ name: 'Race' });
    await moveTo(staff.manager, id, 'scheduled');
    let request!: Promise<LightMyRequestResponse>;

    // the system starts the campaign and has not committed yet: the route reads it as scheduled,
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
        request = api.cancel(staff.manager, id);
        await writeWaitsForLock();
      },
      { commit: true },
    );

    const res = await request;

    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_CANCELLABLE');
    expect(await campaignRowOf(id)).toMatchObject({ status: 'sending', cancelledAt: null });
    expect(await campaignLinesOf(id)).toHaveLength(1);
  });

  it('refuses a campaign another manager took back to a draft between the read and the write', async () => {
    const id = await draft();
    await moveTo(staff.manager, id, 'scheduled');
    let request!: Promise<LightMyRequestResponse>;

    await inOwnerTx(
      async (db) => {
        await db.as({ role: 'ROOT', userId: staff.root.id });
        await db.rows(
          `update cartlify.newsletter_campaigns set status = 'draft', "updatedById" = $2::int where id = $1`,
          id,
          staff.root.id,
        );
        request = api.cancel(staff.manager, id);
        await writeWaitsForLock();
      },
      { commit: true },
    );

    const res = await request;

    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_CANCELLABLE');
    expect((await campaignRowOf(id))?.status).toBe('draft');
  });

  it('answers 404 when the campaign is deleted between the read and the write', async () => {
    // a scheduled campaign cannot be deleted by a route, but the database lets root's policy do it
    // for a draft: the campaign is taken back to a draft and deleted while the request waits
    const id = await draft();
    await moveTo(staff.manager, id, 'scheduled');
    let request!: Promise<LightMyRequestResponse>;

    await inOwnerTx(
      async (db) => {
        await db.as({ role: 'ROOT', userId: staff.root.id });
        await db.rows(
          `update cartlify.newsletter_campaigns set status = 'draft', "updatedById" = $2::int where id = $1`,
          id,
          staff.root.id,
        );
        await db.rows('delete from cartlify.newsletter_campaigns where id = $1', id);
        request = api.cancel(staff.manager, id);
        await writeWaitsForLock();
      },
      { commit: true },
    );

    const res = await request;

    expect(res.statusCode).toBe(404);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_FOUND');
    expect(await campaignRowOf(id)).toBeNull();
  });
});

describe('POST /api/newsletters/campaigns/:campaignId/stop', () => {
  it('stops a campaign that is going out: it is stopped, with the time, and the manager is named', async () => {
    const id = await draft({ name: 'To stop' });
    await moveTo(staff.manager, id, 'sending');
    const going = (await campaignRowOf(id))!;
    const before = Date.now();

    const res = await api.stop(staff.root, id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id,
      name: 'To stop',
      status: 'stopped',
      startedAt: going.startedAt?.toISOString(),
      finishedAt: null,
      cancelledAt: null,
      cancelReason: null,
      createdById: staff.manager.id,
      updatedById: staff.root.id,
      counters: { planned: 1 },
    });
    expect(new Date(res.json().stoppedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(res.json().stoppedAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await campaignRowOf(id)).toMatchObject({
      status: 'stopped',
      updatedById: staff.root.id,
    });
  });

  it('keeps the totals and the content as they were', async () => {
    const id = await draft();
    await moveTo(staff.manager, id, 'sending');
    const going = (await campaignRowOf(id))!;

    await api.stop(staff.manager, id);

    expect(await campaignRowOf(id)).toMatchObject({
      content: going.content,
      plannedCount: going.plannedCount,
      sentCount: going.sentCount,
      scheduledAt: going.scheduledAt,
      startedAt: going.startedAt,
    });
  });

  it('answers with the same campaign GET gives', async () => {
    const id = await draft();
    await moveTo(staff.manager, id, 'sending');

    const res = await api.stop(staff.manager, id);

    expect((await api.get(staff.manager, id)).json()).toEqual(res.json());
  });

  it('writes a line to the admin log with the state it left and the one it reached', async () => {
    const id = await draft();
    await moveTo(staff.manager, id, 'sending');
    const before = await campaignLinesOf(id);

    await api.stop(staff.manager, id);
    const lines = await campaignLinesOf(id);

    expect(lines).toHaveLength(before.length + 1);
    expect(lines.at(-1)).toEqual({
      actorId: staff.manager.id,
      actorRole: 'ADMIN',
      entityType: 'newsletter_campaign',
      entityId: id,
      action: 'NEWSLETTER_CAMPAIGN_CHANGE',
      event: 'newsletter.campaign_stopped',
      meta: [{ field: 'status', old: 'sending', new: 'stopped' }],
    });
  });

  it('cannot be done twice: the second call is refused', async () => {
    const id = await draft();
    await moveTo(staff.manager, id, 'sending');
    expect((await api.stop(staff.manager, id)).statusCode).toBe(200);
    const linesBefore = await campaignLinesOf(id);

    const res = await api.stop(staff.manager, id);

    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_STOPPABLE');
    expect(await campaignLinesOf(id)).toEqual(linesBefore);
  });

  it.each(['draft', 'scheduled', 'finished', 'cancelled'] as const)(
    'refuses a campaign that is %s, and changes nothing of it',
    async (state) => {
      const id = await draft({ name: `Is ${state}` });
      if (state !== 'draft') await moveTo(staff.manager, id, state);
      const before = (await campaignRowOf(id))!;
      const linesBefore = await campaignLinesOf(id);

      const res = await api.stop(staff.manager, id);

      expect(res.statusCode).toBe(409);
      expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_STOPPABLE');
      expect(await campaignRowOf(id)).toEqual(before);
      expect(await campaignLinesOf(id)).toEqual(linesBefore);
    },
  );

  it('answers 404 for a campaign there is not', async () => {
    const res = await api.stop(staff.manager, 2_147_483_647);

    expect(res.statusCode).toBe(404);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_FOUND');
  });

  it('refuses a campaign the system finished between the read and the write', async () => {
    const id = await draft({ name: 'Race' });
    await moveTo(staff.manager, id, 'sending', iso(Date.now() - DAY));
    let request!: Promise<LightMyRequestResponse>;

    await inOwnerTx(
      async (db) => {
        await db.as({ role: 'ADMIN' });
        await db.rows(
          `update cartlify.newsletter_campaigns
           set status = 'finished', "finishedAt" = (now() at time zone 'utc')
           where id = $1`,
          id,
        );
        request = api.stop(staff.manager, id);
        await writeWaitsForLock();
      },
      { commit: true },
    );

    const res = await request;

    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe('NEWSLETTER_CAMPAIGN_NOT_STOPPABLE');
    expect(await campaignRowOf(id)).toMatchObject({ status: 'finished', stoppedAt: null });
    expect(await campaignLinesOf(id)).toHaveLength(1);
  });
});
