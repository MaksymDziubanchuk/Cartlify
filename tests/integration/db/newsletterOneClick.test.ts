import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor } from '../../helpers/db.js';
import { createUser, uniqueEmail, type TestUser } from '../../helpers/factories.js';
import {
  campaignIn,
  eventRow,
  hex64,
  insertRow,
  insertSubscription,
  recipientIn,
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
  READER,
  SQL,
  SYSTEM,
  attemptAs,
  callAs,
  codeOf,
  dbNow,
  journalOf,
  near,
  subscriptionsOf,
} from '../../helpers/newsletterFns.js';
import { inOwnerTx } from '../../helpers/ownerDb.js';

// The button of the mail client (RFC 8058), cartlify.newsletter_unsubscribe_one_click: it finds the
// subscription by the hash of its own token, the token of the unsubscribe, which is not the token of
// the page of management, and does the one thing the button is for: it ends the subscription in
// force (place mail_client) and counts it into the campaign whose mail it was. It opens nothing
// else. The rows are committed by the owner, every statement of a test runs in a transaction that
// rolls back

let fx: NewsletterFixtures;
const subscriptionIds: number[] = [];

type StateName =
  'form' | 'formPaused' | 'account' | 'accountPaused' | 'pending' | 'ended' | 'stopped';

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

// the two tokens of each row are two different hashes
const unsubscribeHash = Object.fromEntries(STATE_NAMES.map((name) => [name, hex64()])) as Record<
  StateName,
  string
>;
const manageHash = Object.fromEntries(STATE_NAMES.map((name) => [name, hex64()])) as Record<
  StateName,
  string
>;
const emailOf = {} as Record<StateName, string>;
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

        const id = await insertSubscription(db, {
          ...STATES[name],
          email,
          userId: isAccount ? user.id : undefined,
          set: { manageHash: manageHash[name], unsubscribeHash: unsubscribeHash[name] },
        });
        subscriptionIds.push(id);
        // a line of the journal, to see it stay
        await insertRow(db, 'newsletter_subscription_events', eventRow(id));
      }
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

const LINK_INVALID = 'NEWSLETTER_LINK_INVALID';
const MANAGER = (): Actor => ({ role: 'ADMIN', userId: fx.manager.id });

// everybody who can press a button of a mail: the answer does not depend on who asks
const ACTORS: [string, () => Actor | null][] = [
  ['a guest', GUEST],
  ['no context', () => null],
  ['a buyer', () => ({ role: 'USER', userId: fx.stranger.id })],
  ['an admin', () => ({ role: 'ADMIN', userId: fx.plainAdmin.id })],
  ['a manager', MANAGER],
  ['root', () => ({ role: 'ROOT', userId: fx.root.id })],
  ['the system', () => SYSTEM],
];

type Session = Parameters<typeof attemptAs>[0];

// the row of a subscription of the arrangement
const idOf = (name: StateName): number => subscriptionIds[STATE_NAMES.indexOf(name)]!;

const press = (db: Session, actor: Actor | null, hash: string | null, campaign: number | null) =>
  attemptAs<{ done: boolean }>(db, actor, SQL.oneClick, hash, campaign, IP, AGENT);

