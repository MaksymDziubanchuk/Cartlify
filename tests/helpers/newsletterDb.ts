import { randomBytes } from 'node:crypto';

import { inCommittedTx, type Actor, type DbSession } from './db.js';
import { createUser, uniqueEmail, type TestUser } from './factories.js';
import { inOwnerTx, type OwnerSession } from './ownerDb.js';

// rows of the newsletter tables for the tests of the database. Only the owner of the database
// writes a subscription, a journal line, a recipient or a blocklist row (the functions of the
// database do it for the app), so a test makes them with an owner session; a campaign is written
// by the one who runs the newsletters, so it is made as that actor

const DAY = 86_400_000;

// a sha256 or an HMAC in hex, the form the tokens and the blocklist keep
export const hex64 = () => randomBytes(32).toString('hex');

// a moment for a timestamp column (utc, which a column without a time zone reads as it is)
export const utc = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

export type SubscriptionStatus =
  'pending' | 'active' | 'paused_complaint' | 'stopped_bounce' | 'ended';
export type CampaignStatus =
  'draft' | 'scheduled' | 'sending' | 'finished' | 'cancelled' | 'stopped';

export type SubscriptionOpts = {
  email?: string;
  source?: 'form' | 'account';
  userId?: number | undefined;
  status?: SubscriptionStatus;
  locale?: string | null;
  // columns to set over the rest, to make a row the checks refuse
  set?: Record<string, unknown>;
};

// the columns of a subscription that is valid for its source and its status
export function subscriptionRow(opts: SubscriptionOpts = {}): Record<string, unknown> {
  const source = opts.source ?? 'form';
  const status = opts.status ?? 'active';
  const ended = status === 'ended' || status === 'stopped_bounce';

  return {
    email: opts.email ?? uniqueEmail('news'),
    emailHmac: source === 'form' ? hex64() : null,
    userId: source === 'account' ? (opts.userId ?? null) : null,
    source,
    locale: opts.locale ?? null,
    status,
    confirmHash: status === 'pending' ? hex64() : null,
    confirmExpiresAt: status === 'pending' ? utc(3 * DAY) : null,
    manageSalt: hex64(),
    manageHash: hex64(),
    unsubscribeHash: hex64(),
    // a request that waits was not confirmed; every other row was (an ended one that never was is
    // made with set: { confirmedAt: null })
    confirmedAt: status === 'pending' ? null : utc(),
    endedAt: ended ? utc() : null,
    endReason: ended ? (status === 'stopped_bounce' ? 'bounced' : 'unsubscribed') : null,
    ...opts.set,
  };
}

function insertSql(table: string, row: Record<string, unknown>) {
  const names = Object.keys(row);

  return {
    sql: `insert into cartlify.${table} (${names.map((name) => `"${name}"`).join(', ')})
          values (${names.map((_, index) => `$${index + 1}`).join(', ')}) returning id`,
    values: Object.values(row),
  };
}

// an insert that has to work: the id of the row
export async function insertRow(
  db: OwnerSession,
  table: string,
  row: Record<string, unknown>,
): Promise<number> {
  const { sql, values } = insertSql(table, row);
  const [created] = await db.rows<{ id: number }>(sql, ...values);
  return created!.id;
}

// an insert the database may refuse
export function attemptInsert(db: OwnerSession, table: string, row: Record<string, unknown>) {
  const { sql, values } = insertSql(table, row);
  return db.attempt<{ id: number }>(sql, ...values);
}

export const insertSubscription = (db: OwnerSession, opts: SubscriptionOpts = {}) =>
  insertRow(db, 'newsletter_subscriptions', subscriptionRow(opts));

export const attemptSubscription = (db: OwnerSession, opts: SubscriptionOpts = {}) =>
  attemptInsert(db, 'newsletter_subscriptions', subscriptionRow(opts));

export const eventRow = (
  subscriptionId: number,
  set: Record<string, unknown> = {},
): Record<string, unknown> => ({
  subscriptionId,
  event: 'requested',
  place: 'form',
  ip: '203.0.113.7',
  userAgent: 'test-agent',
  locale: 'en',
  ...set,
});

export const recipientRow = (
  campaignId: number,
  subscriptionId: number,
  set: Record<string, unknown> = {},
): Record<string, unknown> => ({ campaignId, subscriptionId, locale: 'en', ...set });

export const blockRow = (set: Record<string, unknown> = {}): Record<string, unknown> => ({
  emailHmac: hex64(),
  byPerson: true,
  ...set,
});

// the text of a campaign: the subject and the preview of each language, and one list of blocks for
// all of them with the text of each language inside (the shape the routes of the campaigns keep)
export const CAMPAIGN_CONTENT = {
  subject: { en: 'Spring sale' },
  preview: { en: 'Up to 30% off' },
  blocks: [{ type: 'text', text: { en: 'Hello' } }],
};

