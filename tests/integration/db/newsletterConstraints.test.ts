import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { type Outcome } from '../../helpers/db.js';
import { createUser, type TestUser } from '../../helpers/factories.js';
import {
  attemptInsert,
  attemptSubscription,
  blockRow,
  CAMPAIGN_CONTENT,
  eventRow,
  hex64,
  insertRow,
  insertSubscription,
  recipientRow,
  subscriptionRow,
  utc,
  type SubscriptionOpts,
} from '../../helpers/newsletterDb.js';
import { inOwnerTx, type OwnerSession } from '../../helpers/ownerDb.js';

// the checks and the unique indexes of the newsletter tables (db/06), tried by inserting rows the
// way the functions of the database would, as the owner, in a transaction that rolls back

let user: TestUser;
let root: TestUser;

beforeAll(async () => {
  user = await createUser();
  root = await createUser({ role: 'ROOT' });
});

afterAll(async () => {
  await prisma.$disconnect();
});

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const DAY = 86_400_000;

const codeOf = (outcome: Outcome): string => (outcome.ok ? 'ok' : (outcome.code ?? 'refused'));

describe('a subscription', () => {
  it.each([
    ['of the form, waiting for the confirmation', { status: 'pending' }],
    ['of the form, in force', { status: 'active', locale: 'uk' }],
    ['of the form, in force with no language', { status: 'active', locale: null }],
    ['of the form, paused by a complaint', { status: 'paused_complaint' }],
    ['of the form, stopped by a bounce', { status: 'stopped_bounce' }],
    ['of the form, ended', { status: 'ended' }],
    // an admin erased the address: the HMAC of it is emptied, the row stays as the proof
    [
      'of the form, ended, without the HMAC of its address',
      { status: 'ended', set: { emailHmac: null } },
    ],
    [
      'of the form, stopped by a bounce, without the HMAC of its address',
      { status: 'stopped_bounce', set: { emailHmac: null } },
    ],
    ['of an account, in force', { source: 'account', status: 'active' }],
    ['of an account, ended', { source: 'account', status: 'ended' }],
  ] as [string, SubscriptionOpts][])('is made %s', async (_what, opts) => {
    const outcome = await inOwnerTx((db) =>
      attemptSubscription(db, {
        ...(opts.source === 'account' ? { userId: user.id } : {}),
        ...opts,
      }),
    );

    expect(codeOf(outcome)).toBe('ok');
  });

  // each row below is valid but for the one thing it names; an account row names the user
  const REFUSED: [string, (userId: number) => SubscriptionOpts][] = [
    ['an email in capitals', () => ({ set: { email: 'Someone@Example.com' } })],
    ['an email with spaces around it', () => ({ set: { email: ' someone@example.com ' } })],
    ['an empty email', () => ({ set: { email: '' } })],
    ['an email without an at sign', () => ({ set: { email: 'someone.example.com' } })],
    ['a language in capitals', () => ({ locale: 'EN' })],
    ['a language of one letter', () => ({ locale: 'e' })],
    ['a language that is not letters', () => ({ locale: '1a' })],
    ['an account without its user', () => ({ source: 'account' })],
    [
      'an account with the HMAC of the form',
      (id) => ({ source: 'account', userId: id, set: { emailHmac: hex64() } }),
    ],
    ['the form without its HMAC', () => ({ set: { emailHmac: null } })],
    [
      'the form waiting for its confirmation without its HMAC',
      () => ({ status: 'pending', set: { emailHmac: null } }),
    ],
    [
      'the form paused by a complaint without its HMAC',
      () => ({ status: 'paused_complaint', set: { emailHmac: null } }),
    ],
    [
      'the form that ended with an HMAC that is not hex',
      () => ({ status: 'ended', set: { emailHmac: 'not-hex' } }),
    ],
    [
      'the account that ended a subscription of an account',
      (id) => ({ source: 'account', userId: id, status: 'ended', set: { endedUserId: id } }),
    ],
    [
      'the account that ended a subscription that is in force',
      (id) => ({ status: 'active', set: { endedUserId: id } }),
    ],
    [
      'the account that ended a subscription that waits',
      (id) => ({ status: 'pending', set: { endedUserId: id } }),
    ],
    [
      'the account that ended a subscription stopped by a bounce',
      (id) => ({ status: 'stopped_bounce', set: { endedUserId: id } }),
    ],
    ['the form with an account', (id) => ({ set: { userId: id } })],
    ['an HMAC that is not hex', () => ({ set: { emailHmac: 'not-hex' } })],
    ['an HMAC of capitals', () => ({ set: { emailHmac: hex64().toUpperCase() } })],
    [
      'a pending one without the hash of its link',
      () => ({ status: 'pending', set: { confirmHash: null } }),
    ],
    [
      'a pending one without the deadline of its link',
      () => ({ status: 'pending', set: { confirmExpiresAt: null } }),
    ],
    [
      'a pending one that was confirmed',
      () => ({ status: 'pending', set: { confirmedAt: utc() } }),
    ],
    [
      'a pending one that has ended',
      () => ({ status: 'pending', set: { endedAt: utc(), endReason: 'not_me' } }),
    ],
    [
      'a hash of the link that is not a sha256',
      () => ({ status: 'pending', set: { confirmHash: 'not-a-hash' } }),
    ],
    [
      'one in force with the hash of a link',
      () => ({ status: 'active', set: { confirmHash: hex64() } }),
    ],
    [
      'one in force with the deadline of a link',
      () => ({ status: 'active', set: { confirmExpiresAt: utc(DAY) } }),
    ],
    ['one in force with an end', () => ({ status: 'active', set: { endedAt: utc() } })],
    [
      'one in force with a reason of an end',
      () => ({ status: 'active', set: { endReason: 'unsubscribed' } }),
    ],
    [
      'a paused one with an end',
      () => ({ status: 'paused_complaint', set: { endedAt: utc(), endReason: 'unsubscribed' } }),
    ],
    [
      'an ended one without the time of the end',
      () => ({ status: 'ended', set: { endedAt: null } }),
    ],
    ['an ended one without the reason', () => ({ status: 'ended', set: { endReason: null } })],
    [
      'an ended one with the reason of a bounce',
      () => ({ status: 'ended', set: { endReason: 'bounced' } }),
    ],
    [
      'a stopped one without the time',
      () => ({ status: 'stopped_bounce', set: { endedAt: null } }),
    ],
    [
      'a stopped one with a reason other than the bounce',
      () => ({ status: 'stopped_bounce', set: { endReason: 'unsubscribed' } }),
    ],
    [
      'a hash of the link of management that is not a sha256',
      () => ({ set: { manageHash: 'abc' } }),
    ],
    ['a salt that is too short', () => ({ set: { manageSalt: 'abc' } })],
    [
      'a hash of the link of the unsubscribe that is not a sha256',
      () => ({ set: { unsubscribeHash: 'abc' } }),
    ],
    [
      'a hash of the link of the unsubscribe in capitals',
      () => ({ set: { unsubscribeHash: hex64().toUpperCase() } }),
    ],
    [
      'one hash for the link of management and the link of the unsubscribe',
      () => {
        const same = hex64();
        return { set: { manageHash: same, unsubscribeHash: same } };
      },
    ],
  ];

  it.each(REFUSED)('is refused with %s', async (_what, make) => {
    const outcome = await inOwnerTx((db) => attemptSubscription(db, make(user.id)));

    expect(codeOf(outcome)).toBe(CHECK_VIOLATION);
  });

  // one address has at most one live subscription: waiting, in force or paused
  const LIVE = ['pending', 'active', 'paused_complaint'] as const;
  const PAIRS = LIVE.flatMap((first) => LIVE.map((second) => [first, second] as const));

  it.each(PAIRS)(
    'cannot be %s beside another that is %s for the same address',
    async (first, second) => {
      const outcome = await inOwnerTx(async (db) => {
        const email = subscriptionRow().email as string;
        await insertSubscription(db, { email, status: first });
        return attemptSubscription(db, { email, status: second });
      });

      expect(codeOf(outcome)).toBe(UNIQUE_VIOLATION);
    },
  );

  it.each(['ended', 'stopped_bounce'] as const)(
    'can be made again for an address whose earlier subscription is %s',
    async (earlier) => {
      const outcome = await inOwnerTx(async (db) => {
        const email = subscriptionRow().email as string;
        await insertSubscription(db, { email, status: earlier });
        return attemptSubscription(db, { email, status: 'active' });
      });

      expect(codeOf(outcome)).toBe('ok');
    },
  );

  it('keeps any number of ended subscriptions of one address as the proof of the consent', async () => {
    const outcomes = await inOwnerTx(async (db) => {
      const email = subscriptionRow().email as string;
      return [
        await attemptSubscription(db, { email, status: 'ended' }),
        await attemptSubscription(db, { email, status: 'ended' }),
        await attemptSubscription(db, { email, status: 'stopped_bounce' }),
      ].map(codeOf);
    });

    expect(outcomes).toEqual(['ok', 'ok', 'ok']);
  });

  it('is told apart by the address as written: a capital letter is refused, not a second address', async () => {
    const outcome = await inOwnerTx(async (db) => {
      const email = subscriptionRow().email as string;
      await insertSubscription(db, { email });
      return attemptSubscription(db, { email: email.toUpperCase() });
    });

    expect(codeOf(outcome)).toBe(CHECK_VIOLATION);
  });

  it('has its own link of the unsubscribe: two subscriptions cannot share one', async () => {
    const outcome = await inOwnerTx(async (db) => {
      const unsubscribeHash = hex64();
      await insertSubscription(db, { set: { unsubscribeHash } });
      return attemptSubscription(db, { set: { unsubscribeHash } });
    });

    expect(codeOf(outcome)).toBe(UNIQUE_VIOLATION);
  });

  it('cannot be made without a link of the unsubscribe', async () => {
    const outcome = await inOwnerTx((db) =>
      attemptSubscription(db, { set: { unsubscribeHash: null } }),
    );

    expect(codeOf(outcome)).toBe('23502');
  });

  it('names the account that ended it, when the form subscription ended with the account', async () => {
    const outcome = await inOwnerTx((db) =>
      attemptSubscription(db, {
        status: 'ended',
        set: { endReason: 'account_deleted', endedUserId: user.id },
      }),
    );

    expect(codeOf(outcome)).toBe('ok');
  });

  it('has a key to the account that empties the column when the account row goes', async () => {
    const [row] = await inOwnerTx((db) =>
      db.rows<{ onDelete: string; toUsers: boolean }>(
        `select c.confdeltype::text as "onDelete", c.confrelid = 'cartlify.users'::regclass as "toUsers"
         from pg_constraint c
         where c.conrelid = 'cartlify.newsletter_subscriptions'::regclass
           and c.conname = 'newsletter_subscriptions_endedUserId_fkey'`,
      ),
    );

    // n: set null
    expect(row).toEqual({ onDelete: 'n', toUsers: true });
  });

  it('has its own link of management: two subscriptions cannot share one', async () => {
    const outcome = await inOwnerTx(async (db) => {
      const manageHash = hex64();
      await insertSubscription(db, { set: { manageHash } });
      return attemptSubscription(db, { set: { manageHash } });
    });

    expect(codeOf(outcome)).toBe(UNIQUE_VIOLATION);
  });
});

