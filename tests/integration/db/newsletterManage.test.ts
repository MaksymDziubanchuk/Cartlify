import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import {
  inRolledBackTx,
  type Actor,
  type DbSession,
  type Outcome as DbOutcome,
} from '../../helpers/db.js';
import { createUser, uniqueEmail, type TestUser } from '../../helpers/factories.js';
import {
  blockRow,
  campaignIn as sentCampaignIn,
  draftCampaignIn,
  eventRow,
  hex64,
  insertRow,
  insertSubscription,
  recipientIn,
  removeNewsletterFixtures,
  removeSubscriptionRows,
  setupNewsletterFixtures,
  utc,
  type NewsletterFixtures,
  type SubscriptionOpts,
} from '../../helpers/newsletterDb.js';
import {
  AGENT,
  DAY,
  GUEST,
  IP,
  READER,
  SQL,
  SYSTEM,
  attemptAs,
  callAs,
  codeOf,
  dbNow,
  journalOf,
  near,
  publishPrivacy,
  requestAs,
  requestArgs,
  subscriptionById,
  subscriptionsOf,
} from '../../helpers/newsletterFns.js';
import { inOwnerTx } from '../../helpers/ownerDb.js';

// the steps of the person who holds a link of a mail, none of them signed in: the confirmation of
// a request, "this was not me", and the page "manage the subscription" (read, change the language,
// unsubscribe, resume after a complaint, export). They are cartlify.newsletter_confirm, _not_me
// and _manage_*; the link is found by the sha256 of its token. The rows are committed by the
// owner, every statement of a test runs in a transaction that rolls back

let fx: NewsletterFixtures;
const subscriptionIds: number[] = [];
const blockedHmacs: string[] = [];

type StateName =
  'form' | 'formPaused' | 'account' | 'accountPaused' | 'pending' | 'ended' | 'stopped';

// the rows of the page of management, and the token of each (the sha256 the database keeps)
const STATES: Record<StateName, Omit<SubscriptionOpts, 'email' | 'userId'>> = {
  form: { status: 'active', locale: 'en' },
  formPaused: { status: 'paused_complaint', locale: 'en' },
  account: { source: 'account', status: 'active', locale: 'en' },
  accountPaused: { source: 'account', status: 'paused_complaint', locale: 'en' },
  pending: { status: 'pending', locale: 'en' },
  ended: { status: 'ended', locale: 'en' },
  stopped: { status: 'stopped_bounce', locale: 'en' },
};
const STATE_NAMES = Object.keys(STATES) as StateName[];

const manageHash = Object.fromEntries(STATE_NAMES.map((name) => [name, hex64()])) as Record<
  StateName,
  string
>;
const emailOf = {} as Record<StateName, string>;

// the requests that wait for the confirmation, each with the link in the mail
const LINKS = {
  valid: hex64(),
  expired: hex64(),
  forNotMe: hex64(),
  forNotMeBlocked: hex64(),
};
const notMeHmac = hex64();
const blockedHmac = hex64();
const emailOfLink = {} as Record<keyof typeof LINKS, string>;

let accountUser: TestUser;
let pausedUser: TestUser;

beforeAll(async () => {
  fx = await setupNewsletterFixtures();
  accountUser = await createUser();
  pausedUser = await createUser();

  await inOwnerTx(
    async (db) => {
      for (const name of STATE_NAMES) {
        const user = name === 'account' ? accountUser : pausedUser;
        const isAccount = STATES[name].source === 'account';
        const email = isAccount ? user.email : uniqueEmail(name.toLowerCase());
        emailOf[name] = email;

        subscriptionIds.push(
          await insertSubscription(db, {
            ...STATES[name],
            email,
            userId: isAccount ? user.id : undefined,
            set: { manageHash: manageHash[name] },
          }),
        );
      }

      const pendings: [keyof typeof LINKS, Record<string, unknown>][] = [
        ['valid', { emailHmac: hex64() }],
        ['expired', { emailHmac: hex64(), confirmExpiresAt: utc(-3_600_000) }],
        ['forNotMe', { emailHmac: notMeHmac }],
        ['forNotMeBlocked', { emailHmac: blockedHmac }],
      ];

      for (const [name, set] of pendings) {
        emailOfLink[name] = uniqueEmail(`link-${name.toLowerCase()}`);
        const id = await insertSubscription(db, {
          email: emailOfLink[name],
          status: 'pending',
          locale: 'es',
          set: { confirmHash: LINKS[name], ...set },
        });
        subscriptionIds.push(id);
        // a line of the request, to see it go with the row on "this was not me"
        await insertRow(db, 'newsletter_subscription_events', eventRow(id));
      }

      await insertRow(db, 'newsletter_form_blocklist', blockRow({ emailHmac: blockedHmac }));
      blockedHmacs.push(blockedHmac, notMeHmac);
    },
    { commit: true },
  );
});

