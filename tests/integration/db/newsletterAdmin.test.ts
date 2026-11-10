import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor } from '../../helpers/db.js';
import { createUser, type TestUser } from '../../helpers/factories.js';
import {
  eventRow,
  hex64,
  insertRow,
  insertSubscription,
  recipientRow,
  removeNewsletterFixtures,
  removeSubscriptionRows,
  setupNewsletterFixtures,
  utc,
  type NewsletterFixtures,
  type SubscriptionStatus,
} from '../../helpers/newsletterDb.js';
import {
  GUEST,
  READER,
  SQL,
  SYSTEM,
  attemptAs,
  callAs,
  codeOf,
  dbNow,
  journalOf,
  near,
  requestArgs,
  requestAs,
  subscriptionById,
} from '../../helpers/newsletterFns.js';
import { inOwnerTx } from '../../helpers/ownerDb.js';

// the steps of the people who run the newsletters, each a function of the database that checks the
// actor itself: a manager (root, or an admin root allowed) blocks an address for the public form
// (cartlify.newsletter_block_add; erasing an address is cartlify.newsletter_admin_erase_address, its
// test is db/newsletterErase; taking an address off the list is a plain DELETE under the policy); only
// root allows an admin
// (_set_manager) and reads and resets the languages (_locale_counts, _reset_locale). A case makes its
// rows in a session of the owner of the database that rolls back; the languages of the accounts
// and the subscriptions that the language functions count are committed, with languages no other
// file uses (zz, zy, zx)

let fx: NewsletterFixtures;
// accounts with a language: three alive (one an admin), one deleted
let zzUsers: TestUser[];
let zyUser: TestUser;
let deletedUser: TestUser;
// the committed subscriptions with a language, by name
const committed: Record<string, number> = {};
const subscriptionIds: number[] = [];

beforeAll(async () => {
  fx = await setupNewsletterFixtures();
  zzUsers = [
    await createUser({ locale: 'zz' }),
    await createUser({ locale: 'zz' }),
    await createUser({ locale: 'zz', role: 'ADMIN' }),
  ];
  zyUser = await createUser({ locale: 'zy' });
  deletedUser = await createUser({ locale: 'zx' });

  await inOwnerTx(
    async (db) => {
      await db.as({ role: 'ROOT', userId: fx.root.id });
      await db.rows(
        `update cartlify.users set "deletedAt" = $2::timestamp where id = $1`,
        deletedUser.id,
        utc(),
      );

      const rows: [string, { status: SubscriptionStatus; locale: string | null }][] = [
        ['zzPending', { status: 'pending', locale: 'zz' }],
        ['zzActive', { status: 'active', locale: 'zz' }],
        ['zzPaused', { status: 'paused_complaint', locale: 'zz' }],
        ['zzStopped', { status: 'stopped_bounce', locale: 'zz' }],
        ['zzEnded', { status: 'ended', locale: 'zz' }],
        ['zyActive', { status: 'active', locale: 'zy' }],
        ['zxEnded', { status: 'ended', locale: 'zx' }],
        ['noLocale', { status: 'active', locale: null }],
      ];

      for (const [name, opts] of rows) {
        committed[name] = await insertSubscription(db, opts);
        subscriptionIds.push(committed[name]);
      }
    },
    { commit: true },
  );
});

afterAll(async () => {
  try {
    await removeSubscriptionRows(subscriptionIds);
    // the accounts stay in the database (an account is not deleted by a test): their languages go,
    // so that the next run on the same database counts only its own
    await inOwnerTx(
      async (db) => {
        for (const code of ['zz', 'zy']) {
          await callAs(db, { role: 'ROOT', userId: fx.root.id }, SQL.resetLocale, code);
        }
      },
      { commit: true },
    );
    if (fx) await removeNewsletterFixtures(fx);
  } finally {
    await prisma.$disconnect();
  }
});

const MANAGER = (): Actor => ({ role: 'ADMIN', userId: fx.manager.id });
const ROOT = (): Actor => ({ role: 'ROOT', userId: fx.root.id });
const PLAIN_ADMIN = (): Actor => ({ role: 'ADMIN', userId: fx.plainAdmin.id });
const BUYER = (): Actor => ({ role: 'USER', userId: fx.stranger.id });