describe('a line of the journal', () => {
  it('takes every event and every place', async () => {
    const outcomes = await inOwnerTx(async (db) => {
      const id = await insertSubscription(db);
      const events = [
        'requested',
        'confirmed',
        'subscribed',
        'locale_changed',
        'locale_reset',
        'unsubscribed',
        'complaint',
        'restored',
        'bounced',
        'account_deleted',
        'removed_by_admin',
        'expired',
        'not_me',
      ];
      const places = [
        'form',
        'registration',
        'profile',
        'manage_page',
        'mail_client',
        'webhook',
        'admin',
        'system',
      ];
      const outcomes: string[] = [];
      for (const event of events) {
        outcomes.push(
          codeOf(
            await attemptInsert(db, 'newsletter_subscription_events', eventRow(id, { event })),
          ),
        );
      }
      for (const place of places) {
        outcomes.push(
          codeOf(
            await attemptInsert(db, 'newsletter_subscription_events', eventRow(id, { place })),
          ),
        );
      }
      return outcomes;
    });

    expect(new Set(outcomes)).toEqual(new Set(['ok']));
    expect(outcomes).toHaveLength(21);
  });

  it('takes the version of the policy, the admin and the campaign it concerns', async () => {
    const outcome = await inOwnerTx(async (db) => {
      const id = await insertSubscription(db);
      await db.as({ role: 'ROOT', userId: root.id });
      const [campaign] = await db.rows<{ id: number }>(
        `insert into cartlify.newsletter_campaigns (name, "missingLocale", content, "createdById", "updatedById")
         values ('Lines', 'skip', $1::jsonb, $2::int, $2::int) returning id`,
        JSON.stringify(CAMPAIGN_CONTENT),
        root.id,
      );
      return attemptInsert(
        db,
        'newsletter_subscription_events',
        eventRow(id, {
          event: 'unsubscribed',
          place: 'mail_client',
          privacyVersion: 3,
          actorId: root.id,
          campaignId: campaign!.id,
        }),
      );
    });

    expect(codeOf(outcome)).toBe('ok');
  });

  it.each([
    ['a language in capitals', { locale: 'EN' }],
    ['a language of one letter', { locale: 'e' }],
    ['a version of the policy below 1', { privacyVersion: 0 }],
  ])('is refused with %s', async (_what, set) => {
    const outcome = await inOwnerTx(async (db) => {
      const id = await insertSubscription(db);
      return attemptInsert(db, 'newsletter_subscription_events', eventRow(id, set));
    });

    expect(codeOf(outcome)).toBe(CHECK_VIOLATION);
  });
});