afterAll(async () => {
  try {
    await removeSubscriptionRows(subscriptionIds, blockedHmacs);
    if (fx) await removeNewsletterFixtures(fx);
  } finally {
    await prisma.$disconnect();
  }
});

const ACTORS: [string, () => Actor | null][] = [
  ['a guest', GUEST],
  ['no context', () => null],
  ['a buyer', () => ({ role: 'USER', userId: fx.stranger.id })],
  ['an admin', () => ({ role: 'ADMIN', userId: fx.plainAdmin.id })],
  ['root', () => ({ role: 'ROOT', userId: fx.root.id })],
  ['the system', () => ({ role: 'ADMIN' })],
];

const LINK_INVALID = 'NEWSLETTER_LINK_INVALID';

describe('the link of a request', () => {
  const confirm = (db: DbSession, actor: Actor | null, hash: string | null) =>
    attemptAs<{ outcome: string; locale: string | null }>(db, actor, SQL.confirm, hash, IP, AGENT);

  it.each(ACTORS)('confirms the subscription for %s who follows it', async (_who, actor) => {
    await inRolledBackTx(async (db) => {
      const [before] = await subscriptionsOf(db, emailOfLink.valid);
      const now = await dbNow(db);

      const outcome = await confirm(db, actor(), LINKS.valid);
      expect(outcome).toEqual({ ok: true, rows: [{ outcome: 'confirmed', locale: 'es' }] });

      const [after] = await subscriptionsOf(db, emailOfLink.valid);
      // the link is spent with the state it opened: in force, no token, no deadline
      expect(after).toMatchObject({
        id: before!.id,
        status: 'active',
        source: 'form',
        locale: 'es',
        confirmHash: null,
        confirmExpiresAt: null,
        endedAt: null,
        endReason: null,
        manageHash: before!.manageHash,
      });
      expect(near(after!.confirmedAt, now)).toBe(true);

      const lines = await journalOf(db, before!.id);
      expect(lines.slice(1)).toEqual([
        expect.objectContaining({
          event: 'confirmed',
          place: 'form',
          ip: IP,
          userAgent: AGENT,
          locale: 'es',
          campaignId: null,
          actorId: null,
        }),
      ]);
    });
  });

  it('writes the address and the browser of the request cut to a sane length', async () => {
    await inRolledBackTx(async (db) => {
      const [row] = await subscriptionsOf(db, emailOfLink.valid);
      await attemptAs(db, GUEST(), SQL.confirm, LINKS.valid, '9'.repeat(100), 'a'.repeat(2000));

      const lines = await journalOf(db, row!.id);
      expect(lines[1]!.ip).toBe('9'.repeat(64));
      expect(lines[1]!.userAgent).toBe('a'.repeat(512));
    });
  });

  it('works once: the same link is dead the second time', async () => {
    await inRolledBackTx(async (db) => {
      const first = await confirm(db, GUEST(), LINKS.valid);
      const second = await confirm(db, GUEST(), LINKS.valid);

      expect(first).toMatchObject({ ok: true, rows: [{ outcome: 'confirmed' }] });
      expect(second).toEqual({ ok: true, rows: [{ outcome: 'invalid', locale: null }] });

      const [row] = await subscriptionsOf(db, emailOfLink.valid);
      expect(await journalOf(db, row!.id)).toHaveLength(2);
    });
  });

  it('is dead after the three days: the request stays as it was', async () => {
    await inRolledBackTx(async (db) => {
      const [before] = await subscriptionsOf(db, emailOfLink.expired);
      const outcome = await confirm(db, GUEST(), LINKS.expired);

      expect(outcome).toEqual({ ok: true, rows: [{ outcome: 'invalid', locale: null }] });
      expect(await subscriptionsOf(db, emailOfLink.expired)).toEqual([before]);
      expect(await journalOf(db, before!.id)).toHaveLength(1);
    });
  });

  it.each([
    ['a token nobody was given', hex64()],
    ['an empty token', ''],
    ['spaces', '   '],
    ['no token', null],
    ['the token of a subscription in force (a management link)', manageHash.form],
  ])('is no link: %s', async (_what, hash) => {
    const outcome = await inRolledBackTx((db) => confirm(db, GUEST(), hash));

    expect(outcome).toEqual({ ok: true, rows: [{ outcome: 'invalid', locale: null }] });
  });

  it('is found however the sender padded it: the token is trimmed', async () => {
    const outcome = await inRolledBackTx((db) => confirm(db, GUEST(), `  ${LINKS.valid} `));

    expect(outcome).toMatchObject({ ok: true, rows: [{ outcome: 'confirmed' }] });
  });
});