// everybody who is not a manager, and the system
const NOT_MANAGERS: [string, () => Actor | null][] = [
  ['a guest', GUEST],
  ['no context', () => null],
  ['a buyer', BUYER],
  ['an admin without the right to run the newsletters', PLAIN_ADMIN],
  ['the system', () => SYSTEM],
];
// everybody who is not root
const NOT_ROOT: [string, () => Actor | null][] = [
  ...NOT_MANAGERS,
  ['an admin with the right to run the newsletters', MANAGER],
];

const FORBIDDEN = 'NEWSLETTER_FORBIDDEN';
const NO_ID = 2147483647;

describe('cartlify.newsletter_block_add', () => {
  const add = (
    db: Parameters<typeof attemptAs>[0],
    actor: Actor | null,
    hmac: string | null,
    reason: string | null = 'asked by the person',
  ) => attemptAs<{ added: boolean }>(db, actor, SQL.blockAdd, hmac, reason);

  type Entry = {
    emailHmac: string;
    blockedById: number | null;
    byPerson: boolean;
    reason: string | null;
    createdAt: Date;
  };

  const entriesOf = (db: Parameters<typeof attemptAs>[0], hmac: string) =>
    callAs<Entry>(
      db,
      ROOT(),
      `select "emailHmac", "blockedById", "byPerson", reason, "createdAt"
       from cartlify.newsletter_form_blocklist where "emailHmac" = $1`,
      hmac,
    );

  it.each([
    ['an admin with the right', MANAGER, () => fx.manager.id],
    ['root', ROOT, () => fx.root.id],
  ] as [string, () => Actor, () => number][])(
    'blocks an address for %s, naming who did it',
    async (_who, actor, id) => {
      await inOwnerTx(async (db) => {
        const hmac = hex64();
        const now = await dbNow(db);

        expect(await add(db, actor(), hmac, '  spam from the form  ')).toEqual({
          ok: true,
          rows: [{ added: true }],
        });

        const [entry] = await entriesOf(db, hmac);
        expect(entry).toMatchObject({
          blockedById: id(),
          byPerson: false,
          reason: 'spam from the form',
        });
        expect(near(entry!.createdAt, now)).toBe(true);
      });
    },
  );

  it.each([[''], ['   '], [null]])('takes the reason %j as no reason', async (reason) => {
    await inOwnerTx(async (db) => {
      const hmac = hex64();

      await add(db, MANAGER(), hmac, reason);

      expect((await entriesOf(db, hmac))[0]!.reason).toBeNull();
    });
  });

  // the column keeps 200 characters: a longer note is cut (after the spaces around it go), it does not
  // fail the step with an error of the length of the column, and the cut does not end on a space
  it.each([
    ['a note of 250 characters', 'a'.repeat(250), 'a'.repeat(200)],
    ['a note of exactly 200 characters', 'a'.repeat(200), 'a'.repeat(200)],
    ['a long note with spaces around it', `   ${'b'.repeat(250)}  `, 'b'.repeat(200)],
    ['a note that is cut at a space', `${'c'.repeat(199)} ${'d'.repeat(30)}`, 'c'.repeat(199)],
    ['a long note of characters of two bytes', '\u00e9'.repeat(250), '\u00e9'.repeat(200)],
    ['a note that is spaces after the cut', `${'e'.repeat(10)}${' '.repeat(300)}x`, 'e'.repeat(10)],
  ])('keeps %s as at most 200 characters', async (_what, reason, kept) => {
    await inOwnerTx(async (db) => {
      const hmac = hex64();

      expect(await add(db, MANAGER(), hmac, reason)).toEqual({ ok: true, rows: [{ added: true }] });

      expect((await entriesOf(db, hmac))[0]!.reason).toBe(kept);
    });
  });

  it.each(NOT_MANAGERS)('is refused to %s, and no entry is made', async (_who, actor) => {
    await inOwnerTx(async (db) => {
      const hmac = hex64();

      expect(codeOf(await add(db, actor(), hmac))).toBe(FORBIDDEN);
      expect(await entriesOf(db, hmac)).toEqual([]);
    });
  });

  // the entry names an admin: root without an account has no id to name
  it('is refused to root without an account: the entry has nobody to name', async () => {
    await inOwnerTx(async (db) => {
      const hmac = hex64();

      expect(codeOf(await add(db, { role: 'ROOT' }, hmac))).toBe(FORBIDDEN);
      expect(await entriesOf(db, hmac)).toEqual([]);
    });
  });

  it('is no error when the address is blocked already: false, and the first entry stays', async () => {
    await inOwnerTx(async (db) => {
      const hmac = hex64();

      await add(db, MANAGER(), hmac, 'first');
      const again = await add(db, ROOT(), hmac, 'second');

      expect(again).toEqual({ ok: true, rows: [{ added: false }] });
      const entries = await entriesOf(db, hmac);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ blockedById: fx.manager.id, reason: 'first' });
    });
  });

  it('removes the request that waits for the confirmation, with its journal and its mails', async () => {
    await inOwnerTx(async (db) => {
      const hmac = hex64();
      const waiting = await insertSubscription(db, { status: 'pending', set: { emailHmac: hmac } });
      await insertRow(db, 'newsletter_subscription_events', eventRow(waiting));
      await insertRow(db, 'newsletter_recipients', recipientRow(fx.campaign, waiting));
      // an ended request of the same address stays as the proof of the consent, as does a request
      // of another address
      const ended = await insertSubscription(db, { status: 'ended', set: { emailHmac: hmac } });
      const other = await insertSubscription(db, { status: 'pending' });

      expect(await add(db, MANAGER(), hmac)).toEqual({ ok: true, rows: [{ added: true }] });

      expect(await subscriptionById(db, waiting)).toBeNull();
      expect(await journalOf(db, waiting)).toEqual([]);
      expect((await subscriptionById(db, ended))!.status).toBe('ended');
      expect((await subscriptionById(db, other))!.status).toBe('pending');
    });
  });

  it('leaves a subscription in force, whatever its HMAC: the blocklist is for new requests', async () => {
    await inOwnerTx(async (db) => {
      const hmac = hex64();
      const id = await insertSubscription(db, { status: 'active', set: { emailHmac: hmac } });

      await add(db, MANAGER(), hmac);

      expect((await subscriptionById(db, id))!.status).toBe('active');
    });
  });

  it('removes a waiting request also when the address is on the list already', async () => {
    await inOwnerTx(async (db) => {
      const hmac = hex64();
      await add(db, MANAGER(), hmac);
      const waiting = await insertSubscription(db, { status: 'pending', set: { emailHmac: hmac } });

      expect(await add(db, MANAGER(), hmac)).toEqual({ ok: true, rows: [{ added: false }] });
      expect(await subscriptionById(db, waiting)).toBeNull();
    });
  });

  it.each([['abc'], ['z'.repeat(64)], ['A'.repeat(64)]])(
    'refuses %j, which is no HMAC, by the check of the table',
    async (hmac) => {
      await inOwnerTx(async (db) => {
        expect(await add(db, MANAGER(), hmac)).toMatchObject({ ok: false, code: '23514' });
      });
    },
  );

  // the app role runs these two: the owner of the database may delete any entry, the policy is what a
  // manager is held to
  it('makes the form answer with nothing for the address, until a manager takes the entry off', async () => {
    await inRolledBackTx(async (db) => {
      const args = requestArgs();

      await add(db, MANAGER(), args.emailHmac);
      const blocked = await requestAs(db, GUEST(), args);
      expect(blocked).toEqual({
        ok: true,
        rows: [{ outcome: 'nothing', locale: null, manage_salt: null }],
      });

      // taking an address off the list is a DELETE a manager makes
      await db.as(MANAGER());
      const removed = await db.rows(
        'delete from cartlify.newsletter_form_blocklist where "emailHmac" = $1 returning id',
        args.emailHmac,
      );
      expect(removed).toHaveLength(1);

      const open = await requestAs(db, GUEST(), args);
      expect(open).toMatchObject({ ok: true, rows: [{ outcome: 'confirm' }] });
    });
  });

  it.each([
    ['an admin without the right', PLAIN_ADMIN],
    ['a buyer', BUYER],
    ['the system', () => SYSTEM],
    ['a guest', GUEST],
  ] as [string, () => Actor][])('lets %s take no entry off the list', async (_who, actor) => {
    await inRolledBackTx(async (db) => {
      const hmac = hex64();
      await add(db, MANAGER(), hmac);

      await db.as(actor());
      const removed = await db.rows(
        'delete from cartlify.newsletter_form_blocklist where "emailHmac" = $1 returning id',
        hmac,
      );

      expect(removed).toEqual([]);
      expect(await entriesOf(db, hmac)).toHaveLength(1);
    });
  });

  it('is run by the role of the app for a manager', async () => {
    const hmac = hex64();
    const answers = await inRolledBackTx(async (db) => {
      const refused = await add(db, PLAIN_ADMIN(), hmac);
      const done = await add(db, ROOT(), hmac);
      return { refused: codeOf(refused), done, entries: await entriesOf(db, hmac) };
    });

    expect(answers).toMatchObject({
      refused: FORBIDDEN,
      done: { ok: true, rows: [{ added: true }] },
      entries: [{ blockedById: fx.root.id }],
    });
  });
});