describe('a campaign', () => {
  // the maker is named by the policy of insert; the checks are tried with the policies out of the
  // way, so that any shape of a row reaches them
  async function open(db: OwnerSession) {
    await db.rows('alter table cartlify.newsletter_campaigns no force row level security');
  }

  const campaignRow = (set: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'Spring sale',
    status: 'draft',
    missingLocale: 'shop_locale',
    content: JSON.stringify(CAMPAIGN_CONTENT),
    createdById: root.id,
    updatedById: root.id,
    ...set,
  });

  const T0 = () => utc(-DAY);
  const T1 = () => utc();

  const VALID: [string, Record<string, unknown>][] = [
    ['a draft', {}],
    ['a draft with a time chosen', { scheduledAt: utc(DAY) }],
    ['a scheduled one', { status: 'scheduled', scheduledAt: utc(DAY) }],
    [
      'one that is sending',
      { status: 'sending', startedAt: T0(), plannedCount: 5, productsSnapshot: '{"products":[]}' },
    ],
    [
      'a finished one',
      {
        status: 'finished',
        startedAt: T0(),
        finishedAt: T1(),
        plannedCount: 5,
        sentCount: 4,
        rejectedCount: 1,
      },
    ],
    ['a stopped one', { status: 'stopped', startedAt: T0(), stoppedAt: T1() }],
    ['a cancelled one', { status: 'cancelled', scheduledAt: utc(DAY), cancelledAt: T1() }],
    [
      'a cancelled one with the reason that the limit was reached',
      { status: 'cancelled', scheduledAt: utc(DAY), cancelledAt: T1(), cancelReason: 'limit' },
    ],
  ];

  it.each(VALID)('is made as %s', async (_what, set) => {
    const outcome = await inOwnerTx(async (db) => {
      await open(db);
      return attemptInsert(db, 'newsletter_campaigns', campaignRow(set));
    });

    expect(codeOf(outcome)).toBe('ok');
  });

  const REFUSED: [string, Record<string, unknown>][] = [
    ['an empty name', { name: '' }],
    ['a name with spaces at its edges', { name: ' Sale ' }],
    ['a text that is a list', { content: '[]' }],
    ['a text that is a string', { content: '"text"' }],
    ['a text that is null', { content: 'null' }],
    [
      'data of products that is a string',
      { status: 'sending', startedAt: T0(), productsSnapshot: '"x"' },
    ],
    [
      'a negative total of the planned mails',
      { status: 'sending', startedAt: T0(), plannedCount: -1 },
    ],
    ['a negative total of the sent mails', { status: 'sending', startedAt: T0(), sentCount: -1 }],
    [
      'a negative total of the rejected mails',
      { status: 'sending', startedAt: T0(), rejectedCount: -1 },
    ],
    [
      'a negative total of the undelivered mails',
      { status: 'sending', startedAt: T0(), undeliveredCount: -1 },
    ],
    [
      'a negative total of the complaints',
      { status: 'sending', startedAt: T0(), complaintCount: -1 },
    ],
    [
      'a negative total of the unsubscribes',
      { status: 'sending', startedAt: T0(), unsubscribedCount: -1 },
    ],
    ['a draft that started', { startedAt: T0() }],
    ['a draft with data of products', { productsSnapshot: '{"products":[]}' }],
    ['a draft with a total', { sentCount: 1 }],
    ['a scheduled one without a time', { status: 'scheduled' }],
    [
      'a scheduled one that started',
      { status: 'scheduled', scheduledAt: utc(DAY), startedAt: T0() },
    ],
    [
      'a scheduled one with a total',
      { status: 'scheduled', scheduledAt: utc(DAY), plannedCount: 2 },
    ],
    ['one that is sending without a start', { status: 'sending' }],
    ['one that is sending and finished', { status: 'sending', startedAt: T0(), finishedAt: T1() }],
    ['a finished one without the time it finished', { status: 'finished', startedAt: T0() }],
    ['a finished one without a start', { status: 'finished', finishedAt: T1() }],
    [
      'a finished one that was stopped',
      { status: 'finished', startedAt: T0(), finishedAt: T1(), stoppedAt: T1() },
    ],
    ['a stopped one without the time it stopped', { status: 'stopped', startedAt: T0() }],
    [
      'a stopped one that finished',
      { status: 'stopped', startedAt: T0(), stoppedAt: T1(), finishedAt: T1() },
    ],
    ['a cancelled one without the time it was cancelled', { status: 'cancelled' }],
    ['a draft with a reason of a cancellation', { cancelReason: 'limit' }],
    [
      'a scheduled one with a reason of a cancellation',
      { status: 'scheduled', scheduledAt: utc(DAY), cancelReason: 'limit' },
    ],
    [
      'one that is sending with a reason of a cancellation',
      { status: 'sending', startedAt: T0(), cancelReason: 'limit' },
    ],
    [
      'a finished one with a reason of a cancellation',
      { status: 'finished', startedAt: T0(), finishedAt: T1(), cancelReason: 'limit' },
    ],
    [
      'a stopped one with a reason of a cancellation',
      { status: 'stopped', startedAt: T0(), stoppedAt: T1(), cancelReason: 'limit' },
    ],
    ['a cancelled one that started', { status: 'cancelled', cancelledAt: T1(), startedAt: T0() }],
  ];

  it.each(REFUSED)('is refused with %s', async (_what, set) => {
    const outcome = await inOwnerTx(async (db) => {
      await open(db);
      return attemptInsert(db, 'newsletter_campaigns', campaignRow(set));
    });

    expect(codeOf(outcome)).toBe(CHECK_VIOLATION);
  });

  it('knows one reason of a cancellation, the limit; any other is no value of the type', async () => {
    const outcome = await inOwnerTx(async (db) => {
      await open(db);
      return attemptInsert(
        db,
        'newsletter_campaigns',
        campaignRow({ status: 'cancelled', cancelledAt: T1(), cancelReason: 'other' }),
      );
    });

    // 22P02: invalid input value for the enum
    expect(codeOf(outcome)).toBe('22P02');
  });
});