describe('the one-click unsubscribe', () => {
  it.each([
    ['form', 'true'],
    ['formPaused', 'true'],
    ['account', 'true'],
    ['accountPaused', 'true'],
    // a link that holds no subscription in force has nothing left to end
    ['pending', 'false'],
    ['ended', 'false'],
    ['stopped', 'false'],
  ] as const)('answers the token of: %s', async (state, expected) => {
    const outcome = await inRolledBackTx((db) => press(db, GUEST(), unsubscribeHash[state], null));

    expect(outcome.ok && String(outcome.rows[0]!.done)).toBe(expected);
  });

  it('refuses a token nobody was given', async () => {
    const outcome = await inRolledBackTx((db) => press(db, GUEST(), hex64(), null));

    expect(codeOf(outcome)).toBe(LINK_INVALID);
  });

  it.each([
    ['an empty token', ''],
    ['spaces', '  '],
    ['no token', null],
  ])('is no link: %s', async (_what, hash) => {
    const outcome = await inRolledBackTx((db) => press(db, GUEST(), hash, null));

    expect(codeOf(outcome)).toBe(LINK_INVALID);
  });

  it.each(STATE_NAMES)(
    'does not take the token of the page of management of the same row: %s',
    async (state) => {
      await inRolledBackTx(async (db) => {
        const before = await subscriptionsOf(db, emailOf[state]);
        const outcome = await press(db, GUEST(), manageHash[state], null);

        expect(codeOf(outcome)).toBe(LINK_INVALID);
        expect(await subscriptionsOf(db, emailOf[state])).toEqual(before);
      });
    },
  );

  it('is not the key of the page of management: the token of the unsubscribe opens none of its steps', async () => {
    await inRolledBackTx(async (db) => {
      const hash = unsubscribeHash.form;
      const args: [string, unknown[]][] = [
        [SQL.manageGet, [hash]],
        [SQL.manageSetLocale, [hash, 'de', IP, AGENT]],
        [SQL.manageUnsubscribe, [hash, null, 'manage_page', IP, AGENT]],
        [SQL.manageResume, [hash, IP, AGENT]],
        [SQL.manageExport, [hash]],
      ];

      for (const [sql, values] of args) {
        expect(codeOf(await attemptAs(db, GUEST(), sql, ...values))).toBe(LINK_INVALID);
      }
    });
  });

  it.each(ACTORS)('ends the subscription for %s who holds the token', async (_who, actor) => {
    await inRolledBackTx(async (db) => {
      const outcome = await press(db, actor(), unsubscribeHash.form, null);

      expect(outcome).toEqual({ ok: true, rows: [{ done: true }] });
    });
  });

  it('ends the subscription at once: the time, the reason, the mail client as the place', async () => {
    await inRolledBackTx(async (db) => {
      const [before] = await subscriptionsOf(db, emailOf.formPaused);
      const now = await dbNow(db);

      const outcome = await press(db, GUEST(), unsubscribeHash.formPaused, null);
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
      // the tokens and the rest of the row stay as they were
      expect({
        ...after,
        status: null,
        endedAt: null,
        endReason: null,
        updatedAt: null,
      }).toEqual({ ...before, status: null, endedAt: null, endReason: null, updatedAt: null });

      expect(await journalOf(db, before!.id)).toEqual([
        expect.objectContaining({ event: 'requested', place: 'form' }),
        expect.objectContaining({
          event: 'unsubscribed',
          place: 'mail_client',
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

  it('leaves the other subscriptions as they are', async () => {
    await inRolledBackTx(async (db) => {
      const others = STATE_NAMES.filter((state) => state !== 'form');
      const read = async () => {
        const rows = [];
        for (const state of others) rows.push(await subscriptionsOf(db, emailOf[state]));
        return rows;
      };
      const before = await read();

      await press(db, GUEST(), unsubscribeHash.form, null);

      expect(await read()).toEqual(before);
    });
  });

  it('is the end of the link: the second press ends nothing and writes nothing', async () => {
    await inRolledBackTx(async (db) => {
      const first = await press(db, GUEST(), unsubscribeHash.form, null);
      const second = await press(db, GUEST(), unsubscribeHash.form, null);

      expect(first).toEqual({ ok: true, rows: [{ done: true }] });
      expect(second).toEqual({ ok: true, rows: [{ done: false }] });

      const [row] = await subscriptionsOf(db, emailOf.form);
      expect(await journalOf(db, row!.id)).toHaveLength(2);
    });
  });

  it('is also the end of the page of management: its link finds nothing afterwards', async () => {
    await inRolledBackTx(async (db) => {
      await press(db, GUEST(), unsubscribeHash.form, null);

      const page = await attemptAs(db, GUEST(), SQL.manageGet, manageHash.form);
      expect(codeOf(page)).toBe(LINK_INVALID);
    });
  });

  it('leaves a request that waits as it is: no line, no end', async () => {
    await inRolledBackTx(async (db) => {
      const [before] = await subscriptionsOf(db, emailOf.pending);

      await press(db, GUEST(), unsubscribeHash.pending, null);

      expect(await subscriptionsOf(db, emailOf.pending)).toEqual([before]);
      expect(await journalOf(db, before!.id)).toHaveLength(1);
    });
  });

  // The campaign counts the unsubscribe, and the line of the journal names it, only for a subscription
  // that has a mail in that campaign (a row of its recipients): the id comes from the address of a link,
  // and a link must not move the totals of a campaign that never mailed the person
  describe('the count of the campaign whose mail it was', () => {
    const unsubscribedCount = async (db: Session, id: number) => {
      const [row] = await callAs<{ n: number }>(
        db,
        READER,
        'select "unsubscribedCount" as n from cartlify.newsletter_campaigns where id = $1',
        id,
      );
      return row!.n;
    };

    it.each(['sending', 'finished', 'stopped'] as const)(
      'is counted by a campaign that is %s, and the line of the journal names it',
      async (state) => {
        await inOwnerTx(async (db) => {
          const campaign = await campaignIn(db, MANAGER(), state);
          await recipientIn(db, campaign, idOf('form'));

          const outcome = await press(db, GUEST(), unsubscribeHash.form, campaign);
          expect(outcome).toEqual({ ok: true, rows: [{ done: true }] });

          expect(await unsubscribedCount(db, campaign)).toBe(1);
          const [row] = await subscriptionsOf(db, emailOf.form);
          expect(await journalOf(db, row!.id)).toEqual([
            expect.objectContaining({ event: 'requested' }),
            expect.objectContaining({
              event: 'unsubscribed',
              place: 'mail_client',
              campaignId: campaign,
            }),
          ]);
        });
      },
    );

    it('is counted once, however often the button is pressed', async () => {
      await inOwnerTx(async (db) => {
        const campaign = await campaignIn(db, MANAGER(), 'sending');
        await recipientIn(db, campaign, idOf('form'));

        await press(db, GUEST(), unsubscribeHash.form, campaign);
        await press(db, GUEST(), unsubscribeHash.form, campaign);

        expect(await unsubscribedCount(db, campaign)).toBe(1);
      });
    });

    it('is counted by each campaign for its own subscribers', async () => {
      await inOwnerTx(async (db) => {
        const campaign = await campaignIn(db, MANAGER(), 'sending');
        const other = await campaignIn(db, MANAGER(), 'sending');
        await recipientIn(db, campaign, idOf('form'));
        await recipientIn(db, campaign, idOf('account'));
        await recipientIn(db, other, idOf('formPaused'));

        await press(db, GUEST(), unsubscribeHash.form, campaign);
        await press(db, GUEST(), unsubscribeHash.account, campaign);
        await press(db, GUEST(), unsubscribeHash.formPaused, other);

        expect(await unsubscribedCount(db, campaign)).toBe(2);
        expect(await unsubscribedCount(db, other)).toBe(1);
      });
    });

    // the campaign went out, but its mail was not to this subscription: whoever holds the token (or
    // guesses a campaign id) cannot raise its totals, and the line of the journal names no campaign
    it.each(['sending', 'finished', 'stopped'] as const)(
      'is not counted by a campaign that is %s and never mailed this subscription: the unsubscribe works',
      async (state) => {
        await inOwnerTx(async (db) => {
          const campaign = await campaignIn(db, MANAGER(), state);
          // it mailed another person, and this one is mailed by another campaign
          await recipientIn(db, campaign, idOf('account'));
          const elsewhere = await campaignIn(db, MANAGER(), state);
          await recipientIn(db, elsewhere, idOf('form'));

          const outcome = await press(db, GUEST(), unsubscribeHash.form, campaign);
          expect(outcome).toEqual({ ok: true, rows: [{ done: true }] });

          expect(await unsubscribedCount(db, campaign)).toBe(0);
          expect(await unsubscribedCount(db, elsewhere)).toBe(0);
          const [row] = await subscriptionsOf(db, emailOf.form);
          expect(row).toMatchObject({ status: 'ended' });
          expect(await journalOf(db, row!.id)).toEqual([
            expect.objectContaining({ event: 'requested' }),
            expect.objectContaining({ event: 'unsubscribed', campaignId: null }),
          ]);
        });
      },
    );

    it('counts nothing in the campaign named in the address when another campaign mailed the subscription', async () => {
      await inOwnerTx(async (db) => {
        const mailed = await campaignIn(db, MANAGER(), 'sending');
        const named = await campaignIn(db, MANAGER(), 'sending');
        await recipientIn(db, mailed, idOf('form'));

        await press(db, GUEST(), unsubscribeHash.form, named);

        expect(await unsubscribedCount(db, named)).toBe(0);
        expect(await unsubscribedCount(db, mailed)).toBe(0);
      });
    });

    it.each(['scheduled', 'cancelled'] as const)(
      'is not counted by a campaign that is %s, it never sent a mail: the unsubscribe works',
      async (state) => {
        await inOwnerTx(async (db) => {
          const campaign = await campaignIn(db, MANAGER(), state);

          const outcome = await press(db, GUEST(), unsubscribeHash.form, campaign);
          expect(outcome).toEqual({ ok: true, rows: [{ done: true }] });

          expect(await unsubscribedCount(db, campaign)).toBe(0);
          const [row] = await subscriptionsOf(db, emailOf.form);
          expect(row).toMatchObject({ status: 'ended' });
          expect(await journalOf(db, row!.id)).toEqual([
            expect.objectContaining({ event: 'requested' }),
            expect.objectContaining({ event: 'unsubscribed', campaignId: null }),
          ]);
        });
      },
    );

    it('is not counted by a campaign that does not exist: the unsubscribe works, the line names none', async () => {
      await inRolledBackTx(async (db) => {
        const outcome = await press(db, GUEST(), unsubscribeHash.form, 2_000_000_000);
        expect(outcome).toEqual({ ok: true, rows: [{ done: true }] });

        const [row] = await subscriptionsOf(db, emailOf.form);
        expect(row).toMatchObject({ status: 'ended' });
        expect(await journalOf(db, row!.id)).toEqual([
          expect.objectContaining({ event: 'requested' }),
          expect.objectContaining({ event: 'unsubscribed', campaignId: null }),
        ]);
      });
    });

    it('counts nothing when no campaign is named', async () => {
      await inOwnerTx(async (db) => {
        const campaign = await campaignIn(db, MANAGER(), 'sending');
        await press(db, GUEST(), unsubscribeHash.form, null);

        expect(await unsubscribedCount(db, campaign)).toBe(0);
      });
    });

    it('counts nothing for a press that ended nothing', async () => {
      await inOwnerTx(async (db) => {
        const campaign = await campaignIn(db, MANAGER(), 'sending');
        await press(db, GUEST(), unsubscribeHash.ended, campaign);
        await press(db, GUEST(), unsubscribeHash.stopped, campaign);
        await press(db, GUEST(), unsubscribeHash.pending, campaign);

        expect(await unsubscribedCount(db, campaign)).toBe(0);
      });
    });
  });
});

describe('the unsubscribe of the page of management', () => {
  it('is not the button of the mail client: the place mail_client is refused there', async () => {
    await inRolledBackTx(async (db) => {
      const [before] = await subscriptionsOf(db, emailOf.form);
      const outcome = await attemptAs(
        db,
        GUEST(),
        SQL.manageUnsubscribe,
        manageHash.form,
        null,
        'mail_client',
        IP,
        AGENT,
      );

      expect(codeOf(outcome)).toBe('NEWSLETTER_PLACE_INVALID');
      expect(await subscriptionsOf(db, emailOf.form)).toEqual([before]);
    });
  });

  it('does not take the token of the unsubscribe either', async () => {
    await inRolledBackTx(async (db) => {
      const outcome = await attemptAs(
        db,
        GUEST(),
        SQL.manageUnsubscribe,
        unsubscribeHash.form,
        null,
        'manage_page',
        IP,
        AGENT,
      );

      expect(codeOf(outcome)).toBe(LINK_INVALID);
    });
  });
});