describe('cartlify.newsletter_set_manager', () => {
  const set = (
    db: Parameters<typeof attemptAs>[0],
    actor: Actor | null,
    id: number | null,
    value: boolean | null,
  ) => attemptAs<{ changed: boolean }>(db, actor, SQL.setManager, id, value);

  const flagOf = async (db: Parameters<typeof attemptAs>[0], id: number) => {
    const [row] = await callAs<{ flag: boolean }>(
      db,
      READER,
      'select "canManageNewsletters" as flag from cartlify.users where id = $1',
      id,
    );
    return row!.flag;
  };

  const runsNewsletters = async (db: Parameters<typeof attemptAs>[0], id: number) => {
    const [row] = await callAs<{ manager: boolean }>(
      db,
      { role: 'ADMIN', userId: id },
      'select cartlify.newsletter_manager() as manager',
    );
    return row!.manager;
  };

  it('allows an admin, and takes the right away again; a repeated step changes nothing', async () => {
    await inOwnerTx(async (db) => {
      expect(await flagOf(db, fx.plainAdmin.id)).toBe(false);
      expect(await runsNewsletters(db, fx.plainAdmin.id)).toBe(false);

      const on = await set(db, ROOT(), fx.plainAdmin.id, true);
      const onAgain = await set(db, ROOT(), fx.plainAdmin.id, true);
      const allowed = [
        await flagOf(db, fx.plainAdmin.id),
        await runsNewsletters(db, fx.plainAdmin.id),
      ];

      const off = await set(db, ROOT(), fx.plainAdmin.id, false);
      const offAgain = await set(db, ROOT(), fx.plainAdmin.id, false);
      const taken = [
        await flagOf(db, fx.plainAdmin.id),
        await runsNewsletters(db, fx.plainAdmin.id),
      ];

      expect(on).toEqual({ ok: true, rows: [{ changed: true }] });
      expect(onAgain).toEqual({ ok: true, rows: [{ changed: false }] });
      expect(allowed).toEqual([true, true]);
      expect(off).toEqual({ ok: true, rows: [{ changed: true }] });
      expect(offAgain).toEqual({ ok: true, rows: [{ changed: false }] });
      expect(taken).toEqual([false, false]);
    });
  });

  it('changes the right of that admin only, and nothing else of the account', async () => {
    await inOwnerTx(async (db) => {
      const read = () =>
        callAs(
          db,
          READER,
          `select id, email, role::text as role, "isVerified", locale, "passwordHash", "deletedAt"
           from cartlify.users where id = any($1::int[]) order by id`,
          [fx.plainAdmin.id, fx.manager.id, fx.stranger.id, fx.root.id],
        );
      const before = await read();

      await set(db, ROOT(), fx.plainAdmin.id, true);

      expect(await read()).toEqual(before);
      expect(await flagOf(db, fx.manager.id)).toBe(true);
      expect(await flagOf(db, fx.stranger.id)).toBe(false);
    });
  });

  it('works at once for the admin: the right is read from the database on every call', async () => {
    await inOwnerTx(async (db) => {
      await set(db, ROOT(), fx.manager.id, false);
      expect(await runsNewsletters(db, fx.manager.id)).toBe(false);
      await set(db, ROOT(), fx.manager.id, true);
      expect(await runsNewsletters(db, fx.manager.id)).toBe(true);
    });
  });

  it.each(NOT_ROOT)('is refused to %s, and the right does not move', async (_who, actor) => {
    await inOwnerTx(async (db) => {
      expect(codeOf(await set(db, actor(), fx.plainAdmin.id, true))).toBe(FORBIDDEN);
      expect(codeOf(await set(db, actor(), fx.manager.id, false))).toBe(FORBIDDEN);
      expect(codeOf(await set(db, actor(), NO_ID, true))).toBe(FORBIDDEN);

      expect(await flagOf(db, fx.plainAdmin.id)).toBe(false);
      expect(await flagOf(db, fx.manager.id)).toBe(true);
    });
  });

  it('is refused to an admin who tries to allow themselves', async () => {
    await inOwnerTx(async (db) => {
      expect(codeOf(await set(db, PLAIN_ADMIN(), fx.plainAdmin.id, true))).toBe(FORBIDDEN);
      expect(await flagOf(db, fx.plainAdmin.id)).toBe(false);
    });
  });

  it('is done by root without an account too: root is root', async () => {
    await inOwnerTx(async (db) => {
      expect(await set(db, { role: 'ROOT' }, fx.plainAdmin.id, true)).toEqual({
        ok: true,
        rows: [{ changed: true }],
      });
    });
  });

  it.each([
    ['a buyer', () => fx.stranger.id],
    ['root', () => fx.root.id],
    ['an account that does not exist', () => NO_ID],
    ['no account', () => null],
  ] as [string, () => number | null][])('does not allow %s: not an admin', async (_who, id) => {
    await inOwnerTx(async (db) => {
      expect(codeOf(await set(db, ROOT(), id(), true))).toBe('NEWSLETTER_TARGET_NOT_ADMIN');
    });
  });

  it('does not allow an admin whose account was deleted', async () => {
    await inOwnerTx(async (db) => {
      await db.as(ROOT());
      await db.rows(
        `update cartlify.users set "deletedAt" = $2::timestamp where id = $1`,
        fx.plainAdmin.id,
        utc(),
      );

      expect(codeOf(await set(db, ROOT(), fx.plainAdmin.id, true))).toBe(
        'NEWSLETTER_TARGET_NOT_ADMIN',
      );
      expect(await flagOf(db, fx.plainAdmin.id)).toBe(false);
    });
  });

  // taking the right away is harmless for anybody: it needs no admin
  it.each([
    ['a buyer', () => fx.stranger.id],
    ['root', () => fx.root.id],
    ['an account that does not exist', () => NO_ID],
    ['no account', () => null],
    ['an admin who has not got it', () => fx.plainAdmin.id],
  ] as [string, () => number | null][])(
    'takes the right away from %s without an error: nothing changed',
    async (_who, id) => {
      await inOwnerTx(async (db) => {
        expect(await set(db, ROOT(), id(), false)).toEqual({
          ok: true,
          rows: [{ changed: false }],
        });
      });
    },
  );

  it('takes the right away when no value is given: no value is no right', async () => {
    await inOwnerTx(async (db) => {
      expect(await set(db, ROOT(), fx.manager.id, null)).toEqual({
        ok: true,
        rows: [{ changed: true }],
      });
      expect(await flagOf(db, fx.manager.id)).toBe(false);
    });
  });

  it('goes off with the role: root takes the role away, and the right has to be given anew', async () => {
    await inOwnerTx(async (db) => {
      await db.as(ROOT());
      await db.rows(`update cartlify.users set role = 'USER' where id = $1`, fx.manager.id);

      expect(await flagOf(db, fx.manager.id)).toBe(false);
      expect(await runsNewsletters(db, fx.manager.id)).toBe(false);
      // nothing is left to take away, and a buyer cannot be allowed
      expect(await set(db, ROOT(), fx.manager.id, false)).toEqual({
        ok: true,
        rows: [{ changed: false }],
      });
      expect(codeOf(await set(db, ROOT(), fx.manager.id, true))).toBe(
        'NEWSLETTER_TARGET_NOT_ADMIN',
      );

      // the role comes back without the right
      await db.as(ROOT());
      await db.rows(`update cartlify.users set role = 'ADMIN' where id = $1`, fx.manager.id);
      expect(await flagOf(db, fx.manager.id)).toBe(false);
      expect(await set(db, ROOT(), fx.manager.id, true)).toEqual({
        ok: true,
        rows: [{ changed: true }],
      });
      expect(await runsNewsletters(db, fx.manager.id)).toBe(true);
    });
  });

  it('is run by the role of the app for root', async () => {
    const answers = await inRolledBackTx(async (db) => {
      const refused = await set(db, MANAGER(), fx.plainAdmin.id, true);
      const done = await set(db, ROOT(), fx.plainAdmin.id, true);
      return { refused: codeOf(refused), done, runs: await runsNewsletters(db, fx.plainAdmin.id) };
    });

    expect(answers).toEqual({
      refused: FORBIDDEN,
      done: { ok: true, rows: [{ changed: true }] },
      runs: true,
    });
  });
});

