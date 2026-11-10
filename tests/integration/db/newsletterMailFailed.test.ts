import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor } from '../../helpers/db.js';
import { uniqueEmail } from '../../helpers/factories.js';
import {
  agoIn,
  eventRow,
  insertRow,
  insertSubscription,
  removeNewsletterFixtures,
  removeSubscriptionRows,
  setupNewsletterFixtures,
  type NewsletterFixtures,
  type SubscriptionOpts,
} from '../../helpers/newsletterDb.js';
import {
  GUEST,
  SQL,
  SYSTEM,
  attemptAs,
  callAs,
  codeOf,
  journalOfAddress,
  requestArgs,
  requestAs,
  subscriptionsOf,
} from '../../helpers/newsletterFns.js';
import { inOwnerTx, type OwnerSession } from '../../helpers/ownerDb.js';

// A mail of the form the provider refused (cartlify.newsletter_request_mail_failed): the form marks
// the address when it decides to mail it, so that it is mailed at most once a day; when the mail did
// not go, the mark is taken back, and only while it is a fresh one (the mark of a mail that went
// long ago is the truth about that mail). Confirmation mails and "you are already subscribed" mails
// have a mark each. The rows are made in a session of the owner of the database that rolls back

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

const KINDS = [
  ['confirm', 'lastConfirmMailAt', 'lastAlreadyMailAt'],
  ['already', 'lastAlreadyMailAt', 'lastConfirmMailAt'],
] as const;

// a subscription whose marks are set to the ages given (minutes ago; null: never mailed)
async function markedIn(
  db: OwnerSession,
  opts: SubscriptionOpts & { confirmAgo?: number | null; alreadyAgo?: number | null } = {},
): Promise<{ id: number; email: string }> {
  const email = opts.email ?? uniqueEmail('failed');
  // the marks are written with the row, a moment of the clock of the database some minutes back (an
  // ended row is frozen, nothing but its time of change moves later)
  const mark = async (minutes: number | null | undefined) =>
    minutes == null ? null : agoIn(db, 0, minutes);
  const id = await insertSubscription(db, {
    status: 'active',
    ...opts,
    email,
    set: {
      lastConfirmMailAt: await mark(opts.confirmAgo),
      lastAlreadyMailAt: await mark(opts.alreadyAgo),
    },
  });

  return { id, email };
}

const failed = (db: OwnerSession, actor: Actor | null, email: string | null, kind: string | null) =>
  attemptAs<{ done: boolean }>(db, actor, SQL.mailFailed, email, kind);

const marksOf = async (db: OwnerSession, email: string) =>
  (await subscriptionsOf(db, email)).map((row) => ({
    id: row.id,
    confirm: row.lastConfirmMailAt,
    already: row.lastAlreadyMailAt,
    status: row.status,
  }));