describe('a recipient', () => {
  // a draft campaign made by root and a subscription, for the rows below to refer to
  async function parents(db: OwnerSession) {
    await db.as({ role: 'ROOT', userId: root.id });
    const [campaign] = await db.rows<{ id: number }>(
      `insert into cartlify.newsletter_campaigns (name, "missingLocale", content, "createdById", "updatedById")
       values ('Mails', 'skip', $1::jsonb, $2::int, $2::int) returning id`,
      JSON.stringify(CAMPAIGN_CONTENT),
      root.id,
    );
    const subscription = await insertSubscription(db);
    return { campaign: campaign!.id, subscription };
  }

  // the rows are made as they would be left by the sending: a queued row, then changed
  const CHANGED: [string, Record<string, unknown>, boolean][] = [
    [
      'sent with its time and id',
      { status: 'sent', sentAt: utc(), providerMessageId: 'abc', attempts: 1 },
      true,
    ],
    ['rejected', { status: 'rejected', attempts: 3 }, true],
    ['skipped with no try', { status: 'skipped' }, true],
    ['skipped after a try', { status: 'skipped', attempts: 1 }, true],
    ['skipped with a time it was sent', { status: 'skipped', sentAt: utc() }, false],
    ['skipped with the id of a sent mail', { status: 'skipped', providerMessageId: 'abc' }, false],
    ['bounced after it was sent', { status: 'bounced', sentAt: utc(), attempts: 1 }, true],
    ['dropped after it was sent', { status: 'dropped', sentAt: utc(), attempts: 1 }, true],
    [
      'complained about after it was sent',
      { status: 'complained', sentAt: utc(), attempts: 1 },
      true,
    ],
    ['queued again after a failed try', { attempts: 2 }, true],
    ['queued with a time it was sent', { sentAt: utc() }, false],
    ['queued with the id of a sent mail', { providerMessageId: 'abc' }, false],
    ['sent without its time', { status: 'sent', attempts: 1 }, false],
    ['bounced without the time it was sent', { status: 'bounced', attempts: 1 }, false],
    ['dropped without the time it was sent', { status: 'dropped', attempts: 1 }, false],
    ['complained about without the time it was sent', { status: 'complained', attempts: 1 }, false],
    ['with a negative number of tries', { attempts: -1 }, false],
    [
      'with an empty id of the mail',
      { status: 'sent', sentAt: utc(), providerMessageId: '' },
      false,
    ],
  ];

  it.each(CHANGED)('is %s: allowed %s', async (_what, set, allowed) => {
    const outcome = await inOwnerTx(async (db) => {
      const { campaign, subscription } = await parents(db);
      // the policies let the owner add a queued row only, the checks are tried on the update
      const [queued] = await db.rows<{ id: number }>(
        `insert into cartlify.newsletter_recipients ("campaignId", "subscriptionId", locale)
         values ($1::int, $2::int, 'en') returning id`,
        campaign,
        subscription,
      );
      const names = Object.keys(set);
      return db.attempt(
        `update cartlify.newsletter_recipients set ${names
          .map((name, index) => `"${name}" = $${index + 2}`)
          .join(', ')} where id = $1 returning id`,
        queued!.id,
        ...Object.values(set),
      );
    });

    expect(codeOf(outcome)).toBe(allowed ? 'ok' : CHECK_VIOLATION);
  });

  it.each([
    ['in capitals', 'EN'],
    ['of one letter', 'e'],
  ])('is refused with a language %s', async (_what, locale) => {
    const outcome = await inOwnerTx(async (db) => {
      const { campaign, subscription } = await parents(db);
      return attemptInsert(
        db,
        'newsletter_recipients',
        recipientRow(campaign, subscription, { locale }),
      );
    });

    expect(codeOf(outcome)).toBe(CHECK_VIOLATION);
  });

  it('is made once for a campaign and a subscription: a mail is never sent twice', async () => {
    const outcomes = await inOwnerTx(async (db) => {
      const { campaign, subscription } = await parents(db);
      const other = await insertSubscription(db);
      return [
        await attemptInsert(db, 'newsletter_recipients', recipientRow(campaign, subscription)),
        await attemptInsert(db, 'newsletter_recipients', recipientRow(campaign, subscription)),
        await attemptInsert(db, 'newsletter_recipients', recipientRow(campaign, other)),
      ].map(codeOf);
    });

    expect(outcomes).toEqual(['ok', UNIQUE_VIOLATION, 'ok']);
  });

  it('goes with its subscription, whose removal needs no word about the recipients', async () => {
    const left = await inOwnerTx(async (db) => {
      const { campaign, subscription } = await parents(db);
      await insertRow(db, 'newsletter_recipients', recipientRow(campaign, subscription));
      await db.rows('delete from cartlify.newsletter_subscriptions where id = $1', subscription);
      return db.rows<{ n: number }>(
        'select count(*)::int as n from cartlify.newsletter_recipients where "campaignId" = $1',
        campaign,
      );
    });

    expect(left).toEqual([{ n: 0 }]);
  });
});