describe('cartlify.newsletter_locale_counts', () => {
  // the languages of this file only: no other file uses them
  const MINE = ['zx', 'zy', 'zz'];

  it('counts the languages root can still be asked about: alive accounts and subscriptions that are not ended', async () => {
    const rows = await inRolledBackTx(async (db) => {
      const counted = await callAs<{ locale: string; accounts: number; subscriptions: number }>(
        db,
        ROOT(),
        SQL.localeCounts,
      );
      return counted.filter((row) => MINE.includes(row.locale));
    });

    // zz: three alive accounts (the deleted one is not counted) and the four subscriptions that are
    // waiting, in force, paused or stopped by a bounce (the ended one is not); zy: one of each;
    // zx: a deleted account and an ended subscription, so no row
    expect(rows).toEqual([
      { locale: 'zy', accounts: 1, subscriptions: 1 },
      { locale: 'zz', accounts: 3, subscriptions: 4 },
    ]);
  });

  it('lists a language once and in order, and has no row for "no language"', async () => {
    const rows = await inRolledBackTx((db) =>
      callAs<{ locale: string | null }>(db, ROOT(), SQL.localeCounts),
    );

    const locales = rows.map((row) => row.locale);
    expect(locales.every((locale) => typeof locale === 'string')).toBe(true);
    expect(locales).toEqual([...new Set(locales)].sort());
  });

  it('answers root without an account too', async () => {
    const rows = await inRolledBackTx((db) => callAs(db, { role: 'ROOT' }, SQL.localeCounts));

    expect(rows.length).toBeGreaterThan(0);
  });

  it.each(NOT_ROOT)('is refused to %s', async (_who, actor) => {
    const outcome = await inRolledBackTx((db) => attemptAs(db, actor(), SQL.localeCounts));

    expect(codeOf(outcome)).toBe(FORBIDDEN);
  });
});

