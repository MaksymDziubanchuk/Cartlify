import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { accessCookie } from './actors.js';
import { withCsrf, type Csrf } from './csrf.js';
import { asAdmin, type Actor } from './db.js';
import type { TestUser } from './factories.js';
import { campaignIn, moveCampaignTo, utc, type CampaignState } from './newsletterDb.js';
import { inOwnerTx } from './ownerDb.js';

// Helpers for the tests of the routes of the campaigns of the newsletters: the calls, the content
// they use, and the steps a test cannot take through the app (the system starts a campaign, a
// manager un-schedules it) taken the way the database allows them

export const CAMPAIGNS = '/api/newsletters/campaigns';

// a content that is whole: both languages have a subject, every kind of block is there
export const contentOf = (tag = 'A'): Record<string, unknown> => ({
  subject: { en: `Spring sale ${tag}`, es: `Rebajas ${tag}` },
  preview: { en: `Preview ${tag}` },
  blocks: [
    { type: 'text', text: { en: `# Hello ${tag}\nThe **best** prices, [see the sale](/sale).` } },
    { type: 'products', title: { en: 'Picks' }, source: 'manual', productIds: [1, 2, 3] },
    { type: 'products', source: 'rule', rule: 'bestsellers', limit: 4, periodDays: 30 },
    { type: 'category', categoryId: 3, title: { es: 'Zapatos' } },
    { type: 'button', kind: 'sale', url: '/sale' },
  ],
});

// a content that can go out: both languages have a subject and every text and title in both, every
// kind of block is there (what the route that schedules wants)
export const completeContentOf = (tag = 'A'): Record<string, unknown> => ({
  subject: { en: `Spring sale ${tag}`, es: `Rebajas ${tag}` },
  preview: { en: `Preview ${tag}` },
  blocks: [
    {
      type: 'text',
      text: {
        en: `# Hello ${tag}\nThe **best** prices, [see the sale](/sale).`,
        es: `# Hola ${tag}\nLos **mejores** precios, [ver las rebajas](/sale).`,
      },
    },
    {
      type: 'products',
      title: { en: 'Picks', es: 'Selección' },
      source: 'manual',
      productIds: [1, 2, 3],
    },
    { type: 'products', source: 'rule', rule: 'bestsellers', limit: 4, periodDays: 30 },
    { type: 'category', categoryId: 3, title: { en: 'Shoes', es: 'Zapatos' } },
    { type: 'button', kind: 'sale', url: '/sale' },
  ],
});

export type Caller = (user: Pick<TestUser, 'id' | 'role'>) => string;

