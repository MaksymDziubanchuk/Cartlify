import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type Outcome as DbOutcome } from '../../helpers/db.js';
import { createUser, type TestUser } from '../../helpers/factories.js';
import {
  eventRow,
  hex64,
  insertRow,
  insertSubscription,
  removeNewsletterFixtures,
  removeSubscriptionRows,
  setupNewsletterFixtures,
  type NewsletterFixtures,
  type SubscriptionOpts,
} from '../../helpers/newsletterDb.js';
import {
  AGENT,
  GUEST,
  IP,
  SQL,
  attemptAs,
  codeOf,
  dbNow,
  journalOf,
  near,
  publishPrivacy,
  requestArgs,
  requestAs,
  subscriptionsOf,
} from '../../helpers/newsletterFns.js';
import { inOwnerTx } from '../../helpers/ownerDb.js';

// the steps of a signed-in person on the subscription of their own address: subscribe, see, change
// the language, unsubscribe, resume after a complaint, export, and the end of it all with the
// account (cartlify.newsletter_subscribe_account, _profile_*, _end_for_account). The address is
// always the one of the account, read from the database, never a parameter. The rows are
// committed by the owner, every statement of a test runs in a transaction that rolls back

let fx: NewsletterFixtures;
const subscriptionIds: number[] = [];

type UserState =
  | 'none'
  | 'pending'
  | 'form'
  | 'formPaused'
  | 'account'
  | 'accountPaused'
  | 'ended'
  | 'stopped'
  | 'unverified';

// what the address of each account holds
const ROWS: Record<UserState, Omit<SubscriptionOpts, 'email' | 'userId'> | null> = {
  none: null,
  pending: { status: 'pending', locale: 'es' },
  form: { status: 'active', locale: 'en' },
  formPaused: { status: 'paused_complaint', locale: 'en' },
  account: { source: 'account', status: 'active', locale: 'en' },
  accountPaused: { source: 'account', status: 'paused_complaint', locale: 'en' },
  ended: { status: 'ended', locale: 'en' },
  stopped: { status: 'stopped_bounce', locale: 'en' },
  unverified: { status: 'active', locale: 'en' },
};
const STATES = Object.keys(ROWS) as UserState[];

const users = {} as Record<UserState, TestUser>;
let history: TestUser;
const lineOf = {} as Record<UserState, number>;

beforeAll(async () => {
  fx = await setupNewsletterFixtures();

  for (const state of STATES) {
    users[state] = await createUser({ isVerified: state !== 'unverified' });
  }
  history = await createUser();

  await inOwnerTx(
    async (db) => {
      for (const state of STATES) {
        const row = ROWS[state];
        if (!row) continue;

        const user = users[state];
        const id = await insertSubscription(db, {
          ...row,
          email: user.email,
          userId: row.source === 'account' ? user.id : undefined,
        });
        subscriptionIds.push(id);
        // a line of the journal, to see it stay
        lineOf[state] = await insertRow(db, 'newsletter_subscription_events', eventRow(id));
      }

      // an account that unsubscribed once and subscribed again
      const old = await insertSubscription(db, {
        status: 'ended',
        email: history.email,
        locale: 'es',
        set: { endReason: 'unsubscribed' },
      });
      await insertRow(db, 'newsletter_subscription_events', eventRow(old, { event: 'subscribed' }));
      await insertRow(
        db,
        'newsletter_subscription_events',
        eventRow(old, { event: 'unsubscribed', place: 'mail_client' }),
      );
      const current = await insertSubscription(db, {
        source: 'account',
        status: 'active',
        email: history.email,
        userId: history.id,
        locale: 'en',
      });
      await insertRow(
        db,
        'newsletter_subscription_events',
        eventRow(current, { event: 'subscribed', place: 'profile' }),
      );
      subscriptionIds.push(old, current);
    },
    { commit: true },
  );
});

afterAll(async () => {
  try {
    await removeSubscriptionRows(subscriptionIds);
    if (fx) await removeNewsletterFixtures(fx);
  } finally {
    await prisma.$disconnect();
  }
});

const owner = (user: TestUser): Actor => ({ role: 'USER', userId: user.id });

type Show = (rows: Record<string, unknown>[]) => string;

const summary = (outcome: DbOutcome, show: Show): string =>
  outcome.ok ? show(outcome.rows) : (outcome.message ?? String(outcome.code));

const NOT_VERIFIED = 'NEWSLETTER_EMAIL_NOT_VERIFIED';
const FORBIDDEN = 'NEWSLETTER_FORBIDDEN';

// what each function answers the owner of each kind of address; the account whose email is not
// verified is refused by every one of them, whatever its address holds
type Check = {
  sql: string;
  values: (user: TestUser) => unknown[];
  show: Show;
  expected: Record<Exclude<UserState, 'unverified'>, string>;
};