describe('an entry of the blocklist', () => {
  it.each([
    ['by the person', () => blockRow()],
    [
      'by an admin with a reason',
      () => blockRow({ byPerson: false, blockedById: root.id, reason: 'spam' }),
    ],
  ])('is made %s', async (_what, row) => {
    const outcome = await inOwnerTx((db) => attemptInsert(db, 'newsletter_form_blocklist', row()));

    expect(codeOf(outcome)).toBe('ok');
  });

  it.each([
    ['an HMAC that is not hex', () => blockRow({ emailHmac: 'not-hex' })],
    ['an HMAC of capitals', () => blockRow({ emailHmac: hex64().toUpperCase() })],
    ['neither an admin nor the person', () => blockRow({ byPerson: false })],
    ['both an admin and the person', () => blockRow({ blockedById: root.id })],
    ['an empty reason', () => blockRow({ byPerson: false, blockedById: root.id, reason: '' })],
    [
      'a reason with spaces at its edges',
      () => blockRow({ byPerson: false, blockedById: root.id, reason: ' spam ' }),
    ],
  ])('is refused with %s', async (_what, row) => {
    const outcome = await inOwnerTx((db) => attemptInsert(db, 'newsletter_form_blocklist', row()));

    expect(codeOf(outcome)).toBe(CHECK_VIOLATION);
  });

  it('blocks an address once', async () => {
    const outcomes = await inOwnerTx(async (db) => {
      const emailHmac = hex64();
      return [
        await attemptInsert(db, 'newsletter_form_blocklist', blockRow({ emailHmac })),
        await attemptInsert(db, 'newsletter_form_blocklist', blockRow({ emailHmac })),
      ].map(codeOf);
    });

    expect(outcomes).toEqual(['ok', UNIQUE_VIOLATION]);
  });
});