// the calls of a test file: one manager (or root) per call
export function campaignApi(app: FastifyInstance, csrf: Csrf) {
  const as = (user: Pick<TestUser, 'id' | 'role'>) => accessCookie(user);

  return {
    create: (user: Pick<TestUser, 'id' | 'role'>, payload: unknown) =>
      app.inject({
        method: 'POST',
        url: CAMPAIGNS,
        headers: withCsrf(csrf, as(user)),
        payload: payload as Record<string, unknown>,
      }),
    list: (user: Pick<TestUser, 'id' | 'role'>, query = '') =>
      app.inject({
        method: 'GET',
        url: `${CAMPAIGNS}${query ? `?${query}` : ''}`,
        headers: { cookie: as(user) },
      }),
    get: (user: Pick<TestUser, 'id' | 'role'>, id: number | string) =>
      app.inject({ method: 'GET', url: `${CAMPAIGNS}/${id}`, headers: { cookie: as(user) } }),
    update: (user: Pick<TestUser, 'id' | 'role'>, id: number | string, payload: unknown) =>
      app.inject({
        method: 'PATCH',
        url: `${CAMPAIGNS}/${id}`,
        headers: withCsrf(csrf, as(user)),
        payload: payload as Record<string, unknown>,
      }),
    remove: (user: Pick<TestUser, 'id' | 'role'>, id: number | string) =>
      app.inject({
        method: 'DELETE',
        url: `${CAMPAIGNS}/${id}`,
        headers: withCsrf(csrf, as(user)),
      }),
    copy: (user: Pick<TestUser, 'id' | 'role'>, id: number | string) =>
      app.inject({
        method: 'POST',
        url: `${CAMPAIGNS}/${id}/copy`,
        headers: withCsrf(csrf, as(user)),
      }),
    schedule: (user: Pick<TestUser, 'id' | 'role'>, id: number | string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url: `${CAMPAIGNS}/${id}/schedule`,
        headers: withCsrf(csrf, as(user)),
        payload: payload as Record<string, unknown>,
      }),
    cancel: (user: Pick<TestUser, 'id' | 'role'>, id: number | string) =>
      app.inject({
        method: 'POST',
        url: `${CAMPAIGNS}/${id}/cancel`,
        headers: withCsrf(csrf, as(user)),
      }),
    stop: (user: Pick<TestUser, 'id' | 'role'>, id: number | string) =>
      app.inject({
        method: 'POST',
        url: `${CAMPAIGNS}/${id}/stop`,
        headers: withCsrf(csrf, as(user)),
      }),
    preview: (user: Pick<TestUser, 'id' | 'role'>, id: number | string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url: `${CAMPAIGNS}/${id}/preview`,
        headers: withCsrf(csrf, as(user)),
        payload: payload as Record<string, unknown>,
      }),
    testMail: (user: Pick<TestUser, 'id' | 'role'>, id: number | string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url: `${CAMPAIGNS}/${id}/test`,
        headers: withCsrf(csrf, as(user)),
        payload: payload as Record<string, unknown>,
      }),
  };
}

export type CampaignApi = ReturnType<typeof campaignApi>;

// a draft made through the route; its id
export async function draftOf(
  api: CampaignApi,
  user: Pick<TestUser, 'id' | 'role'>,
  payload: Record<string, unknown> = {},
): Promise<number> {
  const res = await api.create(user, {
    name: `Draft ${Math.random().toString(36).slice(2)}`,
    ...payload,
  });
  if (res.statusCode !== 201) throw new Error(`the draft was not made: ${res.body}`);

  return res.json().id as number;
}

const actorOf = (user: Pick<TestUser, 'id' | 'role'>): Actor => ({
  role: user.role as 'ADMIN' | 'ROOT',
  userId: user.id,
});

// takes a draft to a state the app routes of a later step will reach (scheduled, sending, finished,
// stopped, cancelled), by the steps and the actors of the app; committed, so the app sees it. A
// campaign past `scheduled` cannot be deleted by anybody: it stays in the database of the test run
export async function moveTo(
  user: Pick<TestUser, 'id' | 'role'>,
  id: number,
  state: CampaignState,
  endedAt: string = utc(),
  times: { scheduledAt?: string; startedAt?: string } = {},
): Promise<void> {
  await inOwnerTx((db) => moveCampaignTo(db, actorOf(user), id, state, endedAt, times), {
    commit: true,
  });
}

// a scheduled campaign back to a draft, the way a manager does it, so the draft can be deleted
export async function unschedule(user: Pick<TestUser, 'id' | 'role'>, id: number): Promise<void> {
  await inOwnerTx(
    async (db) => {
      await db.as(actorOf(user));
      await db.rows(
        `update cartlify.newsletter_campaigns set status = 'draft', "updatedById" = $2::int where id = $1`,
        id,
        user.id,
      );
    },
    { commit: true },
  );
}

// the row as the database keeps it
export const campaignRowOf = (id: number) =>
  asAdmin((tx) => tx.newsletterCampaign.findUnique({ where: { id } }));

// the lines of the admin log about one campaign, the oldest first
export const campaignLinesOf = (id: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'newsletter_campaign', entityId: id },
      orderBy: { id: 'asc' },
      select: {
        actorId: true,
        actorRole: true,
        entityType: true,
        entityId: true,
        action: true,
        event: true,
        meta: true,
      },
    }),
  );