const flag = (rows: Record<string, unknown>[]) => String(rows[0]!.done);

const CHECKS: Record<string, Check> = {
  'profile_get (source/language/status/can change the language)': {
    sql: SQL.profileGet,
    values: (user) => [user.id],
    show: (rows) =>
      rows.length
        ? `${rows[0]!.source}/${rows[0]!.locale}/${rows[0]!.status}/${rows[0]!.can_change_locale}`
        : 'none',
    expected: {
      none: 'none',
      pending: 'none',
      form: 'form/en/active/false',
      formPaused: 'form/en/paused_complaint/false',
      account: 'account/en/active/true',
      accountPaused: 'account/en/paused_complaint/true',
      ended: 'none',
      stopped: 'none',
    },
  },
  'profile_unsubscribe (ended now)': {
    sql: SQL.profileUnsubscribe,
    values: (user) => [user.id, IP, AGENT],
    show: flag,
    expected: {
      none: 'false',
      pending: 'false',
      form: 'true',
      formPaused: 'true',
      account: 'true',
      accountPaused: 'true',
      ended: 'false',
      stopped: 'false',
    },
  },
  'profile_set_locale (changed)': {
    sql: SQL.profileSetLocale,
    values: (user) => [user.id, 'de', IP, AGENT],
    show: flag,
    expected: {
      none: 'false',
      pending: 'false',
      // the language of a subscription of the form is changed on the page of management only
      form: 'NEWSLETTER_LOCALE_NOT_ALLOWED',
      formPaused: 'NEWSLETTER_LOCALE_NOT_ALLOWED',
      account: 'true',
      accountPaused: 'true',
      ended: 'false',
      stopped: 'false',
    },
  },
  'profile_resume (resumed)': {
    sql: SQL.profileResume,
    values: (user) => [user.id, IP, AGENT],
    show: flag,
    expected: {
      none: 'false',
      pending: 'false',
      form: 'false',
      formPaused: 'true',
      account: 'false',
      accountPaused: 'true',
      ended: 'false',
      stopped: 'false',
    },
  },
  'profile_export (subscriptions of the address)': {
    sql: SQL.profileExport,
    values: (user) => [user.id],
    show: (rows) => String((rows[0]!.data as { subscriptions: unknown[] }).subscriptions.length),
    expected: {
      none: '0',
      // a request nobody confirmed is not the person's subscription: it is not exported
      pending: '0',
      form: '1',
      formPaused: '1',
      account: '1',
      accountPaused: '1',
      ended: '1',
      stopped: '1',
    },
  },
  'subscribe_account (created, converted, already)': {
    sql: SQL.subscribeAccount,
    values: (user) => [user.id, 'de', hex64(), hex64(), hex64(), 'profile', IP, AGENT],
    show: (rows) => String(rows[0]!.outcome),
    expected: {
      none: 'created',
      // the request of a stranger that waits on the address becomes the subscription of the account
      pending: 'converted',
      form: 'already',
      formPaused: 'already',
      account: 'already',
      accountPaused: 'already',
      ended: 'created',
      stopped: 'created',
    },
  },
};

describe.each(Object.entries(CHECKS))('%s', (_name, check) => {
  it.each(STATES.filter((state) => state !== 'unverified'))(
    'answers the owner of an address that holds: %s',
    async (state) => {
      const outcome = await inRolledBackTx((db) =>
        attemptAs(db, owner(users[state]), check.sql, ...check.values(users[state])),
      );

      expect(summary(outcome, check.show)).toBe(check.expected[state as keyof Check['expected']]);
    },
  );

  it('refuses the owner of an address that is not verified, whatever it holds', async () => {
    const outcome = await inRolledBackTx((db) =>
      attemptAs(db, owner(users.unverified), check.sql, ...check.values(users.unverified)),
    );

    expect(codeOf(outcome)).toBe(NOT_VERIFIED);
  });
});

// who may speak for an account: the account itself and the system; for the end of the account
// also an admin or root
const OTHERS: [string, () => Actor | null][] = [
  ['another buyer', () => ({ role: 'USER', userId: fx.stranger.id })],
  ['an admin', () => ({ role: 'ADMIN', userId: fx.plainAdmin.id })],
  ['a manager of the newsletters', () => ({ role: 'ADMIN', userId: fx.manager.id })],
  ['root', () => ({ role: 'ROOT', userId: fx.root.id })],
  ['a guest', GUEST],
  ['no context', () => null],
];