describe('"this was not me"', () => {
  const notMe = (db: DbSession, actor: Actor | null, hash: string | null) =>
    attemptAs<{ done: boolean }>(db, actor, SQL.notMe, hash, IP, AGENT);

  const blockOf = (db: DbSession, hmac: string) =>
    callAs<{ byPerson: boolean; blockedById: number | null; reason: string | null }>(
      db,
      READER,
      `select "byPerson", "blockedById", reason from cartlify.newsletter_form_blocklist
       where "emailHmac" = $1`,
      hmac,
    );

  it.each(ACTORS)('blocks the address and removes the request, for %s', async (_who, actor) => {
    await inRolledBackTx(async (db) => {
      const [before] = await subscriptionsOf(db, emailOfLink.forNotMe);

      expect(await notMe(db, actor(), LINKS.forNotMe)).toEqual({
        ok: true,
        rows: [{ done: true }],
      });

      // the address is blocked by the person: no admin behind it, no reason
      expect(await blockOf(db, notMeHmac)).toEqual([
        { byPerson: true, blockedById: null, reason: null },
      ]);
      // the request is gone with its lines
      expect(await subscriptionById(db, before!.id)).toBeNull();
      expect(await journalOf(db, before!.id)).toEqual([]);
    });
  });

  it('kills the link, and the form sends no mail to the address any more', async () => {
    await inRolledBackTx(async (db) => {
      await notMe(db, GUEST(), LINKS.forNotMe);

      const confirmed = await callAs(db, GUEST(), SQL.confirm, LINKS.forNotMe, IP, AGENT);
      expect(confirmed).toEqual([{ outcome: 'invalid', locale: null }]);
      expect(await notMe(db, GUEST(), LINKS.forNotMe)).toEqual({
        ok: true,
        rows: [{ done: false }],
      });

      // a new request on the address, with its HMAC, gets the usual answer and nothing is made
      const asked = await requestAs(
        db,
        GUEST(),
        requestArgs({ email: emailOfLink.forNotMe, emailHmac: notMeHmac }),
      );
      expect(asked).toEqual({
        ok: true,
        rows: [{ outcome: 'nothing', locale: null, manage_salt: null }],
      });
      expect(await subscriptionsOf(db, emailOfLink.forNotMe)).toEqual([]);
    });
  });

  it('adds nothing twice when the address was blocked already, and still removes the request', async () => {
    await inRolledBackTx(async (db) => {
      const [before] = await subscriptionsOf(db, emailOfLink.forNotMeBlocked);

      expect(await notMe(db, GUEST(), LINKS.forNotMeBlocked)).toEqual({
        ok: true,
        rows: [{ done: true }],
      });

      // the entry of the admin stays as it was
      const entries = await blockOf(db, blockedHmac);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ byPerson: true, blockedById: null });
      expect(await subscriptionById(db, before!.id)).toBeNull();
    });
  });

  it('is dead after the three days: the request stays and the address is not blocked', async () => {
    await inRolledBackTx(async (db) => {
      const [before] = await subscriptionsOf(db, emailOfLink.expired);

      expect(await notMe(db, GUEST(), LINKS.expired)).toEqual({
        ok: true,
        rows: [{ done: false }],
      });
      expect(await subscriptionsOf(db, emailOfLink.expired)).toEqual([before]);
      expect(await blockOf(db, before!.emailHmac!)).toEqual([]);
    });
  });

  it.each([
    ['a token nobody was given', hex64()],
    ['an empty token', ''],
    ['no token', null],
    ['the token of a subscription in force (a management link)', manageHash.form],
  ])('is no link: %s', async (_what, hash) => {
    await inRolledBackTx(async (db) => {
      const [before] = await subscriptionsOf(db, emailOf.form);

      expect(await notMe(db, GUEST(), hash)).toEqual({ ok: true, rows: [{ done: false }] });
      expect(await subscriptionsOf(db, emailOf.form)).toEqual([before]);
    });
  });
});

// the page of management: what each of its functions answers for the link of each state of a
// subscription. A subscription in force or paused has a link that works; a request that waits, an
// ended or a stopped one has none, and the token nobody was given is no link either
type Check = {
  sql: string;
  values: (hash: string | null) => unknown[];
  show: (row: Record<string, unknown>) => string;
  expected: Record<StateName | 'unknown', string>;
};

const DEAD = Object.fromEntries(
  (['pending', 'ended', 'stopped', 'unknown'] as const).map((name) => [name, LINK_INVALID]),
) as Record<'pending' | 'ended' | 'stopped' | 'unknown', string>;

