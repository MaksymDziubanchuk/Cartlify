import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { emailHmacOf } from '@helpers/newsletterTokens.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin, inCommittedTx } from '../../../helpers/db.js';
import { createUser } from '../../../helpers/factories.js';
import { watchMail, watchNewsletterMail } from '../../../helpers/mail.js';
import { arrange, blockAddress, isBlocked, rowsOf } from '../../../helpers/newsletterApi.js';
import {
  draftCampaignIn,
  eventRow,
  insertRow,
  recipientRow,
  removeSubscriptionRows,
  type SubscriptionOpts,
} from '../../../helpers/newsletterDb.js';
import {
  auditLinesOf,
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../../helpers/newsletterStaff.js';
import { inOwnerTx } from '../../../helpers/ownerDb.js';

// An admin erases a subscriber on the word of the person (the request comes to support@): DELETE
// /api/newsletters/subscribers/:subscriberId. Nothing is deleted: every subscription the address ever
// had is made anonymous in place (the address becomes the placeholder of the row, the links and the
// hashes are replaced, what is live ends, the address and the browser of its journal are emptied), and
// the rows stay as the proof that there was a consent; the blocklist and the mails of the campaigns
// are not touched. A line of the admin log names the admin and the subscriber by its id, never the
// address; no mail goes to the person. What the function of the database does for each state of a
// subscription is the test of the database (db/newsletterErase)

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
const ids: number[] = [];
const emails: string[] = [];
const campaigns: number[] = [];

const tag = randomBytes(5).toString('hex');
let counter = 0;
const addressOf = () => `${tag}-${++counter}@example.com`;
const placeholderOf = (id: number) => `deleted+${id}@deleted.invalid`;

const erase = (id: number | string, cookie = accessCookie(staff.manager)) =>
  app.inject({
    method: 'DELETE',
    url: `/api/newsletters/subscribers/${id}`,
    headers: withCsrf(csrf, cookie),
  });

async function made(opts: SubscriptionOpts = {}) {
  const email = opts.email ?? addressOf();
  emails.push(email);
  const subscription = await arrange({ ...opts, email });
  ids.push(subscription.id);
  return subscription;
}

type Row = {
  email: string;
  emailHmac: string | null;
  status: string;
  endReason: string | null;
  endedAt: Date | null;
  manageSalt: string;
};

// the row as the database keeps it, by its id (the address is gone from it, so rowsOf finds nothing)
const rowById = (id: number) =>
  inOwnerTx(async (db) => {
    const rows = await db.rows<Row>(
      `select email, "emailHmac", status::text as status, "endReason"::text as "endReason",
              "endedAt", "manageSalt"
       from cartlify.newsletter_subscriptions where id = $1`,
      id,
    );
    return rows[0] ?? null;
  });

// the lines of the journal and the mails of a subscription, as the rows keep them
const journalRowsOf = (subscriptionId: number) =>
  inOwnerTx((db) =>
    db.rows<{ id: number; ip: string | null; userAgent: string | null }>(
      'select id, ip, "userAgent" from cartlify.newsletter_subscription_events where "subscriptionId" = $1 order by id',
      subscriptionId,
    ),
  );

const recipientRowsOf = (subscriptionId: number) =>
  inOwnerTx((db) =>
    db.rows<{ id: number }>(
      'select id from cartlify.newsletter_recipients where "subscriptionId" = $1',
      subscriptionId,
    ),
  );

// waits until an erasure stands at a lock inside the function of the database
async function erasureWaitsForLock(): Promise<void> {
  for (let waited = 0; waited < 5000; waited += 50) {
    const rows = await inOwnerTx((db) =>
      db.rows(
        `select 1 from pg_stat_activity
         where wait_event_type = 'Lock' and pid <> pg_backend_pid()
           and query ilike '%newsletter_admin_erase_address%'`,
      ),
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the erasure did not wait for the lock');
}

// a subscription with two lines in its journal (with an address and a browser) and a mail waiting in
// a draft campaign (the draft is removed at the end of the file: a row of the owner of the database
// does not go by itself)
async function withHistory(opts: SubscriptionOpts = {}) {
  const subscription = await made(opts);
  const campaign = await inCommittedTx((db) =>
    draftCampaignIn(db, { role: 'ADMIN', userId: staff.manager.id }),
  );
  campaigns.push(campaign);

  await inOwnerTx(
    async (db) => {
      await insertRow(db, 'newsletter_subscription_events', eventRow(subscription.id));
      await insertRow(
        db,
        'newsletter_subscription_events',
        eventRow(subscription.id, { event: 'subscribed', place: 'profile' }),
      );
      await insertRow(db, 'newsletter_recipients', recipientRow(campaign, subscription.id));
    },
    { commit: true },
  );

  return subscription;
}

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  staff = await createNewsletterStaff();
});

afterAll(async () => {
  try {
    await removeSubscriptionRows(ids, emails.map(emailHmacOf));
    await inOwnerTx(
      async (db) => {
        await db.as({ role: 'ROOT', userId: staff.root.id });
        await db.rows(
          'delete from cartlify.newsletter_campaigns where id = any($1::int[])',
          campaigns,
        );
      },
      { commit: true },
    );
    await closeStaff(staff);
  } finally {
    await stopApp();
  }
});

describe('DELETE /api/newsletters/subscribers/:subscriberId', () => {
  it('makes the subscription anonymous in place: the address goes, the row, its journal and its mails stay', async () => {
    const { id, email } = await withHistory({ locale: 'uk' });
    expect(await journalRowsOf(id)).toHaveLength(2);
    expect(await recipientRowsOf(id)).toHaveLength(1);
    const before = (await rowById(id))!;

    const res = await erase(id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ erased: true, subscriptions: 1 });
    // the person is not found by the address any more, and the row is still there under its placeholder
    expect(await rowsOf(email)).toEqual([]);
    const row = (await rowById(id))!;
    expect(row).toMatchObject({
      email: placeholderOf(id),
      emailHmac: null,
      status: 'ended',
      endReason: 'removed_by_admin',
    });
    expect(row.endedAt).not.toBeNull();
    // the links of the mails the person was sent open nothing any more
    expect(row.manageSalt).not.toBe(before.manageSalt);
    // the journal is kept, without the address and the browser; the mails of the campaigns are kept
    const journal = await journalRowsOf(id);
    expect(journal).toHaveLength(2);
    for (const line of journal) expect(line).toMatchObject({ ip: null, userAgent: null });
    expect(await recipientRowsOf(id)).toHaveLength(1);
  });

  it.each<[string, SubscriptionOpts, string, string]>([
    [
      'a request that waits for its confirmation',
      { status: 'pending' },
      'ended',
      'removed_by_admin',
    ],
    ['a subscription in force', { status: 'active' }, 'ended', 'removed_by_admin'],
    [
      'a subscription a complaint paused',
      { status: 'paused_complaint' },
      'ended',
      'removed_by_admin',
    ],
    // an ending that happened already keeps its state and its reason
    ['a subscription a bounce stopped', { status: 'stopped_bounce' }, 'stopped_bounce', 'bounced'],
    ['a subscription that ended', { status: 'ended' }, 'ended', 'unsubscribed'],
    [
      'a subscription of an account',
      { source: 'account', status: 'active' },
      'ended',
      'removed_by_admin',
    ],
  ])('makes %s anonymous', async (_name, opts, state, reason) => {
    const user = opts.source === 'account' ? await createUser() : null;
    const { id, email } = await withHistory({ ...opts, ...(user ? { userId: user.id } : {}) });

    const res = await erase(id);

    expect(res.statusCode).toBe(200);
    expect(await rowsOf(email)).toEqual([]);
    expect(await rowById(id)).toMatchObject({
      email: placeholderOf(id),
      status: state,
      endReason: reason,
    });
    expect(await journalRowsOf(id)).toHaveLength(2);
    expect(await recipientRowsOf(id)).toHaveLength(1);
  });

  // an address may have had many subscriptions (one that ended, one asked for again): the erasure is
  // of the address, whichever row names it
  it('makes every subscription of the address anonymous, whichever of them the id names', async () => {
    const email = addressOf();
    const older = await made({ email, status: 'ended' });
    const live = await made({ email, status: 'active' });
    const other = await made({ status: 'active' });

    const res = await erase(older.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ erased: true, subscriptions: 2 });
    for (const id of [older.id, live.id]) {
      expect(await rowById(id)).toMatchObject({ email: placeholderOf(id), status: 'ended' });
    }
    expect(await rowsOf(email)).toEqual([]);
    // another address is as it was
    expect(await rowsOf(other.email)).toHaveLength(1);
  });

  it('leaves the account of a subscriber as it is', async () => {
    const user = await createUser();
    const { id } = await made({ source: 'account', status: 'active', userId: user.id });

    expect((await erase(id)).statusCode).toBe(200);

    const kept = await asAdmin((tx) =>
      tx.user.findUnique({ where: { id: user.id }, select: { email: true, deletedAt: true } }),
    );
    expect(kept).toEqual({ email: user.email, deletedAt: null });
  });

  it('leaves the other subscriptions as they are', async () => {
    const wanted = await made({ status: 'active' });
    const other = await made({ status: 'active' });

    expect((await erase(wanted.id)).statusCode).toBe(200);

    expect(await rowsOf(other.email)).toHaveLength(1);
    expect((await rowsOf(other.email))[0]!.status).toBe('active');
  });

  // the blocklist holds the HMAC of an address that asked for no more mail: erasing the person must
  // not let the address back in
  it('leaves the blocklist as it is: a blocked address stays blocked', async () => {
    const { id, email } = await made({ status: 'active' });
    await blockAddress(email);
    expect(await isBlocked(email)).toBe(true);

    expect((await erase(id)).statusCode).toBe(200);

    expect(await isBlocked(email)).toBe(true);
  });

  it('is no longer found by the old address in the list, and the placeholder is not an address a person typed', async () => {
    const { id, email } = await made({ status: 'active' });
    expect((await erase(id)).statusCode).toBe(200);

    const res = await app.inject({
      method: 'GET',
      url: `/api/newsletters/subscribers?email=${encodeURIComponent(email)}`,
      headers: { cookie: accessCookie(staff.manager) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  describe('the line of the admin log', () => {
    it.each([
      ['an admin whom root allowed', () => staff.manager, 'ADMIN'],
      ['root', () => staff.root, 'ROOT'],
    ] as const)(
      'names %s and the subscriber, in the same step as the erasure',
      async (_who, actor, role) => {
        const { id, email } = await made({ source: 'form', status: 'active', locale: 'uk' });

        expect((await erase(id, accessCookie(actor()))).statusCode).toBe(200);

        const lines = await auditLinesOf('newsletter_subscriber', id);
        expect(lines).toEqual([
          {
            actorId: actor().id,
            actorRole: role,
            entityType: 'newsletter_subscriber',
            entityId: id,
            action: 'NEWSLETTER_SUBSCRIBER_DELETE',
            event: 'newsletter.subscriber_erased',
            meta: [
              { field: 'status', old: 'active', new: 'ended' },
              { field: 'email', old: 'present', new: 'erased' },
              { field: 'subscriptions', old: null, new: 1 },
            ],
          },
        ]);
        // the address of a person who asked to be forgotten is in no line of the log
        expect(JSON.stringify(lines)).not.toContain(email);
        expect(JSON.stringify(lines)).not.toContain(tag);
        expect(JSON.stringify(lines)).not.toContain('@');
      },
    );

    it('says how many subscriptions of the address were made anonymous, and the state of the one named', async () => {
      const email = addressOf();
      const older = await made({ email, status: 'stopped_bounce' });
      await made({ email, status: 'ended' });

      expect((await erase(older.id)).statusCode).toBe(200);

      const [line] = await auditLinesOf('newsletter_subscriber', older.id);
      expect(line!.meta).toEqual([
        { field: 'status', old: 'stopped_bounce', new: 'stopped_bounce' },
        { field: 'email', old: 'present', new: 'erased' },
        { field: 'subscriptions', old: null, new: 2 },
      ]);
    });

    it('is written once for a subscription two admins erase together: the other one finds nothing', async () => {
      const { id } = await made({ status: 'active' });

      const answers = await Promise.all([erase(id), erase(id, accessCookie(staff.root))]);

      expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 404]);
      expect(await auditLinesOf('newsletter_subscriber', id)).toHaveLength(1);
    });

    // the request has read the subscription and stands at the lock of its address inside the function
    // of the database; the subscription is removed meanwhile (by the cleanup of an ended one, say) and
    // the function finds nothing: 404, and no line
    it('is not written for a subscription that is removed while the request waits', async () => {
      const { id, email } = await made({ status: 'active' });
      let pending!: ReturnType<typeof erase>;

      await inOwnerTx(
        async (db) => {
          await db.rows(
            'select pg_advisory_xact_lock(hashtext($1))',
            `cartlify.newsletter.${email}`,
          );
          pending = erase(id);
          await erasureWaitsForLock();
          await removeSubscriptionRows([id]);
        },
        { commit: true },
      );
      const res = await pending;

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_SUBSCRIBER_NOT_FOUND' });
      expect(await auditLinesOf('newsletter_subscriber', id)).toEqual([]);
    });
  });

  describe('a subscriber that is not there', () => {
    it('answers 404 for an id no subscription has, and writes no line', async () => {
      const id = 2_147_483_000;

      const res = await erase(id);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_SUBSCRIBER_NOT_FOUND' });
      expect(await auditLinesOf('newsletter_subscriber', id)).toEqual([]);
    });

    // the row is there, but there is nothing in it left to erase
    it('answers 404 the second time, and writes no second line', async () => {
      const { id } = await made({ status: 'active' });
      expect((await erase(id)).statusCode).toBe(200);

      const again = await erase(id);

      expect(again.statusCode).toBe(404);
      expect(again.json()).toMatchObject({ errorCode: 'NEWSLETTER_SUBSCRIBER_NOT_FOUND' });
      expect(await auditLinesOf('newsletter_subscriber', id)).toHaveLength(1);
      expect(await rowById(id)).toMatchObject({ email: placeholderOf(id), status: 'ended' });
    });

    it.each(['abc', '0', '-1', '01', '1.5', '1e3'])('refuses the id %s', async (id) => {
      const res = await erase(id);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    });

    it('refuses an id past the numbers the database keeps', async () => {
      const res = await erase('2147483648');

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'INVALID_ID_PARAM' });
    });
  });

  it('sends no mail to the person', async () => {
    const orders = watchMail();
    const newsletters = watchNewsletterMail();
    const { id } = await withHistory({ status: 'active' });

    expect((await erase(id)).statusCode).toBe(200);

    expect(orders).toEqual([]);
    expect(newsletters).toEqual([]);
  });

  it('is not for an admin without the right: the subscription stays', async () => {
    const { id, email } = await made({ status: 'active' });

    const res = await erase(id, accessCookie(staff.plainAdmin));

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_MANAGER_REQUIRED' });
    expect(await rowsOf(email)).toHaveLength(1);
    expect(await auditLinesOf('newsletter_subscriber', id)).toEqual([]);
  });

  it('is not for a user: the subscription stays', async () => {
    const { id, email } = await made({ status: 'active' });

    const res = await erase(id, accessCookie(staff.user));

    expect(res.statusCode).toBe(403);
    expect(await rowsOf(email)).toHaveLength(1);
  });
});