describe.each(Object.entries(CHECKS).filter(([name]) => !name.startsWith('subscribe')))(
  '%s: who may ask',
  (_name, check) => {
    it('is answered to the system, as to the owner', async () => {
      const run = (actor: Actor) =>
        inRolledBackTx((db) => attemptAs(db, actor, check.sql, ...check.values(users.account)));

      const owned = await run(owner(users.account));
      const system = await run({ role: 'ADMIN' });

      expect(summary(system, check.show)).toBe(summary(owned, check.show));
    });

    it.each(OTHERS)('is refused to %s, for the account of somebody else', async (_who, actor) => {
      const outcome = await inRolledBackTx((db) =>
        attemptAs(db, actor(), check.sql, ...check.values(users.account)),
      );

      expect(codeOf(outcome)).toBe(FORBIDDEN);
    });
  },
);

describe('subscribe_account: who may ask', () => {
  const subscribe = (actor: Actor | null, user: TestUser) =>
    inRolledBackTx((db) =>
      attemptAs(
        db,
        actor,
        SQL.subscribeAccount,
        user.id,
        'de',
        hex64(),
        hex64(),
        hex64(),
        'profile',
        IP,
        AGENT,
      ),
    );

  it('is answered to the system, as to the owner', async () => {
    expect(await subscribe({ role: 'ADMIN' }, users.none)).toEqual({
      ok: true,
      rows: [{ outcome: 'created' }],
    });
  });

  it.each(OTHERS)('is refused to %s, for the account of somebody else', async (_who, actor) => {
    expect(codeOf(await subscribe(actor(), users.none))).toBe(FORBIDDEN);
  });

  it('is refused for an account that does not exist, even to the system', async () => {
    const outcome = await inRolledBackTx((db) =>
      attemptAs(
        db,
        { role: 'ADMIN' },
        SQL.subscribeAccount,
        2_000_000_000,
        'de',
        hex64(),
        hex64(),
        hex64(),
        'profile',
        IP,
        AGENT,
      ),
    );

    expect(codeOf(outcome)).toBe(FORBIDDEN);
  });
});