describe('the indexes of the newsletter tables', () => {
  it('are in place for the queue and the lists', async () => {
    const names = await inOwnerTx(async (db) => {
      const rows = await db.rows<{ indexname: string }>(
        `select indexname from pg_indexes
         where schemaname = 'cartlify' and tablename like 'newsletter\\_%'
         order by indexname`,
      );
      return rows.map((row) => row.indexname);
    });

    expect(names).toEqual(
      expect.arrayContaining([
        // the address has one live subscription; the cleanup finds the waiting and the ended ones
        'newsletter_subscriptions_live_email_uidx',
        'newsletter_subscriptions_pending_expiry_idx',
        'newsletter_subscriptions_ended_idx',
        'newsletter_subscriptions_manageHash_key',
        'newsletter_subscriptions_userId_idx',
        'newsletter_subscriptions_status_id_idx',
        // the lookups the links and the lists make: the token of a request that waits, the HMAC of
        // an address, the address among the rows that are not live
        'newsletter_subscriptions_pending_confirm_uidx',
        'newsletter_subscriptions_email_hmac_idx',
        'newsletter_subscriptions_email_idx',
        'newsletter_subscriptions_email_trgm_idx',
        // the journal of a subscription and of a campaign
        'newsletter_subscription_events_subscriptionId_createdAt_idx',
        'newsletter_subscription_events_campaign_idx',
        // the lists of campaigns
        'newsletter_campaigns_status_scheduledAt_idx',
        'newsletter_campaigns_createdAt_id_idx',
        // the queue of a campaign: the next mails to send
        'newsletter_recipients_campaignId_status_id_idx',
        'newsletter_recipients_campaignId_subscriptionId_key',
        'newsletter_recipients_subscriptionId_idx',
        'newsletter_form_blocklist_emailHmac_key',
      ]),
    );
  });
});

