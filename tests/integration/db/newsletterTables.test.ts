import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession, type Outcome } from '../../helpers/db.js';
import { uniqueEmail } from '../../helpers/factories.js';
import {
  draftCampaignIn,
  hex64,
  removeNewsletterFixtures,
  setupNewsletterFixtures,
  utc,
  type NewsletterFixtures,
} from '../../helpers/newsletterDb.js';

// who reads and who writes the newsletter tables, as the role the app connects as (cartlify_app).
// A subscription is read by the manager of the newsletters (root, or an admin root allowed), by the
// system and by the account it belongs to; a journal line, a campaign, a recipient and a blocked
// address only by the people who run the newsletters (the campaign and the recipient by the system
// too). Nobody writes a subscription, a journal line, a recipient or a blocked address with a
// statement of their own: the functions of the database do (they run as the owner, which
// newsletterGuards.test.ts tries). A campaign is written by the manager. The rows are committed
// fixtures; every statement of a test rolls back

let fx: NewsletterFixtures;

beforeAll(async () => {
  fx = await setupNewsletterFixtures();
});

afterAll(async () => {
  try {
    if (fx) await removeNewsletterFixtures(fx);
  } finally {
    await prisma.$disconnect();
  }
});

const ACTOR_NAMES = [
  'nobody',
  'guest',
  'subscriber',
  'stranger',
  'plainAdmin',
  'manager',
  'root',
  'system',
] as const;
type ActorName = (typeof ACTOR_NAMES)[number];

// the system: the admin context without a user id, the way setAdminContext sets it
const actorOf = (name: ActorName): Actor | null => {
  switch (name) {
    case 'nobody':
      return null;
    case 'guest':
      return { role: 'GUEST', guestId: randomUUID() };
    case 'subscriber':
      return { role: 'USER', userId: fx.subscriber.id };
    case 'stranger':
      return { role: 'USER', userId: fx.stranger.id };
    case 'plainAdmin':
      return { role: 'ADMIN', userId: fx.plainAdmin.id };
    case 'manager':
      return { role: 'ADMIN', userId: fx.manager.id };
    case 'root':
      return { role: 'ROOT', userId: fx.root.id };
    case 'system':
      return { role: 'ADMIN' };
  }
};

// what a statement came to: the row it touched, nothing to touch, or the code it was refused with
const resultOf = (outcome: Outcome): string =>
  outcome.ok ? (outcome.rows.length ? 'row' : 'none') : (outcome.code ?? 'refused');

const everyone = (result: string): Record<ActorName, string> =>
  Object.fromEntries(ACTOR_NAMES.map((name) => [name, result])) as Record<ActorName, string>;

// the result of one statement for every actor, each in a transaction of its own that rolls back
async function forEachActor(
  statement: (db: DbSession, name: ActorName) => Promise<Outcome>,
): Promise<Record<ActorName, string>> {
  const results = {} as Record<ActorName, string>;

  for (const name of ACTOR_NAMES) {
    results[name] = await inRolledBackTx(async (db) => {
      await db.as(actorOf(name));
      return resultOf(await statement(db, name));
    });
  }

  return results;
}

type Reading = {
  table: string;
  ids: () => number[];
  // who sees every row
  readers: ActorName[];
  // an actor that sees only its own rows
  own?: { actor: ActorName; ids: () => number[] };
};

const READINGS: Reading[] = [
  {
    table: 'newsletter_subscriptions',
    ids: () => [fx.accountSub, fx.formSub, fx.endedSub],
    readers: ['manager', 'root', 'system'],
    own: { actor: 'subscriber', ids: () => [fx.accountSub] },
  },
  {
    table: 'newsletter_subscription_events',
    ids: () => [fx.accountEvent, fx.endedEvent],
    readers: ['manager', 'root'],
  },
  {
    table: 'newsletter_campaigns',
    ids: () => [fx.campaign],
    readers: ['manager', 'root', 'system'],
  },
  {
    table: 'newsletter_recipients',
    ids: () => [fx.recipient],
    readers: ['manager', 'root', 'system'],
  },
  {
    table: 'newsletter_form_blocklist',
    ids: () => [fx.block],
    readers: ['manager', 'root'],
  },
];