describe('the subscription of the account', () => {
  const subscribeArgs = (set: { locale?: string | null; place?: string | null } = {}) => ({
    locale: 'locale' in set ? set.locale : 'de',
    salt: hex64(),
    hash: hex64(),
    unsubscribeHash: hex64(),
    place: 'place' in set ? set.place : 'profile',
  });

  const subscribe = (
    db: Parameters<typeof attemptAs>[0],
    user: TestUser,
    args: ReturnType<typeof subscribeArgs>,
  ) =>
    attemptAs<{ outcome: string }>(
      db,
      owner(user),
      SQL.subscribeAccount,
      user.id,
      args.locale,
      args.salt,
      args.hash,
      args.unsubscribeHash,
      args.place,
      IP,
      AGENT,
    );

  it('is made in force at once for an address that holds nothing, with the address of the account', async () => {
    await inRolledBackTx(async (db) => {
      const version = await publishPrivacy(db, fx.root.id);
      const now = await dbNow(db);
      const args = subscribeArgs();

      expect(await subscribe(db, users.none, args)).toEqual({
        ok: true,
        rows: [{ outcome: 'created' }],
      });

      const rows = await subscriptionsOf(db, users.none.email);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        email: users.none.email,
        emailHmac: null,
        userId: users.none.id,
        source: 'account',
        locale: 'de',
        status: 'active',
        confirmHash: null,
        confirmExpiresAt: null,
        manageSalt: args.salt,
        manageHash: args.hash,
        unsubscribeHash: args.unsubscribeHash,
        lastConfirmMailAt: null,
        lastAlreadyMailAt: null,
        endedAt: null,
        endReason: null,
      });
      expect(near(rows[0]!.confirmedAt, now)).toBe(true);
      expect(near(rows[0]!.createdAt, now)).toBe(true);

      // the consent is written down with the version of the policy in force
      expect(await journalOf(db, rows[0]!.id)).toEqual([
        expect.objectContaining({
          event: 'subscribed',
          place: 'profile',
          ip: IP,
          userAgent: AGENT,
          locale: 'de',
          campaignId: null,
          privacyVersion: version,
          actorId: null,
        }),
      ]);
    });
  });

  it('may be made at the registration, and without a language', async () => {
    await inRolledBackTx(async (db) => {
      const args = subscribeArgs({ locale: null, place: 'registration' });

      expect(await subscribe(db, users.none, args)).toMatchObject({ ok: true });

      const [row] = await subscriptionsOf(db, users.none.email);
      expect(row).toMatchObject({ locale: null, status: 'active' });
      expect(await journalOf(db, row!.id)).toEqual([
        expect.objectContaining({ event: 'subscribed', place: 'registration', locale: null }),
      ]);
    });
  });

  it('leaves the ended subscription of the address as it is and makes a new one beside it', async () => {
    await inRolledBackTx(async (db) => {
      const [ended] = await subscriptionsOf(db, users.ended.email);

      expect(await subscribe(db, users.ended, subscribeArgs())).toMatchObject({
        ok: true,
        rows: [{ outcome: 'created' }],
      });

      const rows = await subscriptionsOf(db, users.ended.email);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual(ended);
      expect(rows[1]).toMatchObject({
        source: 'account',
        status: 'active',
        userId: users.ended.id,
      });
    });
  });

  it('turns the request of a stranger that waits on the address into the subscription of the account', async () => {
    await inRolledBackTx(async (db) => {
      const version = await publishPrivacy(db, fx.root.id);
      const now = await dbNow(db);
      const [before] = await subscriptionsOf(db, users.pending.email);
      const args = subscribeArgs({ place: 'registration' });

      expect(await subscribe(db, users.pending, args)).toEqual({
        ok: true,
        rows: [{ outcome: 'converted' }],
      });

      const rows = await subscriptionsOf(db, users.pending.email);
      // the same row: the address still has one subscription, and its history stays
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: before!.id,
        email: users.pending.email,
        emailHmac: null,
        userId: users.pending.id,
        source: 'account',
        // the language of the account's choice, not the one the stranger gave
        locale: 'de',
        status: 'active',
        confirmHash: null,
        confirmExpiresAt: null,
        // the link of management was never mailed: the new one replaces it
        manageSalt: args.salt,
        manageHash: args.hash,
        unsubscribeHash: args.unsubscribeHash,
        endedAt: null,
        endReason: null,
        createdAt: before!.createdAt,
      });
      expect(near(rows[0]!.confirmedAt, now)).toBe(true);

      expect(await journalOf(db, before!.id)).toEqual([
        expect.objectContaining({ id: lineOf.pending, event: 'requested', place: 'form' }),
        expect.objectContaining({
          event: 'subscribed',
          place: 'registration',
          locale: 'de',
          privacyVersion: version,
        }),
      ]);
    });
  });

  it.each(['form', 'formPaused', 'account', 'accountPaused'] as const)(
    'changes nothing when the address holds a subscription in force: %s',
    async (state) => {
      await inRolledBackTx(async (db) => {
        const before = await subscriptionsOf(db, users[state].email);

        expect(await subscribe(db, users[state], subscribeArgs({ place: 'registration' }))).toEqual(
          {
            ok: true,
            rows: [{ outcome: 'already' }],
          },
        );

        expect(await subscriptionsOf(db, users[state].email)).toEqual(before);
        expect(await journalOf(db, before[0]!.id)).toHaveLength(1);
      });
    },
  );

  it.each(['somewhere', 'form', 'admin', 'webhook', 'manage_page', 'mail_client', '', null])(
    'is refused a place that is not the profile or the registration: %p',
    async (place) => {
      await inRolledBackTx(async (db) => {
        const outcome = await subscribe(db, users.none, subscribeArgs({ place }));

        expect(codeOf(outcome)).toBe('NEWSLETTER_PLACE_INVALID');
        expect(await subscriptionsOf(db, users.none.email)).toEqual([]);
      });
    },
  );

  it.each(['EN', 'eng', '', 'e1'])(
    'is refused a language that is not two lower-case letters: %p',
    async (locale) => {
      await inRolledBackTx(async (db) => {
        const outcome = await subscribe(db, users.none, subscribeArgs({ locale }));

        expect(codeOf(outcome)).toBe('NEWSLETTER_LOCALE_INVALID');
        expect(await subscriptionsOf(db, users.none.email)).toEqual([]);
      });
    },
  );

  it('does not wait for the blocklist: the form is the one that is blocked, not the account', async () => {
    await inRolledBackTx(async (db) => {
      // a stranger asks for the address, and the owner of the mailbox answers "this was not me"
      const asked = requestArgs({ email: users.none.email });
      await requestAs(db, GUEST(), asked);
      const blocked = await attemptAs(db, GUEST(), SQL.notMe, asked.confirmHash, IP, AGENT);
      expect(blocked).toEqual({ ok: true, rows: [{ done: true }] });

      const again = await requestAs(
        db,
        GUEST(),
        requestArgs({ email: users.none.email, emailHmac: asked.emailHmac }),
      );
      expect(again).toMatchObject({ ok: true, rows: [{ outcome: 'nothing' }] });

      // the account still subscribes on its own address
      expect(await subscribe(db, users.none, subscribeArgs())).toEqual({
        ok: true,
        rows: [{ outcome: 'created' }],
      });
    });
  });
});