describe('the mark of a mail that did not go', () => {
  it.each(KINDS)(
    'is taken back for the kind %s, and the other kind keeps its own mark',
    async (kind, mark, other) => {
      await inOwnerTx(async (db) => {
        const { id, email } = await markedIn(db, { confirmAgo: 1, alreadyAgo: 1 });
        const [before] = await subscriptionsOf(db, email);

        expect(await failed(db, GUEST(), email, kind)).toEqual({
          ok: true,
          rows: [{ done: true }],
        });

        const [after] = await subscriptionsOf(db, email);
        expect(after![mark]).toBeNull();
        expect(after![other]).toEqual(before![other]);
        // nothing else of the row moves: the state, the tokens, the language
        expect({ ...after, [mark]: null, updatedAt: null }).toEqual({
          ...before,
          [mark]: null,
          updatedAt: null,
        });
        expect(after!.id).toBe(id);
      });
    },
  );

  it.each([
    ['confirm', 'pending'],
    ['confirm', 'active'],
    ['already', 'active'],
    ['already', 'paused_complaint'],
    ['already', 'pending'],
    ['confirm', 'paused_complaint'],
  ] as const)(
    'is taken back for the kind %s on a subscription that is %s',
    async (kind, status) => {
      await inOwnerTx(async (db) => {
        const { email } = await markedIn(db, { status, confirmAgo: 2, alreadyAgo: 2 });

        expect(await failed(db, GUEST(), email, kind)).toEqual({
          ok: true,
          rows: [{ done: true }],
        });
      });
    },
  );

  it.each(KINDS.map(([kind]) => [kind] as const))(
    'is taken back for the mark of %s only while it is a fresh one',
    async (kind) => {
      const answers = await inOwnerTx(async (db) => {
        const fresh = await markedIn(db, { confirmAgo: 4, alreadyAgo: 4 });
        const stale = await markedIn(db, { confirmAgo: 6, alreadyAgo: 6 });
        const old = await markedIn(db, { confirmAgo: 60 * 24, alreadyAgo: 60 * 24 });
        const never = await markedIn(db, { confirmAgo: null, alreadyAgo: null });

        return {
          fresh: await failed(db, GUEST(), fresh.email, kind),
          stale: await failed(db, GUEST(), stale.email, kind),
          old: await failed(db, GUEST(), old.email, kind),
          never: await failed(db, GUEST(), never.email, kind),
          staleRows: await marksOf(db, stale.email),
          oldRows: await marksOf(db, old.email),
        };
      });

      expect(answers.fresh).toEqual({ ok: true, rows: [{ done: true }] });
      for (const answer of [answers.stale, answers.old, answers.never]) {
        expect(answer).toEqual({ ok: true, rows: [{ done: false }] });
      }
      // a mark of a mail that went stays
      for (const row of [...answers.staleRows, ...answers.oldRows]) {
        expect(row.confirm).not.toBeNull();
        expect(row.already).not.toBeNull();
      }
    },
  );

  it.each(KINDS)(
    'is not taken back by a mark of the other kind (%s)',
    async (kind, mark, other) => {
      await inOwnerTx(async (db) => {
        // only the other kind of mail was marked a minute ago: this kind has nothing to take back
        const { email } = await markedIn(db, {
          confirmAgo: mark === 'lastConfirmMailAt' ? null : 1,
          alreadyAgo: mark === 'lastAlreadyMailAt' ? null : 1,
        });
        const [before] = await subscriptionsOf(db, email);

        expect(await failed(db, GUEST(), email, kind)).toEqual({
          ok: true,
          rows: [{ done: false }],
        });
        expect(await subscriptionsOf(db, email)).toEqual([before]);
        expect(before![other]).not.toBeNull();
      });
    },
  );

  it.each(['ended', 'stopped_bounce'] as const)(
    'leaves a subscription that is %s as it is: it is not a live one',
    async (status) => {
      await inOwnerTx(async (db) => {
        const { email } = await markedIn(db, { status, confirmAgo: 1, alreadyAgo: 1 });
        const before = await subscriptionsOf(db, email);

        for (const [kind] of KINDS) {
          expect(await failed(db, GUEST(), email, kind)).toEqual({
            ok: true,
            rows: [{ done: false }],
          });
        }
        expect(await subscriptionsOf(db, email)).toEqual(before);
      });
    },
  );

  it('takes back the mark of the live subscription of the address, not of an ended one beside it', async () => {
    await inOwnerTx(async (db) => {
      const email = uniqueEmail('beside');
      const old = await markedIn(db, { email, status: 'ended', confirmAgo: 1, alreadyAgo: 1 });
      await markedIn(db, { email, status: 'active', confirmAgo: 1, alreadyAgo: 1 });

      expect(await failed(db, GUEST(), email, 'confirm')).toEqual({
        ok: true,
        rows: [{ done: true }],
      });

      const rows = await marksOf(db, email);
      expect(rows.find((row) => row.id === old.id)!.confirm).not.toBeNull();
      expect(rows.find((row) => row.status === 'active')!.confirm).toBeNull();
    });
  });

  it('is of the address given and of no other', async () => {
    await inOwnerTx(async (db) => {
      const one = await markedIn(db, { confirmAgo: 1, alreadyAgo: 1 });
      const two = await markedIn(db, { confirmAgo: 1, alreadyAgo: 1 });

      await failed(db, GUEST(), one.email, 'confirm');

      expect((await marksOf(db, two.email))[0]!.confirm).not.toBeNull();
    });
  });

  it('finds the address however it is written: lower case, no spaces around it', async () => {
    await inOwnerTx(async (db) => {
      const { email } = await markedIn(db, { confirmAgo: 1 });

      const outcome = await failed(db, GUEST(), `  ${email.toUpperCase()} `, 'confirm');

      expect(outcome).toEqual({ ok: true, rows: [{ done: true }] });
    });
  });

  it.each([
    ['an address nobody has', () => uniqueEmail('nobody')],
    ['no address', () => null],
    ['an empty address', () => ''],
  ])('answers false for %s, and changes nothing', async (_what, email) => {
    await inOwnerTx(async (db) => {
      const { email: other } = await markedIn(db, { confirmAgo: 1 });
      const before = await subscriptionsOf(db, other);

      expect(await failed(db, GUEST(), email(), 'confirm')).toEqual({
        ok: true,
        rows: [{ done: false }],
      });
      expect(await subscriptionsOf(db, other)).toEqual(before);
    });
  });

  it.each([['other'], ['CONFIRM'], [''], ['confirm '], [null]])(
    'refuses the kind %p of a mail, and changes nothing',
    async (kind) => {
      await inOwnerTx(async (db) => {
        const { email } = await markedIn(db, { confirmAgo: 1, alreadyAgo: 1 });
        const before = await subscriptionsOf(db, email);

        expect(codeOf(await failed(db, GUEST(), email, kind))).toBe('NEWSLETTER_MAIL_KIND_INVALID');
        expect(await subscriptionsOf(db, email)).toEqual(before);
      });
    },
  );

  it('writes no line of the journal: the request stays what it was', async () => {
    await inOwnerTx(async (db) => {
      const { id, email } = await markedIn(db, { confirmAgo: 1 });
      await insertRow(db, 'newsletter_subscription_events', eventRow(id));
      const before = await journalOfAddress(db, email);

      await failed(db, GUEST(), email, 'confirm');

      expect(await journalOfAddress(db, email)).toEqual(before);
    });
  });

  // every context the form is reached from: the guest, a signed-in buyer, the staff, the system
  it.each([
    ['a guest', GUEST],
    ['no context', () => null],
    ['a buyer', () => ({ role: 'USER', userId: fx.stranger.id }) as Actor],
    ['an admin', () => ({ role: 'ADMIN', userId: fx.plainAdmin.id }) as Actor],
    ['a manager', () => ({ role: 'ADMIN', userId: fx.manager.id }) as Actor],
    ['root', () => ({ role: 'ROOT', userId: fx.root.id }) as Actor],
    ['the system', () => SYSTEM],
  ])('works in the context of %s', async (_who, actor) => {
    await inOwnerTx(async (db) => {
      const { email } = await markedIn(db, { confirmAgo: 1 });

      expect(await failed(db, actor(), email, 'confirm')).toEqual({
        ok: true,
        rows: [{ done: true }],
      });
    });
  });
});