// in a session of the app role: the person who runs the newsletters makes a draft; its id
export async function draftCampaignIn(
  db: DbSession,
  actor: Actor,
  name = 'Spring sale',
): Promise<number> {
  await db.as(actor);
  const [row] = await db.rows<{ id: number }>(
    `insert into cartlify.newsletter_campaigns (name, "missingLocale", content, "createdById", "updatedById")
     values ($1, 'shop_locale', $2::jsonb, $3::int, $3::int) returning id`,
    name,
    JSON.stringify(CAMPAIGN_CONTENT),
    actor.userId,
  );
  return row!.id;
}

// a moment some days (and minutes) before the transaction, as text the database reads back exactly
// (a timestamp without a time zone, the way the columns keep it)
export async function agoIn(
  db: Pick<OwnerSession, 'rows'>,
  days: number,
  minutes = 0,
): Promise<string> {
  const [row] = await db.rows<{ at: string }>(
    `select ((now() at time zone 'utc') - make_interval(days => $1::int, mins => $2::int))::text as at`,
    days,
    minutes,
  );
  return row!.at;
}

export type CampaignState = 'scheduled' | 'sending' | 'finished' | 'stopped' | 'cancelled';

const SYSTEM_ACTOR: Actor = { role: 'ADMIN' };

// a draft campaign taken to the state asked, the way the app does it (a manager schedules, cancels
// or stops it, the system starts and finishes it), each step by its own actor. It works in a
// session of the app role as in one of the owner: every step is an update the policies let that
// actor make. The guards let the moments be any, so a campaign can end long ago: endedAt is the
// moment of the finish, the stop or the cancellation (a start is an hour earlier, and it was
// scheduled for the moment it started). `times` names the moment it was scheduled for and the moment
// it began when they are to differ, as a campaign the system picked up late does. `cancelReason`
// 'limit' makes the cancellation the system's (the limit of the campaigns, when the worker starts it),
// not the manager's
export async function moveCampaignTo(
  db: OwnerSession,
  manager: Actor,
  id: number,
  state: CampaignState,
  endedAt: string = utc(),
  times: { scheduledAt?: string; startedAt?: string; cancelReason?: 'limit' } = {},
): Promise<void> {
  const hourBefore = new Date(new Date(endedAt).getTime() - 3_600_000).toISOString();
  const startedAt = times.startedAt ?? hourBefore;
  const scheduledAt = times.scheduledAt ?? startedAt;
  const moves = (set: string) => `update cartlify.newsletter_campaigns set ${set} where id = $1`;

  await db.as(manager);
  await db.rows(
    moves(`status = 'scheduled', "scheduledAt" = $2::timestamp, "updatedById" = $3::int`),
    id,
    scheduledAt,
    manager.userId,
  );

  if (state === 'cancelled' && times.cancelReason) {
    await db.as(SYSTEM_ACTOR);
    await db.rows(
      moves(
        `status = 'cancelled', "cancelledAt" = $2::timestamp, "cancelReason" = $3::cartlify."NewsletterCancelReason"`,
      ),
      id,
      endedAt,
      times.cancelReason,
    );
    return;
  }

  if (state === 'cancelled') {
    await db.rows(
      moves(`status = 'cancelled', "cancelledAt" = $2::timestamp, "updatedById" = $3::int`),
      id,
      endedAt,
      manager.userId,
    );
    return;
  }

  if (state === 'scheduled') return;

  await db.as(SYSTEM_ACTOR);
  await db.rows(
    moves(`status = 'sending', "startedAt" = $2::timestamp, "plannedCount" = 1`),
    id,
    startedAt,
  );

  if (state === 'finished') {
    await db.rows(moves(`status = 'finished', "finishedAt" = $2::timestamp`), id, endedAt);
  } else if (state === 'stopped') {
    await db.as(manager);
    await db.rows(
      moves(`status = 'stopped', "stoppedAt" = $2::timestamp, "updatedById" = $3::int`),
      id,
      endedAt,
      manager.userId,
    );
  }
}

// in an owner session: a campaign made by the manager and taken to the state asked (moveCampaignTo);
// `set` names the text and the rule for the languages it has no text in, when a case needs them
export async function campaignIn(
  db: OwnerSession,
  manager: Actor,
  state: CampaignState,
  endedAt: string = utc(),
  set: { content?: unknown; missingLocale?: 'shop_locale' | 'skip' } = {},
  times: { scheduledAt?: string; startedAt?: string; cancelReason?: 'limit' } = {},
): Promise<number> {
  await db.as(manager);
  const id = await insertRow(db, 'newsletter_campaigns', {
    name: `Campaign ${hex64().slice(0, 8)}`,
    missingLocale: set.missingLocale ?? 'shop_locale',
    content: JSON.stringify(set.content ?? CAMPAIGN_CONTENT),
    createdById: manager.userId,
    updatedById: manager.userId,
  });

  await moveCampaignTo(db, manager, id, state, endedAt, times);
  return id;
}

export type RecipientState =
  'queued' | 'sent' | 'rejected' | 'skipped' | 'bounced' | 'dropped' | 'complained';