describe('the subscription seen from the profile', () => {
  it('shows when the subscription began', async () => {
    await inRolledBackTx(async (db) => {
      const [row] = await subscriptionsOf(db, users.account.email);
      const outcome = await attemptAs<{ subscribed_at: Date }>(
        db,
        owner(users.account),
        SQL.profileGet,
        users.account.id,
      );

      expect(outcome.ok && outcome.rows[0]!.subscribed_at).toEqual(
        row!.confirmedAt ?? row!.createdAt,
      );
    });
  });

  it('shows the subscription of the form that was made on the address, and not those of others', async () => {
    const outcome = await inRolledBackTx((db) =>
      attemptAs(db, owner(users.form), SQL.profileGet, users.form.id),
    );

    expect(outcome).toMatchObject({ ok: true, rows: [{ source: 'form', status: 'active' }] });
  });
});

describe('the unsubscribe from the profile', () => {
  it.each(['form', 'formPaused', 'account', 'accountPaused'] as const)(
    'ends a subscription of %s at once and writes it down, leaving the others as they are',
    async (state) => {
      await inRolledBackTx(async (db) => {
        const [before] = await subscriptionsOf(db, users[state].email);
        const others = await subscriptionsOf(db, users.none.email);
        const otherForm = await subscriptionsOf(db, users.form.email);
        const now = await dbNow(db);

        const outcome = await attemptAs(
          db,
          owner(users[state]),
          SQL.profileUnsubscribe,
          users[state].id,
          IP,
          AGENT,
        );
        expect(outcome).toEqual({ ok: true, rows: [{ done: true }] });

        const [after] = await subscriptionsOf(db, users[state].email);
        expect(after).toMatchObject({ id: before!.id, status: 'ended', endReason: 'unsubscribed' });
        expect(near(after!.endedAt, now)).toBe(true);

        const lines = await journalOf(db, before!.id);
        expect(lines).toHaveLength(2);
        expect(lines[1]).toMatchObject({
          event: 'unsubscribed',
          place: 'profile',
          ip: IP,
          userAgent: AGENT,
          locale: 'en',
          campaignId: null,
          privacyVersion: null,
          actorId: null,
        });

        expect(await subscriptionsOf(db, users.none.email)).toEqual(others);
        if (state !== 'form')
          expect(await subscriptionsOf(db, users.form.email)).toEqual(otherForm);
      });
    },
  );

  it('lets the checkbox of the profile make a subscription of the account afterwards', async () => {
    await inRolledBackTx(async (db) => {
      await attemptAs(db, owner(users.form), SQL.profileUnsubscribe, users.form.id, IP, AGENT);

      const outcome = await attemptAs(
        db,
        owner(users.form),
        SQL.subscribeAccount,
        users.form.id,
        'en',
        hex64(),
        hex64(),
        hex64(),
        'profile',
        IP,
        AGENT,
      );
      expect(outcome).toEqual({ ok: true, rows: [{ outcome: 'created' }] });

      const rows = await subscriptionsOf(db, users.form.email);
      expect(rows.map((row) => [row.source, row.status])).toEqual([
        ['form', 'ended'],
        ['account', 'active'],
      ]);
    });
  });
});

describe('the language from the profile', () => {
  it('is changed on a subscription of the account and written to the journal', async () => {
    await inRolledBackTx(async (db) => {
      const [before] = await subscriptionsOf(db, users.account.email);
      await attemptAs(
        db,
        owner(users.account),
        SQL.profileSetLocale,
        users.account.id,
        'de',
        IP,
        AGENT,
      );

      const [after] = await subscriptionsOf(db, users.account.email);
      expect(after).toMatchObject({ locale: 'de', status: 'active', source: 'account' });

      const lines = await journalOf(db, before!.id);
      expect(lines[1]).toMatchObject({
        event: 'locale_changed',
        place: 'profile',
        ip: IP,
        userAgent: AGENT,
        locale: 'de',
        privacyVersion: null,
      });
    });
  });

  it('does nothing and writes nothing when it is the one the subscription has', async () => {
    await inRolledBackTx(async (db) => {
      const [before] = await subscriptionsOf(db, users.account.email);
      const outcome = await attemptAs(
        db,
        owner(users.account),
        SQL.profileSetLocale,
        users.account.id,
        'en',
        IP,
        AGENT,
      );

      expect(outcome).toEqual({ ok: true, rows: [{ done: false }] });
      expect(await subscriptionsOf(db, users.account.email)).toEqual([before]);
      expect(await journalOf(db, before!.id)).toHaveLength(1);
    });
  });

  it('is changed to a language only: two lower-case letters, never none', async () => {
    await inRolledBackTx(async (db) => {
      for (const locale of ['EN', 'eng', '', 'e1', null]) {
        const outcome = await attemptAs(
          db,
          owner(users.account),
          SQL.profileSetLocale,
          users.account.id,
          locale,
          IP,
          AGENT,
        );
        expect(codeOf(outcome)).toBe('NEWSLETTER_LOCALE_INVALID');
      }
    });
  });
});