describe('the form after a mail that did not go', () => {
  it('mails a request that waits again at once, as it was never mailed', async () => {
    await inOwnerTx(async (db) => {
      const args = requestArgs();
      const first = await requestAs(db, GUEST(), args);
      expect(first).toMatchObject({ ok: true, rows: [{ outcome: 'confirm' }] });

      // the same day, before the failure: nothing is mailed
      const early = await requestAs(
        db,
        GUEST(),
        requestArgs({ email: args.email, emailHmac: args.emailHmac }),
      );
      expect(early).toMatchObject({ ok: true, rows: [{ outcome: 'nothing' }] });

      await failed(db, GUEST(), args.email, 'confirm');

      const again = await requestAs(
        db,
        GUEST(),
        requestArgs({ email: args.email, emailHmac: args.emailHmac }),
      );
      expect(again).toMatchObject({ ok: true, rows: [{ outcome: 'confirm' }] });
    });
  });

  it('mails a subscriber "you are already subscribed" again at once, as it was never mailed', async () => {
    await inOwnerTx(async (db) => {
      const email = uniqueEmail('again');
      const args = requestArgs({ email });
      await insertSubscription(db, {
        status: 'active',
        email,
        locale: 'en',
        set: { emailHmac: args.emailHmac },
      });

      expect(await requestAs(db, GUEST(), args)).toMatchObject({
        ok: true,
        rows: [{ outcome: 'already' }],
      });
      expect(await requestAs(db, GUEST(), args)).toMatchObject({
        ok: true,
        rows: [{ outcome: 'nothing' }],
      });

      await failed(db, GUEST(), email, 'already');

      expect(await requestAs(db, GUEST(), args)).toMatchObject({
        ok: true,
        rows: [{ outcome: 'already' }],
      });
    });
  });

  it('does not take the day back for a mail of the other kind', async () => {
    await inOwnerTx(async (db) => {
      const email = uniqueEmail('kinds');
      const args = requestArgs({ email });
      await insertSubscription(db, {
        status: 'active',
        email,
        locale: 'en',
        set: { emailHmac: args.emailHmac },
      });
      await requestAs(db, GUEST(), args);

      // the mail that failed was a confirmation, which this address never had
      await failed(db, GUEST(), email, 'confirm');

      expect(await requestAs(db, GUEST(), args)).toMatchObject({
        ok: true,
        rows: [{ outcome: 'nothing' }],
      });
    });
  });
});

describe('the role of the app', () => {
  const made: number[] = [];

  afterAll(async () => {
    await removeSubscriptionRows(made);
  });

  it('runs it for a guest on a row the form made a minute ago', async () => {
    const email = uniqueEmail('app');
    const id = await inOwnerTx(
      async (db) => {
        const { id } = await markedIn(db, { status: 'pending', email, confirmAgo: 1 });
        return id;
      },
      { commit: true },
    );
    made.push(id);

    const outcome = await inRolledBackTx((db) =>
      callAs<{ done: boolean }>(db, GUEST(), SQL.mailFailed, email, 'confirm'),
    );

    expect(outcome).toEqual([{ done: true }]);
  });
});