// removes the drafts a test made (a scheduled one is taken back to a draft first); the ones that were
// started stay
export async function forgetCampaigns(
  api: CampaignApi,
  user: Pick<TestUser, 'id' | 'role'>,
  ids: number[],
): Promise<void> {
  for (const id of ids) {
    const row = await campaignRowOf(id);
    if (!row) continue;
    if (row.status === 'scheduled') await unschedule(user, id);
    if (row.status === 'draft' || row.status === 'scheduled') await api.remove(user, id);
  }
}

export const bodyOf = (res: LightMyRequestResponse) => res.json() as Record<string, unknown>;

// waits until a statement on the campaigns stands at a lock another session holds (a change or a
// delete of the app, waiting for a campaign a test keeps locked in a transaction that is not done)
export async function writeWaitsForLock(ms = 5000): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < ms) {
    const rows = await inOwnerTx((db) =>
      db.rows(
        `select 1 from pg_stat_activity
         where wait_event_type = 'Lock' and pid <> pg_backend_pid()
           and query ilike '%newsletter_campaigns%'`,
      ),
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('the write did not wait for the campaign');
}

// the key of the lock the route that schedules takes first (campaignSchedule.service.ts)
export const SCHEDULE_LOCK = 'cartlify.newsletter_schedule';

// waits until a session waits for an advisory lock of the database (a request that schedules, standing
// at the lock a test holds)
export async function requestWaitsForScheduleLock(ms = 5000): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < ms) {
    const rows = await inOwnerTx((db) =>
      db.rows(
        `select 1 from pg_locks where locktype = 'advisory' and not granted and pid <> pg_backend_pid()`,
      ),
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('the request did not wait for the lock of the schedule');
}

// the totals of a campaign that went out: the mails the provider took, the ones it did not, the
// ones that did not arrive and the complaints (the planned and the unsubscribed ones are no matter
// to the alerts)
export type CampaignTotals = {
  sent?: number;
  rejected?: number;
  undelivered?: number;
  complaints?: number;
};

// a campaign made and taken to a state by the steps of the app, with the totals asked, committed so
// the app sees it. The totals are written the way the functions of the database write them (a
// campaign that has not started has none). Like every campaign past `scheduled`, it stays in the
// database of the test run
export async function campaignWithTotals(
  user: Pick<TestUser, 'id' | 'role'>,
  state: Exclude<CampaignState, 'cancelled'>,
  totals: CampaignTotals = {},
  endedAt: string = utc(),
  times: { scheduledAt?: string; startedAt?: string } = {},
): Promise<number> {
  return inOwnerTx(
    async (db) => {
      const id = await campaignIn(db, actorOf(user), state, endedAt, {}, times);
      if (state === 'scheduled') return id;

      await db.rows(
        `update cartlify.newsletter_campaigns
         set "sentCount" = $2::int, "rejectedCount" = $3::int,
             "undeliveredCount" = $4::int, "complaintCount" = $5::int
         where id = $1`,
        id,
        totals.sent ?? 0,
        totals.rejected ?? 0,
        totals.undelivered ?? 0,
        totals.complaints ?? 0,
      );
      return id;
    },
    { commit: true },
  );
}

// a campaign the limit of the campaigns called off, or one the manager called off, made by the steps of
// the app and committed; `endedAt` is when it was called off. Like every campaign past `scheduled`, it
// stays in the database of the test run
export async function cancelledCampaign(
  user: Pick<TestUser, 'id' | 'role'>,
  opts: {
    endedAt?: string;
    by?: 'manager' | 'limit';
    scheduledAt?: string;
    content?: Record<string, unknown>;
  } = {},
): Promise<number> {
  return inOwnerTx(
    (db) =>
      campaignIn(
        db,
        actorOf(user),
        'cancelled',
        opts.endedAt ?? utc(),
        opts.content ? { content: opts.content } : {},
        {
          ...(opts.scheduledAt ? { scheduledAt: opts.scheduledAt } : {}),
          ...(opts.by === 'limit' ? { cancelReason: 'limit' as const } : {}),
        },
      ),
    { commit: true },
  );
}