describe('the resume from the profile', () => {
  it.each(['formPaused', 'accountPaused'] as const)(
    'puts a paused subscription (%s) back in force and writes it down',
    async (state) => {
      await inRolledBackTx(async (db) => {
        const [before] = await subscriptionsOf(db, users[state].email);
        const outcome = await attemptAs(
          db,
          owner(users[state]),
          SQL.profileResume,
          users[state].id,
          IP,
          AGENT,
        );
        expect(outcome).toEqual({ ok: true, rows: [{ done: true }] });

        const [after] = await subscriptionsOf(db, users[state].email);
        expect(after).toMatchObject({ id: before!.id, status: 'active', endedAt: null });

        const lines = await journalOf(db, before!.id);
        expect(lines[1]).toMatchObject({
          event: 'restored',
          place: 'profile',
          ip: IP,
          userAgent: AGENT,
        });
      });
    },
  );
});

describe('the export from the profile', () => {
  it('gives the subscriptions of the address with their journals: the ended one too', async () => {
    const outcome = await inRolledBackTx((db) =>
      attemptAs<{ data: { subscriptions: Record<string, unknown>[] } }>(
        db,
        owner(history),
        SQL.profileExport,
        history.id,
      ),
    );

    const ISO = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const line = (event: string, place: string) => ({
      event,
      place,
      ip: '203.0.113.7',
      userAgent: 'test-agent',
      locale: 'en',
      campaignId: null,
      privacyVersion: null,
      createdAt: ISO,
    });

    expect(outcome.ok && outcome.rows[0]!.data).toEqual({
      subscriptions: [
        {
          email: history.email,
          source: 'form',
          locale: 'es',
          status: 'ended',
          createdAt: ISO,
          confirmedAt: ISO,
          endedAt: ISO,
          endReason: 'unsubscribed',
          events: [line('subscribed', 'form'), line('unsubscribed', 'mail_client')],
        },
        {
          email: history.email,
          source: 'account',
          locale: 'en',
          status: 'active',
          createdAt: ISO,
          confirmedAt: ISO,
          endedAt: null,
          endReason: null,
          events: [line('subscribed', 'profile')],
        },
      ],
    });
  });

  it('gives none of the secrets and none of the ids of the rows', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const [row] = await subscriptionsOf(db, users.account.email);
      const exported = await attemptAs<{ data: unknown }>(
        db,
        owner(users.account),
        SQL.profileExport,
        users.account.id,
      );
      return { row: row!, exported };
    });

    const text = JSON.stringify(outcome.exported.ok && outcome.exported.rows[0]!.data);
    for (const secret of [outcome.row.manageHash, outcome.row.manageSalt]) {
      expect(text).not.toContain(secret);
    }
    for (const key of [
      '"id"',
      '"userId"',
      '"actorId"',
      '"subscriptionId"',
      '"emailHmac"',
      'Hash',
      'Salt',
    ]) {
      expect(text).not.toContain(key);
    }
  });
});