const CHECKS: Record<string, Check> = {
  'manage_get (source/language/status/can change the language)': {
    sql: SQL.manageGet,
    values: (hash) => [hash],
    show: (row) => `${row.source}/${row.locale}/${row.status}/${row.can_change_locale}`,
    expected: {
      form: 'form/en/active/true',
      formPaused: 'form/en/paused_complaint/true',
      account: 'account/en/active/false',
      accountPaused: 'account/en/paused_complaint/false',
      ...DEAD,
    },
  },
  'manage_set_locale (changed)': {
    sql: SQL.manageSetLocale,
    values: (hash) => [hash, 'de', IP, AGENT],
    show: (row) => String(row.done),
    expected: {
      form: 'true',
      formPaused: 'true',
      account: 'NEWSLETTER_LOCALE_NOT_ALLOWED',
      accountPaused: 'NEWSLETTER_LOCALE_NOT_ALLOWED',
      ...DEAD,
    },
  },
  'manage_unsubscribe (ended now)': {
    sql: SQL.manageUnsubscribe,
    values: (hash) => [hash, null, 'manage_page', IP, AGENT],
    show: (row) => String(row.done),
    expected: {
      form: 'true',
      formPaused: 'true',
      account: 'true',
      accountPaused: 'true',
      // a link that no longer holds a subscription in force has nothing left to end
      pending: 'false',
      ended: 'false',
      stopped: 'false',
      unknown: LINK_INVALID,
    },
  },
  'manage_resume (resumed)': {
    sql: SQL.manageResume,
    values: (hash) => [hash, IP, AGENT],
    show: (row) => String(row.done),
    expected: {
      form: 'false',
      formPaused: 'true',
      account: 'false',
      accountPaused: 'true',
      ...DEAD,
    },
  },
  manage_export: {
    sql: SQL.manageExport,
    values: (hash) => [hash],
    show: () => 'data',
    expected: {
      form: 'data',
      formPaused: 'data',
      account: 'data',
      accountPaused: 'data',
      ...DEAD,
    },
  },
};

const summary = (outcome: DbOutcome, show: Check['show']): string =>
  outcome.ok ? show(outcome.rows[0] ?? {}) : (outcome.message ?? String(outcome.code));

describe.each(Object.entries(CHECKS))('%s', (_name, check) => {
  it.each([...STATE_NAMES, 'unknown'] as const)('answers the link of: %s', async (state) => {
    const hash = state === 'unknown' ? hex64() : manageHash[state];

    const outcome = await inRolledBackTx((db) =>
      attemptAs(db, GUEST(), check.sql, ...check.values(hash)),
    );

    expect(summary(outcome, check.show)).toBe(check.expected[state]);
  });

  it.each([
    ['an empty token', ''],
    ['spaces', '  '],
    ['no token', null],
  ])('is no link: %s', async (_what, hash) => {
    const outcome = await inRolledBackTx((db) =>
      attemptAs(db, GUEST(), check.sql, ...check.values(hash)),
    );

    // an unsubscribe by a link that is not one is refused like the others
    expect(summary(outcome, check.show)).toBe(LINK_INVALID);
  });
});