describe('cartlify.newsletter_reset_locale', () => {
  const reset = (db: Parameters<typeof attemptAs>[0], actor: Actor | null, locale: string | null) =>
    attemptAs<{ accounts: number; subscriptions: number }>(db, actor, SQL.resetLocale, locale);

  const localeOfUsers = async (db: Parameters<typeof attemptAs>[0]) =>
    callAs<{ id: number; locale: string | null }>(
      db,
      READER,
      'select id, locale from cartlify.users where id = any($1::int[]) order by id',
      [...zzUsers.map((user) => user.id), zyUser.id, deletedUser.id],
    );

  const subscriptionsNow = async (db: Parameters<typeof attemptAs>[0]) => {
    const out: Record<string, Awaited<ReturnType<typeof subscriptionById>>> = {};
    for (const [name, id] of Object.entries(committed)) out[name] = await subscriptionById(db, id);
    return out;
  };

  it.each([['ZZ'], ['zzz'], ['z'], [' zz'], ['z1'], [''], [null]])(
    'refuses %j: not a language',
    async (locale) => {
      const outcome = await inRolledBackTx((db) => reset(db, ROOT(), locale));

      expect(codeOf(outcome)).toBe('NEWSLETTER_LOCALE_INVALID');
    },
  );

  it('sets the language of the accounts alive and of the subscriptions not ended to none, and counts them', async () => {
    const result = await inRolledBackTx(async (db) => {
      const usersBefore = await localeOfUsers(db);
      const before = await subscriptionsNow(db);
      const now = await dbNow(db);

      const outcome = await reset(db, ROOT(), 'zz');

      return {
        usersBefore,
        before,
        now,
        outcome,
        usersAfter: await localeOfUsers(db),
        after: await subscriptionsNow(db),
      };
    });

    expect(result.outcome).toEqual({ ok: true, rows: [{ accounts: 3, subscriptions: 4 }] });

    // the accounts: the three alive ones lose zz, the deleted one and the other language keep theirs
    const ids = zzUsers.map((user) => user.id);
    expect(result.usersBefore.map((row) => row.locale)).toEqual(['zz', 'zz', 'zz', 'zy', 'zx']);
    expect(result.usersAfter.map((row) => [row.id, row.locale])).toEqual([
      [ids[0], null],
      [ids[1], null],
      [ids[2], null],
      [zyUser.id, 'zy'],
      [deletedUser.id, 'zx'],
    ]);

    // the subscriptions: the four lose zz and keep everything else; the ended one is frozen
    for (const name of ['zzPending', 'zzActive', 'zzPaused', 'zzStopped']) {
      expect(result.after[name]).toMatchObject({
        ...result.before[name],
        locale: null,
        updatedAt: expect.any(Date),
      });
      expect(near(result.after[name]!.updatedAt, result.now)).toBe(true);
    }
    for (const name of ['zzEnded', 'zyActive', 'zxEnded', 'noLocale']) {
      expect(result.after[name]).toEqual(result.before[name]);
    }
  });

  it('writes one line in the journal of each subscription it changed, for root, and none for the rest', async () => {
    const lines = await inRolledBackTx(async (db) => {
      await reset(db, ROOT(), 'zz');
      const out: Record<string, Awaited<ReturnType<typeof journalOf>>> = {};
      for (const [name, id] of Object.entries(committed)) out[name] = await journalOf(db, id);
      return out;
    });

    for (const name of ['zzPending', 'zzActive', 'zzPaused', 'zzStopped']) {
      expect(lines[name]).toEqual([
        expect.objectContaining({
          event: 'locale_reset',
          place: 'admin',
          actorId: fx.root.id,
          locale: null,
          ip: null,
          userAgent: null,
          campaignId: null,
          privacyVersion: null,
        }),
      ]);
    }
    for (const name of ['zzEnded', 'zyActive', 'zxEnded', 'noLocale']) {
      expect(lines[name]).toEqual([]);
    }
  });

  it('leaves nothing to reset the second time, and counts the language no more', async () => {
    const result = await inRolledBackTx(async (db) => {
      await reset(db, ROOT(), 'zz');
      const second = await reset(db, ROOT(), 'zz');
      const counts = await callAs<{ locale: string }>(db, ROOT(), SQL.localeCounts);
      return {
        second,
        counts: counts.map((row) => row.locale),
        lines: (await journalOf(db, committed.zzActive!)).length,
      };
    });

    expect(result.second).toEqual({ ok: true, rows: [{ accounts: 0, subscriptions: 0 }] });
    expect(result.counts).not.toContain('zz');
    expect(result.counts).toContain('zy');
    expect(result.lines).toBe(1);
  });

  // the data of the shop: a row is a setting, the latest row of a key is its value (root writes it)
  const setting = (db: Parameters<typeof attemptAs>[0], key: string, value: unknown) =>
    callAs(
      db,
      ROOT(),
      'insert into cartlify.shop_settings (key, value, "setById") values ($1, $2::jsonb, $3) returning id',
      key,
      JSON.stringify(value),
      fx.root.id,
    );

  it('refuses a language that is still turned on, and changes nothing', async () => {
    const result = await inRolledBackTx(async (db) => {
      await setting(db, 'enabledLocales', ['en', 'zz']);
      const before = [await localeOfUsers(db), await subscriptionsNow(db)];
      const outcome = await reset(db, ROOT(), 'zz');
      return { outcome, before, after: [await localeOfUsers(db), await subscriptionsNow(db)] };
    });

    expect(codeOf(result.outcome)).toBe('NEWSLETTER_LOCALE_STILL_ENABLED');
    expect(result.after).toEqual(result.before);
  });

  it('refuses the language of the shop, turned on in the list or not', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      await setting(db, 'enabledLocales', ['en']);
      await setting(db, 'shopLocale', 'zz');
      return reset(db, ROOT(), 'zz');
    });

    expect(codeOf(outcomes)).toBe('NEWSLETTER_LOCALE_STILL_ENABLED');
  });

  it('resets the language once the setting that turned it off is written, in the same transaction', async () => {
    const result = await inRolledBackTx(async (db) => {
      await setting(db, 'enabledLocales', ['en', 'zz']);
      await setting(db, 'shopLocale', 'en');
      const refused = await reset(db, ROOT(), 'zz');

      // root turns the language off: the later row of the key is its value
      await setting(db, 'enabledLocales', ['en']);
      const done = await reset(db, ROOT(), 'zz');
      return { refused: codeOf(refused), done };
    });

    expect(result.refused).toBe('NEWSLETTER_LOCALE_STILL_ENABLED');
    expect(result.done).toEqual({ ok: true, rows: [{ accounts: 3, subscriptions: 4 }] });
  });

  it('lets another language through while one is refused', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await setting(db, 'enabledLocales', ['en', 'zz']);
      return reset(db, ROOT(), 'zy');
    });

    expect(outcome).toEqual({ ok: true, rows: [{ accounts: 1, subscriptions: 1 }] });
  });

  it('refuses the others before it looks at the settings', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await setting(db, 'enabledLocales', ['en', 'zz']);
      return reset(db, MANAGER(), 'zz');
    });

    expect(codeOf(outcome)).toBe(FORBIDDEN);
  });

  it('resets a language nobody has without an error', async () => {
    const outcome = await inRolledBackTx((db) => reset(db, ROOT(), 'qq'));

    expect(outcome).toEqual({ ok: true, rows: [{ accounts: 0, subscriptions: 0 }] });
  });

  it('is done by root without an account, with no admin on the lines', async () => {
    const lines = await inRolledBackTx(async (db) => {
      const outcome = await reset(db, { role: 'ROOT' }, 'zy');
      return { outcome, lines: await journalOf(db, committed.zyActive!) };
    });

    expect(lines.outcome).toEqual({ ok: true, rows: [{ accounts: 1, subscriptions: 1 }] });
    expect(lines.lines).toEqual([
      expect.objectContaining({ event: 'locale_reset', actorId: null }),
    ]);
  });

  it.each(NOT_ROOT)('is refused to %s, and nothing changes', async (_who, actor) => {
    const result = await inRolledBackTx(async (db) => {
      const before = [await localeOfUsers(db), await subscriptionsNow(db)];
      const outcome = await reset(db, actor(), 'zz');
      return { outcome, same: [await localeOfUsers(db), await subscriptionsNow(db)], before };
    });

    expect(codeOf(result.outcome)).toBe(FORBIDDEN);
    expect(result.same).toEqual(result.before);
  });
});