describe('the end of the account', () => {
  const end = (actor: Actor | null, user: TestUser) =>
    inRolledBackTx(async (db) => {
      const before = await subscriptionsOf(db, user.email);
      const now = await dbNow(db);
      const outcome = await attemptAs<{ ended: number }>(db, actor, SQL.endForAccount, user.id);
      const rows = await subscriptionsOf(db, user.email);
      const lines: Awaited<ReturnType<typeof journalOf>> = [];
      for (const row of rows) lines.push(...(await journalOf(db, row.id)));
      return { outcome, before, rows, lines, now };
    });

  it.each([
    ['none', 0],
    ['pending', 0],
    ['form', 1],
    ['formPaused', 1],
    ['account', 1],
    ['accountPaused', 1],
    ['ended', 0],
    ['stopped', 0],
    // the address of an account that never proved it is not the account's: the subscription that
    // sits on it belongs to whoever owns the mailbox
    ['unverified', 0],
  ] as const)('ends what the address %s holds and says how many (%s)', async (state, count) => {
    const { outcome, before, rows, now } = await end(owner(users[state]), users[state]);

    expect(outcome).toEqual({ ok: true, rows: [{ ended: count }] });

    const inForce = ['active', 'paused_complaint'];
    rows.forEach((row, index) => {
      const was = before[index]!;
      if (count === 1 && inForce.includes(was.status)) {
        expect(row).toMatchObject({ status: 'ended', endReason: 'account_deleted' });
        expect(near(row.endedAt, now)).toBe(true);
      } else {
        expect(row).toEqual(was);
      }
    });
  });

  it('ends the subscription of the account and the one of the form, with a line each', async () => {
    for (const state of ['account', 'form'] as const) {
      const { rows, lines } = await end(owner(users[state]), users[state]);

      expect(rows[0]).toMatchObject({ status: 'ended', endReason: 'account_deleted' });
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatchObject({
        event: 'account_deleted',
        place: 'profile',
        ip: null,
        userAgent: null,
        campaignId: null,
        privacyVersion: null,
        actorId: null,
      });
    }
  });

  it('names the account in the subscription of the form it ends, and in no other', async () => {
    const form = await end(owner(users.form), users.form);
    expect(form.rows[0]).toMatchObject({ source: 'form', endedUserId: users.form.id });

    const account = await end(owner(users.account), users.account);
    expect(account.rows[0]).toMatchObject({ source: 'account', endedUserId: null });

    // a subscription that ended before the account went is not the account's doing
    const earlier = await end(owner(users.ended), users.ended);
    expect(earlier.rows[0]).toMatchObject({ status: 'ended', endedUserId: null });
  });

  it('writes the account into the subscription of the form it ends, whoever asks', async () => {
    for (const actor of [
      { role: 'ADMIN' } as Actor,
      { role: 'ROOT', userId: fx.root.id } as Actor,
    ]) {
      const { rows } = await end(actor, users.formPaused);
      expect(rows[0]).toMatchObject({ source: 'form', endedUserId: users.formPaused.id });
    }
  });

  it('leaves the request that waits on the address to its three days', async () => {
    const { rows, lines } = await end(owner(users.pending), users.pending);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending' });
    expect(lines).toHaveLength(1);
  });

  it.each([
    ['the system', { role: 'ADMIN' } as Actor, 'system', null],
    [
      'an admin',
      () => ({ role: 'ADMIN', userId: fx.plainAdmin.id }) as Actor,
      'admin',
      () => fx.plainAdmin.id,
    ],
    ['root', () => ({ role: 'ROOT', userId: fx.root.id }) as Actor, 'admin', () => fx.root.id],
  ] as const)(
    'is done by %s as well, and the line says who',
    async (_who, actor, place, adminId) => {
      const acting = typeof actor === 'function' ? actor() : actor;
      const { outcome, rows, lines } = await end(acting, users.account);

      expect(outcome).toEqual({ ok: true, rows: [{ ended: 1 }] });
      expect(rows[0]).toMatchObject({ status: 'ended', endReason: 'account_deleted' });
      expect(lines[1]).toMatchObject({
        event: 'account_deleted',
        place,
        actorId: adminId ? adminId() : null,
      });
    },
  );

  it.each([
    ['another buyer', () => ({ role: 'USER', userId: fx.stranger.id }) as Actor],
    ['a guest', GUEST],
    ['no context', () => null],
  ])('is refused to %s, for the account of somebody else', async (_who, actor) => {
    const { outcome, before, rows } = await end(actor(), users.account);

    expect(codeOf(outcome)).toBe(FORBIDDEN);
    expect(rows).toEqual(before);
  });

  it('ends nothing for an account that does not exist', async () => {
    const outcome = await inRolledBackTx((db) =>
      attemptAs(db, { role: 'ADMIN' }, SQL.endForAccount, 2_000_000_000),
    );

    expect(outcome).toEqual({ ok: true, rows: [{ ended: 0 }] });
  });

  it('lets the address ask again once it ended: the form makes a request of its own', async () => {
    await inRolledBackTx(async (db) => {
      await attemptAs(db, owner(users.form), SQL.endForAccount, users.form.id);

      const asked = await requestAs(db, GUEST(), requestArgs({ email: users.form.email }));
      expect(asked).toMatchObject({ ok: true, rows: [{ outcome: 'confirm' }] });
      expect((await subscriptionsOf(db, users.form.email)).map((row) => row.status)).toEqual([
        'ended',
        'pending',
      ]);
    });
  });
});