describe('the lookups of the subscriptions', () => {
  // the plan of a statement over a table that holds some hundreds of waiting requests, as the
  // table of a shop would (the planner reads a table of a few rows whole, whatever its indexes
  // are); the rows and their statistics go with the transaction
  async function planOf(db: OwnerSession, statement: string): Promise<string> {
    await db.rows(
      `insert into cartlify.newsletter_subscriptions
         (email, "emailHmac", source, status, "confirmHash", "confirmExpiresAt", "manageSalt",
          "manageHash", "unsubscribeHash")
       select $1 || n || '@example.com', md5($1 || n) || md5('h' || n), 'form', 'pending',
              md5($1 || 'c' || n) || md5('d' || n), (now() at time zone 'utc') + interval '3 days',
              md5('s' || n) || md5($1 || 't' || n), md5($1 || 'm' || n) || md5('n' || n),
              md5($1 || 'u' || n) || md5('v' || n)
       from generate_series(1, 400) as n`,
      `plan${hex64().slice(0, 8)}`,
    );
    await db.rows('analyze cartlify.newsletter_subscriptions');
    const lines = await db.rows<{ 'QUERY PLAN': string }>(`explain (costs off) ${statement}`);
    return lines.map((line) => line['QUERY PLAN']).join('\n');
  }

  // the statements the functions make: the link of a request that waits (confirm, not me), the
  // HMAC of an address (the blocklist step), the address among rows of every state (the export of
  // an account)
  it.each([
    [
      'the token of a request that waits',
      `select * from cartlify.newsletter_subscriptions
       where "confirmHash" = 'a' and status = 'pending' for update`,
      'newsletter_subscriptions_pending_confirm_uidx',
    ],
    [
      'the HMAC of an address among the requests that wait',
      `select id, email from cartlify.newsletter_subscriptions
       where "emailHmac" = 'a' and status = 'pending' order by id`,
      'newsletter_subscriptions_email_hmac_idx',
    ],
    [
      'an address among the rows of every state',
      `select id from cartlify.newsletter_subscriptions where email = 'a@example.com' order by id`,
      'newsletter_subscriptions_email_idx',
    ],
  ])('read %s by an index', async (_what, statement, index) => {
    const plan = await inOwnerTx((db) => planOf(db, statement));

    expect(plan).toContain(index);
    expect(plan).not.toContain('Seq Scan');
  });

  // the search of the admins: a part of an address, in any case, among the rows of every state. A table
  // of some hundreds of rows is read whole by the planner whatever the indexes are, so the scan of the
  // table is turned off: what is shown is that the trigram index can serve the statement (the list
  // adds an order by id, which a table of this size answers by walking the primary key instead)
  it('lets the trigram index serve a part of an address in any case', async () => {
    const plan = await inOwnerTx(async (db) => {
      await db.rows('set local enable_seqscan = off');
      return planOf(
        db,
        `select id from cartlify.newsletter_subscriptions where email ilike '%zq9x7%'`,
      );
    });

    expect(plan).toContain('newsletter_subscriptions_email_trgm_idx');
  });

  // a token is the key of one request: two cannot share it, so the lookup never takes the first of
  // several rows
  it('lets one request that waits own a token', async () => {
    const outcomes = await inOwnerTx(async (db) => {
      const confirmHash = hex64();
      return [
        await attemptSubscription(db, { status: 'pending', set: { confirmHash } }),
        await attemptSubscription(db, { status: 'pending', set: { confirmHash } }),
        await attemptSubscription(db, { status: 'pending' }),
      ].map(codeOf);
    });

    expect(outcomes).toEqual(['ok', UNIQUE_VIOLATION, 'ok']);
  });

  // the HMAC of an address is the same on every row the address ever had, so it is no key
  it('lets an address keep one HMAC on all its rows', async () => {
    const outcomes = await inOwnerTx(async (db) => {
      const emailHmac = hex64();
      return [
        await attemptSubscription(db, {
          status: 'ended',
          set: { emailHmac, email: 'same@example.com' },
        }),
        await attemptSubscription(db, {
          status: 'pending',
          set: { emailHmac, email: 'same@example.com' },
        }),
      ].map(codeOf);
    });

    expect(outcomes).toEqual(['ok', 'ok']);
  });
});