describe.each(READINGS)('reading $table', ({ table, ids, readers, own }) => {
  it.each(ACTOR_NAMES)('shows %s the rows it may read', async (name) => {
    const seen = await inRolledBackTx(async (db) => {
      await db.as(actorOf(name));
      return db.rows<{ id: number }>(
        `select id from cartlify.${table} where id = any($1::int[]) order by id`,
        ids(),
      );
    });

    const expected = readers.includes(name) ? ids() : own?.actor === name ? own.ids() : [];

    expect(seen.map((row) => row.id)).toEqual([...expected].sort((a, b) => a - b));
  });
});

type Writing = {
  table: string;
  insert: () => { sql: string; values: unknown[] };
  update: () => { sql: string; values: unknown[] };
  delete: () => { sql: string; values: unknown[] };
  // who may update or delete a fixture row, the rest find no row they may touch
  updater?: ActorName[];
  deleter?: ActorName[];
};

const WRITINGS: Writing[] = [
  {
    table: 'newsletter_subscriptions',
    insert: () => ({
      sql: `insert into cartlify.newsletter_subscriptions
              (email, "emailHmac", source, status, "manageSalt", "manageHash", "unsubscribeHash")
            values ($1, $2, 'form', 'active', $3, $4, $5) returning id`,
      values: [uniqueEmail('news'), hex64(), hex64(), hex64(), hex64()],
    }),
    update: () => ({
      sql: `update cartlify.newsletter_subscriptions set locale = 'es' where id = $1 returning id`,
      values: [fx.formSub],
    }),
    delete: () => ({
      sql: 'delete from cartlify.newsletter_subscriptions where id = $1 returning id',
      values: [fx.endedSub],
    }),
  },
  {
    table: 'newsletter_subscription_events',
    insert: () => ({
      sql: `insert into cartlify.newsletter_subscription_events ("subscriptionId", event, place)
            values ($1::int, 'requested', 'form') returning id`,
      values: [fx.formSub],
    }),
    update: () => ({
      sql: `update cartlify.newsletter_subscription_events set place = 'system' where id = $1 returning id`,
      values: [fx.endedEvent],
    }),
    delete: () => ({
      sql: 'delete from cartlify.newsletter_subscription_events where id = $1 returning id',
      values: [fx.endedEvent],
    }),
  },
  {
    table: 'newsletter_recipients',
    insert: () => ({
      sql: `insert into cartlify.newsletter_recipients ("campaignId", "subscriptionId", locale)
            values ($1::int, $2::int, 'en') returning id`,
      values: [fx.campaign, fx.accountSub],
    }),
    update: () => ({
      sql: 'update cartlify.newsletter_recipients set attempts = attempts + 1 where id = $1 returning id',
      values: [fx.recipient],
    }),
    delete: () => ({
      sql: 'delete from cartlify.newsletter_recipients where id = $1 returning id',
      values: [fx.recipient],
    }),
    // the system records how the sending went
    updater: ['system'],
  },
  {
    table: 'newsletter_form_blocklist',
    insert: () => ({
      sql: `insert into cartlify.newsletter_form_blocklist ("emailHmac", "byPerson")
            values ($1, true) returning id`,
      values: [hex64()],
    }),
    update: () => ({
      sql: `update cartlify.newsletter_form_blocklist set reason = 'spam' where id = $1 returning id`,
      values: [fx.block],
    }),
    delete: () => ({
      sql: 'delete from cartlify.newsletter_form_blocklist where id = $1 returning id',
      values: [fx.block],
    }),
    // an address is unblocked by the people who run the newsletters
    deleter: ['manager', 'root'],
  },
];

describe.each(WRITINGS)('writing $table', (writing) => {
  it('is not written to by a statement of any actor: the functions of the database do it', async () => {
    const results = await forEachActor((db) => {
      const { sql, values } = writing.insert();
      return db.attempt(sql, ...values);
    });

    expect(results).toEqual(everyone('42501'));
  });

  it('is changed by nobody but the actors it names', async () => {
    const results = await forEachActor((db) => {
      const { sql, values } = writing.update();
      return db.attempt(sql, ...values);
    });

    const expected = everyone('none');
    for (const name of writing.updater ?? []) expected[name] = 'row';

    expect(results).toEqual(expected);
  });

  it('is deleted from by nobody but the actors it names', async () => {
    const results = await forEachActor((db) => {
      const { sql, values } = writing.delete();
      return db.attempt(sql, ...values);
    });

    const expected = everyone('none');
    for (const name of writing.deleter ?? []) expected[name] = 'row';

    expect(results).toEqual(expected);
  });
});