// in an owner session: the mail of a campaign to a subscription, in the state asked (a row is made
// as a mail that waits, then moves the way the sending moves it); set takes over the columns of the
// insert (the moment the row was made, its language)
export async function recipientIn(
  db: OwnerSession,
  campaignId: number,
  subscriptionId: number,
  state: RecipientState = 'sent',
  set: Record<string, unknown> = {},
): Promise<number> {
  const id = await insertRow(
    db,
    'newsletter_recipients',
    recipientRow(campaignId, subscriptionId, set),
  );

  if (state === 'queued') return id;

  await db.rows(
    `update cartlify.newsletter_recipients
     set status = $2::cartlify."NewsletterRecipientStatus", attempts = 1,
         "sentAt" = case when $2 in ('rejected', 'skipped') then null else $3::timestamp end,
         "providerMessageId" = case when $2 in ('rejected', 'skipped') then null else $4 end
     where id = $1`,
    id,
    state,
    utc(),
    `message-${id}`,
  );
  return id;
}

// the people and the rows the tests of the access and of the guards read: an account that has a
// subscription, a stranger, an admin without the right to run the newsletters, one with it, root;
// the subscriptions (of the account, of the form, an ended one with a journal), a draft campaign
// with a recipient, a blocked address. They are committed, because the app role has to find them;
// removeNewsletterFixtures takes them away
export type NewsletterFixtures = {
  subscriber: TestUser;
  stranger: TestUser;
  plainAdmin: TestUser;
  manager: TestUser;
  root: TestUser;
  accountSub: number;
  formSub: number;
  endedSub: number;
  accountEvent: number;
  endedEvent: number;
  campaign: number;
  recipient: number;
  block: number;
};

export async function setupNewsletterFixtures(): Promise<NewsletterFixtures> {
  const subscriber = await createUser();
  const stranger = await createUser();
  const plainAdmin = await createUser({ role: 'ADMIN' });
  const manager = await createUser({ role: 'ADMIN' });
  const root = await createUser({ role: 'ROOT' });

  // root allows the admin: the step of the database that only root's function takes
  await inOwnerTx(
    async (db) => {
      await db.as({ role: 'ROOT', userId: root.id });
      await db.rows(
        'update cartlify.users set "canManageNewsletters" = true where id = $1',
        manager.id,
      );
    },
    { commit: true },
  );

  const campaign = await inCommittedTx((db) =>
    draftCampaignIn(db, { role: 'ADMIN', userId: manager.id }),
  );

  return inOwnerTx(
    async (db) => {
      const accountSub = await insertSubscription(db, {
        source: 'account',
        userId: subscriber.id,
        email: subscriber.email,
      });
      const formSub = await insertSubscription(db, { locale: 'en' });
      const endedSub = await insertSubscription(db, { status: 'ended' });

      return {
        subscriber,
        stranger,
        plainAdmin,
        manager,
        root,
        accountSub,
        formSub,
        endedSub,
        accountEvent: await insertRow(db, 'newsletter_subscription_events', eventRow(accountSub)),
        endedEvent: await insertRow(db, 'newsletter_subscription_events', eventRow(endedSub)),
        campaign,
        recipient: await insertRow(db, 'newsletter_recipients', recipientRow(campaign, formSub)),
        block: await insertRow(db, 'newsletter_form_blocklist', blockRow()),
      };
    },
    { commit: true },
  );
}

// takes subscriptions away the way the database lets: each is ended first (an ended one stays as
// it is), then its journal goes, then the row itself (its recipients with it)
async function deleteSubscriptions(db: OwnerSession, ids: number[]): Promise<void> {
  if (ids.length === 0) return;

  await db.rows(
    `update cartlify.newsletter_subscriptions
     set status = 'ended', "confirmHash" = null, "confirmExpiresAt" = null,
         "endedAt" = $2::timestamp, "endReason" = 'unsubscribed'
     where id = any($1::int[]) and status <> 'ended'`,
    ids,
    utc(),
  );
  await db.rows(
    'delete from cartlify.newsletter_subscription_events where "subscriptionId" = any($1::int[])',
    ids,
  );
  await db.rows('delete from cartlify.newsletter_subscriptions where id = any($1::int[])', ids);
}

// the rows a test committed with an owner session (the arrangement of its cases), taken away at its
// end: the subscriptions with their journals, and the blocked addresses by their HMACs
export async function removeSubscriptionRows(
  ids: number[],
  blockedHmacs: string[] = [],
): Promise<void> {
  await inOwnerTx(
    async (db) => {
      await db.rows(
        'delete from cartlify.newsletter_form_blocklist where "emailHmac" = any($1::text[])',
        blockedHmacs,
      );
      await deleteSubscriptions(db, ids);
    },
    { commit: true },
  );
}

// takes the rows of the fixtures away the way the database lets: a subscription is ended first,
// then its journal and itself go (its recipients with it), the draft campaign is deleted by the one
// who made it
export async function removeNewsletterFixtures(fx: NewsletterFixtures): Promise<void> {
  await inOwnerTx(
    async (db) => {
      await db.rows('delete from cartlify.newsletter_form_blocklist where id = $1', fx.block);
      await deleteSubscriptions(db, [fx.accountSub, fx.formSub, fx.endedSub]);
      await db.as({ role: 'ROOT', userId: fx.root.id });
      await db.rows('delete from cartlify.newsletter_campaigns where id = $1', fx.campaign);
    },
    { commit: true },
  );
}