describe('the export: only what the person confirmed', () => {
  it('leaves out a request that was never confirmed, whether it waits or it ended', async () => {
    await inOwnerTx(async (db) => {
      const user = await createUser();
      await insertSubscription(db, {
        status: 'ended',
        email: user.email,
        set: { confirmedAt: null },
      });
      await insertSubscription(db, { status: 'pending', email: user.email });

      const outcome = await attemptAs<{ data: { subscriptions: unknown[] } }>(
        db,
        owner(user),
        SQL.profileExport,
        user.id,
      );

      expect(outcome.ok && outcome.rows[0]!.data).toEqual({ subscriptions: [] });
    });
  });

  it('gives the one it confirmed that ended later, and not the request beside it', async () => {
    await inOwnerTx(async (db) => {
      const user = await createUser();
      await insertSubscription(db, { status: 'ended', email: user.email, locale: 'es' });
      await insertSubscription(db, {
        status: 'ended',
        email: user.email,
        locale: 'it',
        set: { confirmedAt: null },
      });
      await insertSubscription(db, { status: 'pending', email: user.email, locale: 'de' });

      const outcome = await attemptAs<{ data: { subscriptions: { locale: string }[] } }>(
        db,
        owner(user),
        SQL.profileExport,
        user.id,
      );

      expect(outcome.ok && outcome.rows[0]!.data.subscriptions.map((row) => row.locale)).toEqual([
        'es',
      ]);
    });
  });

  it('gives a subscription of the account whatever its dates say: the account made it', async () => {
    await inOwnerTx(async (db) => {
      const user = await createUser();
      await insertSubscription(db, {
        source: 'account',
        status: 'active',
        email: user.email,
        userId: user.id,
        set: { confirmedAt: null },
      });

      const outcome = await attemptAs<{ data: { subscriptions: unknown[] } }>(
        db,
        owner(user),
        SQL.profileExport,
        user.id,
      );

      expect(outcome.ok && outcome.rows[0]!.data.subscriptions).toHaveLength(1);
    });
  });
});

describe('the export of an account that was deleted', () => {
  // the way the server deletes an account: the subscriptions end first, then the account takes the
  // address of a deleted one
  async function deleteAccount(db: Parameters<typeof attemptAs>[0], user: TestUser) {
    await attemptAs(db, { role: 'ADMIN' }, SQL.endForAccount, user.id);
    await db.as({ role: 'ROOT', userId: fx.root.id });
    await db.rows(
      `update cartlify.users set email = $2, "deletedAt" = now() at time zone 'utc' where id = $1`,
      user.id,
      `deleted+${user.id}+${user.email}`.toLowerCase(),
    );
  }

  type Exported = {
    data: { subscriptions: { source: string; status: string; endReason: string }[] };
  };

  const exportAs = (db: Parameters<typeof attemptAs>[0], actor: Actor | null, user: TestUser) =>
    attemptAs<Exported>(db, actor, SQL.profileExport, user.id);

  it('finds the subscription of the form the deletion ended by the id of the account', async () => {
    await inOwnerTx(async (db) => {
      const user = await createUser();
      await insertSubscription(db, { status: 'active', email: user.email, locale: 'en' });
      await deleteAccount(db, user);

      const outcome = await exportAs(db, { role: 'ADMIN' }, user);

      expect(outcome.ok && outcome.rows[0]!.data.subscriptions).toEqual([
        expect.objectContaining({ source: 'form', status: 'ended', endReason: 'account_deleted' }),
      ]);
    });
  });

  it('finds the subscription of the account by the account', async () => {
    await inOwnerTx(async (db) => {
      const user = await createUser();
      await insertSubscription(db, {
        source: 'account',
        status: 'active',
        email: user.email,
        userId: user.id,
      });
      await deleteAccount(db, user);

      const outcome = await exportAs(db, { role: 'ADMIN' }, user);

      expect(outcome.ok && outcome.rows[0]!.data.subscriptions).toEqual([
        expect.objectContaining({ source: 'account', status: 'ended' }),
      ]);
    });
  });

  it('does not find a subscription of the form the account did not end, nor a request on the old address', async () => {
    await inOwnerTx(async (db) => {
      const user = await createUser();
      // ended by the person long before, and a request that waits: neither is the account's doing
      await insertSubscription(db, { status: 'ended', email: user.email });
      await insertSubscription(db, { status: 'pending', email: user.email });
      await deleteAccount(db, user);

      const outcome = await exportAs(db, { role: 'ADMIN' }, user);

      expect(outcome.ok && outcome.rows[0]!.data.subscriptions).toEqual([]);
    });
  });

  it('gives a live account what its address holds, as before', async () => {
    await inOwnerTx(async (db) => {
      const user = await createUser();
      await insertSubscription(db, { status: 'active', email: user.email, locale: 'en' });

      const outcome = await exportAs(db, owner(user), user);

      expect(outcome.ok && outcome.rows[0]!.data.subscriptions).toHaveLength(1);
    });
  });

  it('is not given to the owner of a deleted account, nor to a guest: only the system and the staff ask', async () => {
    await inOwnerTx(async (db) => {
      const user = await createUser();
      await deleteAccount(db, user);

      expect(codeOf(await exportAs(db, GUEST(), user))).toBe(FORBIDDEN);
      expect(codeOf(await exportAs(db, null, user))).toBe(FORBIDDEN);
    });
  });
});