describe('writing newsletter_campaigns', () => {
  const content = JSON.stringify({ en: { subject: 'Sale', preview: 'p', blocks: [] } });

  // a draft insert as the actor given; the ids named are the actor's own, or the manager's for an
  // actor without an id, so that only the policy decides
  const insertDraft = (db: DbSession, name: ActorName, set: { createdById?: number } = {}) => {
    const actor = actorOf(name);
    const own = actor?.userId ?? fx.manager.id;

    return db.attempt(
      `insert into cartlify.newsletter_campaigns (name, "missingLocale", content, "createdById", "updatedById")
       values ('Sale', 'shop_locale', $1::jsonb, $2::int, $3::int) returning id`,
      content,
      set.createdById ?? own,
      own,
    );
  };

  it('is made as a draft by the people who run the newsletters and nobody else', async () => {
    const results = await forEachActor((db, name) => insertDraft(db, name));

    expect(results).toEqual({ ...everyone('42501'), manager: 'row', root: 'row' });
  });

  it('names its maker: a manager cannot make a campaign in the name of another', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(actorOf('manager'));
      return insertDraft(db, 'manager', { createdById: fx.root.id });
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });

  it('is made as a draft only: a campaign that was started is the work of the system', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(actorOf('manager'));
      return db.attempt(
        `insert into cartlify.newsletter_campaigns
           (name, status, "scheduledAt", "missingLocale", content, "createdById", "updatedById")
         values ('Sale', 'scheduled', $1::timestamp, 'skip', $2::jsonb, $3::int, $3::int) returning id`,
        utc(86_400_000),
        content,
        fx.manager.id,
      );
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });

  it('is edited while it is a draft by the people who run the newsletters; the system may not', async () => {
    const results = await forEachActor(async (db, name) => {
      const id = await draftCampaignIn(db, { role: 'ADMIN', userId: fx.manager.id });
      await db.as(actorOf(name));
      return db.attempt(
        `update cartlify.newsletter_campaigns set name = 'Renamed', "updatedById" = cartlify.current_actor_id()
         where id = $1 returning id`,
        id,
      );
    });

    // the system passes the policy and is refused by the guard: it moves a campaign, never edits it
    expect(results).toEqual({
      ...everyone('none'),
      manager: 'row',
      root: 'row',
      system: '42501',
    });
  });

  it('is deleted while it is a draft by the people who run the newsletters', async () => {
    const results = await forEachActor(async (db, name) => {
      const id = await draftCampaignIn(db, { role: 'ADMIN', userId: fx.manager.id });
      await db.as(actorOf(name));
      return db.attempt('delete from cartlify.newsletter_campaigns where id = $1 returning id', id);
    });

    expect(results).toEqual({ ...everyone('none'), manager: 'row', root: 'row' });
  });

  it('is not deleted once it is scheduled: the work of it is kept', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const id = await draftCampaignIn(db, { role: 'ADMIN', userId: fx.manager.id });
      await db.rows(
        `update cartlify.newsletter_campaigns
         set status = 'scheduled', "scheduledAt" = $2::timestamp where id = $1`,
        id,
        utc(86_400_000),
      );
      return db.attempt('delete from cartlify.newsletter_campaigns where id = $1 returning id', id);
    });

    expect(resultOf(outcome)).toBe('none');
  });
});

describe('the helper that says who runs the newsletters', () => {
  it.each([
    ['nobody', false],
    ['guest', false],
    ['subscriber', false],
    ['stranger', false],
    ['plainAdmin', false],
    ['manager', true],
    ['root', true],
    ['system', false],
  ] as [ActorName, boolean][])('answers for %s: %s', async (name, expected) => {
    const [row] = await inRolledBackTx(async (db) => {
      await db.as(actorOf(name));
      return db.rows<{ manager: boolean }>('select cartlify.newsletter_manager() as manager');
    });

    expect(row).toEqual({ manager: expected });
  });

  it('does not take the id of an allowed admin for the right of another role', async () => {
    const [row] = await inRolledBackTx(async (db) => {
      await db.as({ role: 'USER', userId: fx.manager.id });
      return db.rows<{ manager: boolean }>('select cartlify.newsletter_manager() as manager');
    });

    expect(row).toEqual({ manager: false });
  });
});