describe('the page of management', () => {
  it.each(ACTORS)('shows the subscription to %s who holds the link', async (_who, actor) => {
    const outcome = await inRolledBackTx((db) =>
      attemptAs(db, actor(), SQL.manageGet, manageHash.form),
    );

    expect(outcome).toEqual({
      ok: true,
      rows: [
        {
          email: emailOf.form,
          source: 'form',
          locale: 'en',
          status: 'active',
          can_change_locale: true,
        },
      ],
    });
  });

  it.each(ACTORS)('lets %s who holds the link unsubscribe from the page', async (_who, actor) => {
    await inRolledBackTx(async (db) => {
      const outcome = await attemptAs(
        db,
        actor(),
        SQL.manageUnsubscribe,
        manageHash.form,
        null,
        'manage_page',
        IP,
        AGENT,
      );
      expect(outcome).toEqual({ ok: true, rows: [{ done: true }] });
    });
  });

  describe('the language', () => {
    it('is changed on a subscription of the form and written to the journal', async () => {
      await inRolledBackTx(async (db) => {
        const [before] = await subscriptionsOf(db, emailOf.form);
        const outcome = await attemptAs(
          db,
          GUEST(),
          SQL.manageSetLocale,
          manageHash.form,
          'de',
          IP,
          AGENT,
        );
        expect(outcome).toEqual({ ok: true, rows: [{ done: true }] });

        const [after] = await subscriptionsOf(db, emailOf.form);
        expect({ ...after, locale: null, updatedAt: null }).toEqual({
          ...before,
          locale: null,
          updatedAt: null,
        });
        expect(after!.locale).toBe('de');

        expect(await journalOf(db, before!.id)).toEqual([
          expect.objectContaining({
            event: 'locale_changed',
            place: 'manage_page',
            ip: IP,
            userAgent: AGENT,
            locale: 'de',
            campaignId: null,
            privacyVersion: null,
            actorId: null,
          }),
        ]);
      });
    });

    it('does nothing and writes nothing when the language is the one it has', async () => {
      await inRolledBackTx(async (db) => {
        const [before] = await subscriptionsOf(db, emailOf.form);
        const outcome = await attemptAs(
          db,
          GUEST(),
          SQL.manageSetLocale,
          manageHash.form,
          'en',
          IP,
          AGENT,
        );

        expect(outcome).toEqual({ ok: true, rows: [{ done: false }] });
        expect(await subscriptionsOf(db, emailOf.form)).toEqual([before]);
        expect(await journalOf(db, before!.id)).toEqual([]);
      });
    });

    it('is changed on a subscription of the account only in the profile: nothing moves here', async () => {
      await inRolledBackTx(async (db) => {
        const [before] = await subscriptionsOf(db, emailOf.account);
        const outcome = await attemptAs(
          db,
          GUEST(),
          SQL.manageSetLocale,
          manageHash.account,
          'de',
          IP,
          AGENT,
        );

        expect(codeOf(outcome)).toBe('NEWSLETTER_LOCALE_NOT_ALLOWED');
        expect(await subscriptionsOf(db, emailOf.account)).toEqual([before]);
      });
    });

    it('is set to a language only: two lower-case letters, never none', async () => {
      await inRolledBackTx(async (db) => {
        for (const locale of ['EN', 'eng', '', 'e1', null]) {
          const outcome = await attemptAs(
            db,
            GUEST(),
            SQL.manageSetLocale,
            manageHash.form,
            locale,
            IP,
            AGENT,
          );
          expect(codeOf(outcome)).toBe('NEWSLETTER_LOCALE_INVALID');
        }
      });
    });
  });

  describe('the unsubscribe', () => {
    it('ends the subscription at once: the time, the reason and a line of the journal', async () => {
      await inRolledBackTx(async (db) => {
        const [before] = await subscriptionsOf(db, emailOf.formPaused);
        const now = await dbNow(db);
        const outcome = await attemptAs(
          db,
          GUEST(),
          SQL.manageUnsubscribe,
          manageHash.formPaused,
          null,
          'manage_page',
          IP,
          AGENT,
        );
        expect(outcome).toEqual({ ok: true, rows: [{ done: true }] });

        const [after] = await subscriptionsOf(db, emailOf.formPaused);
        expect(after).toMatchObject({
          id: before!.id,
          status: 'ended',
          endReason: 'unsubscribed',
          confirmHash: null,
          confirmExpiresAt: null,
        });
        expect(near(after!.endedAt, now)).toBe(true);

        expect(await journalOf(db, before!.id)).toEqual([
          expect.objectContaining({
            event: 'unsubscribed',
            place: 'manage_page',
            ip: IP,
            userAgent: AGENT,
            locale: 'en',
            campaignId: null,
            privacyVersion: null,
            actorId: null,
          }),
        ]);
      });
    });

    it('is the end of the link: the page finds nothing afterwards, and the second try ends nothing', async () => {
      await inRolledBackTx(async (db) => {
        const args = ['manage_page', IP, AGENT] as const;
        const first = await attemptAs(
          db,
          GUEST(),
          SQL.manageUnsubscribe,
          manageHash.form,
          null,
          ...args,
        );
        const second = await attemptAs(
          db,
          GUEST(),
          SQL.manageUnsubscribe,
          manageHash.form,
          null,
          ...args,
        );
        const page = await attemptAs(db, GUEST(), SQL.manageGet, manageHash.form);

        expect(first).toEqual({ ok: true, rows: [{ done: true }] });
        expect(second).toEqual({ ok: true, rows: [{ done: false }] });
        expect(codeOf(page)).toBe(LINK_INVALID);

        const [row] = await subscriptionsOf(db, emailOf.form);
        expect(await journalOf(db, row!.id)).toHaveLength(1);
      });
    });

    it('is frozen once it ended: the address can ask again and gets a request of its own', async () => {
      await inRolledBackTx(async (db) => {
        await attemptAs(
          db,
          GUEST(),
          SQL.manageUnsubscribe,
          manageHash.form,
          null,
          'manage_page',
          IP,
          AGENT,
        );
        const [ended] = await subscriptionsOf(db, emailOf.form);

        const asked = await requestAs(db, GUEST(), requestArgs({ email: emailOf.form }));
        expect(asked).toMatchObject({ ok: true, rows: [{ outcome: 'confirm' }] });

        const rows = await subscriptionsOf(db, emailOf.form);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual(ended);
        expect(rows[1]).toMatchObject({ status: 'pending' });
      });
    });

    it.each(['somewhere', 'form', 'profile', 'admin', 'webhook', 'mail_client', '', null])(
      'is refused a place that is not the page (the button of the mail client has a function of its own): %p',
      async (place) => {
        await inRolledBackTx(async (db) => {
          const [before] = await subscriptionsOf(db, emailOf.form);
          const outcome = await attemptAs(
            db,
            GUEST(),
            SQL.manageUnsubscribe,
            manageHash.form,
            null,
            place,
            IP,
            AGENT,
          );

          expect(codeOf(outcome)).toBe('NEWSLETTER_PLACE_INVALID');
          expect(await subscriptionsOf(db, emailOf.form)).toEqual([before]);
        });
      },
    );

    // the unsubscribe from a mail of a campaign is counted by the campaign (the totals), once it
    // has gone out; an id that is no campaign, or one that never sent, is not counted, and the
    // unsubscribe works all the same
    type CampaignState = 'draft' | 'scheduled' | 'cancelled' | 'sending' | 'finished' | 'stopped';

    async function campaignIn(db: DbSession, state: CampaignState): Promise<number> {
      const manager: Actor = { role: 'ADMIN', userId: fx.manager.id };
      const id = await draftCampaignIn(db, manager);
      if (state === 'draft') return id;

      const edited = `"updatedById" = cartlify.current_actor_id()`;
      await db.as(manager);
      await db.rows(
        `update cartlify.newsletter_campaigns
         set status = 'scheduled', "scheduledAt" = $2::timestamp, ${edited} where id = $1`,
        id,
        utc(DAY),
      );
      if (state === 'scheduled') return id;

      if (state === 'cancelled') {
        await db.rows(
          `update cartlify.newsletter_campaigns
           set status = 'cancelled', "cancelledAt" = $2::timestamp, ${edited} where id = $1`,
          id,
          utc(),
        );
        return id;
      }

      await db.as(SYSTEM);
      await db.rows(
        `update cartlify.newsletter_campaigns
         set status = 'sending', "startedAt" = $2::timestamp,
             "productsSnapshot" = '{"products":[]}'::jsonb, "plannedCount" = 3 where id = $1`,
        id,
        utc(),
      );

      if (state === 'finished') {
        await db.rows(
          `update cartlify.newsletter_campaigns
           set status = 'finished', "finishedAt" = $2::timestamp, "sentCount" = 3 where id = $1`,
          id,
          utc(),
        );
      }

      if (state === 'stopped') {
        await db.as(manager);
        await db.rows(
          `update cartlify.newsletter_campaigns
           set status = 'stopped', "stoppedAt" = $2::timestamp, ${edited} where id = $1`,
          id,
          utc(),
        );
      }

      return id;
    }

    const unsubscribedCount = async (db: Parameters<typeof attemptAs>[0], id: number) => {
      const [row] = await callAs<{ n: number }>(
        db,
        READER,
        'select "unsubscribedCount" as n from cartlify.newsletter_campaigns where id = $1',
        id,
      );
      return row!.n;
    };

    // The campaign counts the unsubscribe, and the line of the journal names it, only for a subscription
    // that has a mail in that campaign (a row of its recipients): the id comes from the address of a
    // link, and a link must not move the totals of a campaign that never mailed the person. Those
    // rows are the owner's to make, so these cases run in a session of the owner
    const manager = (): Actor => ({ role: 'ADMIN', userId: fx.manager.id });
    const idOf = (name: StateName): number => subscriptionIds[STATE_NAMES.indexOf(name)]!;

    it.each(['sending', 'finished', 'stopped'] as const)(
      'is counted by a campaign that is %s, and the line of the journal names it',
      async (state) => {
        await inOwnerTx(async (db) => {
          const campaign = await sentCampaignIn(db, manager(), state);
          await recipientIn(db, campaign, idOf('form'));

          const outcome = await attemptAs(
            db,
            GUEST(),
            SQL.manageUnsubscribe,
            manageHash.form,
            campaign,
            'manage_page',
            IP,
            AGENT,
          );
          expect(outcome).toEqual({ ok: true, rows: [{ done: true }] });

          expect(await unsubscribedCount(db, campaign)).toBe(1);
          const [row] = await subscriptionsOf(db, emailOf.form);
          expect(await journalOf(db, row!.id)).toEqual([
            expect.objectContaining({
              event: 'unsubscribed',
              place: 'manage_page',
              campaignId: campaign,
            }),
          ]);
        });
      },
    );

    it('is counted once, however often the link is used', async () => {
      await inOwnerTx(async (db) => {
        const campaign = await sentCampaignIn(db, manager(), 'sending');
        await recipientIn(db, campaign, idOf('form'));
        const args = [campaign, 'manage_page', IP, AGENT] as const;

        await attemptAs(db, GUEST(), SQL.manageUnsubscribe, manageHash.form, ...args);
        await attemptAs(db, GUEST(), SQL.manageUnsubscribe, manageHash.form, ...args);

        expect(await unsubscribedCount(db, campaign)).toBe(1);
      });
    });

    it('is counted by each campaign for its own subscribers', async () => {
      await inOwnerTx(async (db) => {
        const campaign = await sentCampaignIn(db, manager(), 'sending');
        const other = await sentCampaignIn(db, manager(), 'sending');
        await recipientIn(db, campaign, idOf('form'));
        await recipientIn(db, campaign, idOf('account'));
        await recipientIn(db, other, idOf('formPaused'));

        await attemptAs(
          db,
          GUEST(),
          SQL.manageUnsubscribe,
          manageHash.form,
          campaign,
          'manage_page',
          IP,
          AGENT,
        );
        await attemptAs(
          db,
          GUEST(),
          SQL.manageUnsubscribe,
          manageHash.account,
          campaign,
          'manage_page',
          IP,
          AGENT,
        );
        await attemptAs(
          db,
          GUEST(),
          SQL.manageUnsubscribe,
          manageHash.formPaused,
          other,
          'manage_page',
          IP,
          AGENT,
        );

        expect(await unsubscribedCount(db, campaign)).toBe(2);
        expect(await unsubscribedCount(db, other)).toBe(1);
      });
    });

    // the campaign went out, but its mail was not to this subscription: whoever holds the link cannot
    // raise its totals, and the line of the journal names no campaign
    it.each(['sending', 'finished', 'stopped'] as const)(
      'is not counted by a campaign that is %s and never mailed this subscription: the unsubscribe works',
      async (state) => {
        await inOwnerTx(async (db) => {
          const campaign = await sentCampaignIn(db, manager(), state);
          // it mailed another person, and this one is mailed by another campaign
          await recipientIn(db, campaign, idOf('account'));
          const elsewhere = await sentCampaignIn(db, manager(), state);
          await recipientIn(db, elsewhere, idOf('form'));

          const outcome = await attemptAs(
            db,
            GUEST(),
            SQL.manageUnsubscribe,
            manageHash.form,
            campaign,
            'manage_page',
            IP,
            AGENT,
          );
          expect(outcome).toEqual({ ok: true, rows: [{ done: true }] });

          expect(await unsubscribedCount(db, campaign)).toBe(0);
          expect(await unsubscribedCount(db, elsewhere)).toBe(0);
          const [row] = await subscriptionsOf(db, emailOf.form);
          expect(row).toMatchObject({ status: 'ended' });
          expect(await journalOf(db, row!.id)).toEqual([
            expect.objectContaining({ event: 'unsubscribed', campaignId: null }),
          ]);
        });
      },
    );

    it.each(['draft', 'scheduled', 'cancelled'] as const)(
      'is not counted by a campaign that is %s, it never sent a mail: the unsubscribe works',
      async (state) => {
        await inRolledBackTx(async (db) => {
          const campaign = await campaignIn(db, state);

          const outcome = await attemptAs(
            db,
            GUEST(),
            SQL.manageUnsubscribe,
            manageHash.form,
            campaign,
            'manage_page',
            IP,
            AGENT,
          );
          expect(outcome).toEqual({ ok: true, rows: [{ done: true }] });

          expect(await unsubscribedCount(db, campaign)).toBe(0);
          const [row] = await subscriptionsOf(db, emailOf.form);
          expect(row).toMatchObject({ status: 'ended' });
          expect(await journalOf(db, row!.id)).toEqual([
            expect.objectContaining({ event: 'unsubscribed', campaignId: null }),
          ]);
        });
      },
    );

    it('is not counted by a campaign that does not exist: the unsubscribe works, the line names none', async () => {
      await inRolledBackTx(async (db) => {
        const outcome = await attemptAs(
          db,
          GUEST(),
          SQL.manageUnsubscribe,
          manageHash.form,
          2_000_000_000,
          'manage_page',
          IP,
          AGENT,
        );
        expect(outcome).toEqual({ ok: true, rows: [{ done: true }] });

        const [row] = await subscriptionsOf(db, emailOf.form);
        expect(row).toMatchObject({ status: 'ended' });
        expect(await journalOf(db, row!.id)).toEqual([
          expect.objectContaining({ event: 'unsubscribed', campaignId: null }),
        ]);
      });
    });

    it('counts nothing when no campaign is named', async () => {
      await inRolledBackTx(async (db) => {
        const campaign = await campaignIn(db, 'sending');
        await attemptAs(
          db,
          GUEST(),
          SQL.manageUnsubscribe,
          manageHash.form,
          null,
          'manage_page',
          IP,
          AGENT,
        );

        expect(await unsubscribedCount(db, campaign)).toBe(0);
      });
    });
  });

  describe('the resume after a complaint', () => {
    it.each(['form', 'account'] as const)(
      'puts a %s subscription back in force and writes it down',
      async (kind) => {
        const name = kind === 'form' ? 'formPaused' : 'accountPaused';

        await inRolledBackTx(async (db) => {
          const [before] = await subscriptionsOf(db, emailOf[name]);
          const outcome = await attemptAs(
            db,
            GUEST(),
            SQL.manageResume,
            manageHash[name],
            IP,
            AGENT,
          );
          expect(outcome).toEqual({ ok: true, rows: [{ done: true }] });

          const [after] = await subscriptionsOf(db, emailOf[name]);
          expect({ ...after, status: null, updatedAt: null }).toEqual({
            ...before,
            status: null,
            updatedAt: null,
          });
          expect(after!.status).toBe('active');

          expect(await journalOf(db, before!.id)).toEqual([
            expect.objectContaining({
              event: 'restored',
              place: 'manage_page',
              ip: IP,
              userAgent: AGENT,
              privacyVersion: null,
              actorId: null,
            }),
          ]);
        });
      },
    );

    it('does nothing for a subscription that is not paused', async () => {
      await inRolledBackTx(async (db) => {
        const [before] = await subscriptionsOf(db, emailOf.form);
        const outcome = await attemptAs(db, GUEST(), SQL.manageResume, manageHash.form, IP, AGENT);

        expect(outcome).toEqual({ ok: true, rows: [{ done: false }] });
        expect(await subscriptionsOf(db, emailOf.form)).toEqual([before]);
        expect(await journalOf(db, before!.id)).toEqual([]);
      });
    });
  });

  describe('the export', () => {
    const ISO = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

    it('gives the subscription and its journal, and none of its secrets', async () => {
      await inRolledBackTx(async (db) => {
        const version = await publishPrivacy(db, fx.root.id);
        const args = requestArgs({ locale: 'es' });
        await requestAs(db, GUEST(), args);
        await callAs(db, GUEST(), SQL.confirm, args.confirmHash, IP, AGENT);
        await callAs(
          db,
          GUEST(),
          SQL.manageSetLocale,
          args.manageHash,
          'de',
          '198.51.100.4',
          'other-agent',
        );

        const [row] = await callAs<{ data: Record<string, unknown> }>(
          db,
          GUEST(),
          SQL.manageExport,
          args.manageHash,
        );

        expect(row!.data).toEqual({
          subscriptions: [
            {
              email: args.email,
              source: 'form',
              locale: 'de',
              status: 'active',
              createdAt: ISO,
              confirmedAt: ISO,
              endedAt: null,
              endReason: null,
              events: [
                {
                  event: 'requested',
                  place: 'form',
                  ip: IP,
                  userAgent: AGENT,
                  locale: 'es',
                  campaignId: null,
                  privacyVersion: version,
                  createdAt: ISO,
                },
                {
                  event: 'confirmed',
                  place: 'form',
                  ip: IP,
                  userAgent: AGENT,
                  locale: 'es',
                  campaignId: null,
                  privacyVersion: version,
                  createdAt: ISO,
                },
                {
                  event: 'locale_changed',
                  place: 'manage_page',
                  ip: '198.51.100.4',
                  userAgent: 'other-agent',
                  locale: 'de',
                  campaignId: null,
                  privacyVersion: null,
                  createdAt: ISO,
                },
              ],
            },
          ],
        });

        const text = JSON.stringify(row!.data);
        for (const secret of [args.confirmHash, args.manageHash, args.manageSalt, args.emailHmac]) {
          expect(text).not.toContain(secret);
        }
      });
    });

    it('is the data of that one subscription, not of the others of the address', async () => {
      await inRolledBackTx(async (db) => {
        const [row] = await callAs<{
          data: { subscriptions: { source: string; email: string }[] };
        }>(db, GUEST(), SQL.manageExport, manageHash.account);

        expect(row!.data.subscriptions).toEqual([
          expect.objectContaining({ source: 'account', email: emailOf.account }),
        ]);
      });
    });
  });
});

describe('the user of the account', () => {
  // the page opens for a signed-in buyer as for a guest: the link is the key, not the session
  it('is not asked who it is: the same link opens for the owner of the account', async () => {
    const outcome = await inRolledBackTx((db) =>
      attemptAs(db, { role: 'USER', userId: accountUser.id }, SQL.manageGet, manageHash.account),
    );

    expect(outcome).toMatchObject({ ok: true, rows: [{ source: 'account', status: 'active' }] });
  });
});
