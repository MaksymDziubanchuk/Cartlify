import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inCommittedTx, inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { createUser, uniqueEmail, type TestUser } from '../../helpers/factories.js';
import {
  blockRow,
  hex64,
  insertRow,
  insertSubscription,
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
  attemptAs,
  callAs,
  codeOf,
  dbNow,
  journalOf,
  journalOfAddress,
  near,
  publishPrivacy,
  requestArgs,
  requestAs,
  subscriptionsOf,
  type RequestResult,
} from '../../helpers/newsletterFns.js';
import { inOwnerTx } from '../../helpers/ownerDb.js';

// cartlify.newsletter_request: the form of the public page, for a guest or for an account asking
// about an address that is not its own. It decides what the server must mail (a confirmation, "you
// are already subscribed", nothing) and answers the same whoever asks (the server turns every
// outcome into one public answer). Each state of an address is a case: the rows are committed by
// the owner, every statement of a test runs in a transaction that rolls back

let fx: NewsletterFixtures;
let accountUser: TestUser;
let pausedUser: TestUser;
const subscriptionIds: number[] = [];
const blockedHmacs: string[] = [];

type Outcome = 'confirm' | 'already' | 'nothing';

type Case = {
  name: string;
  // 'account' and 'pausedAccount' take the address of an account made for the case
  address?: 'account' | 'pausedAccount';
  rows: Omit<SubscriptionOpts, 'email' | 'userId'>[];
  blocked?: boolean;
  outcome: Outcome;
  // what the request does to the rows: nothing, mails "already" (stamps it), reissues the link of
  // the request that waits, or makes a request of its own beside what stays
  effect: 'none' | 'already' | 'reissue' | 'create';
  // the language the answer carries: that of the live subscription, or of the request
  locale?: string | null;
};

const ACCOUNT = { source: 'account' as const };
const AN_HOUR_AGO = () => utc(-3_600_000);
const TWO_DAYS_AGO = () => utc(-2 * DAY);

const CASES: Case[] = [
  {
    name: 'a blocked address that has no subscription',
    blocked: true,
    rows: [],
    outcome: 'nothing',
    effect: 'none',
  },
  {
    name: 'a blocked address with a subscription of the form in force',
    blocked: true,
    rows: [{ status: 'active', locale: 'es' }],
    outcome: 'nothing',
    effect: 'none',
  },
  {
    name: 'a blocked address whose request waits',
    blocked: true,
    rows: [{ status: 'pending', set: { lastConfirmMailAt: TWO_DAYS_AGO() } }],
    outcome: 'nothing',
    effect: 'none',
  },
  {
    name: 'a subscription of the account in force',
    address: 'account',
    rows: [{ ...ACCOUNT, status: 'active', locale: 'es' }],
    outcome: 'nothing',
    effect: 'none',
  },
  {
    name: 'a subscription of the account paused by a complaint',
    address: 'pausedAccount',
    rows: [{ ...ACCOUNT, status: 'paused_complaint', locale: 'es' }],
    outcome: 'nothing',
    effect: 'none',
  },
  {
    name: 'a subscription of the form in force, "already" not mailed yet',
    rows: [{ status: 'active', locale: 'es' }],
    outcome: 'already',
    effect: 'already',
    locale: 'es',
  },
  {
    name: 'a subscription of the form in force with no language',
    rows: [{ status: 'active', locale: null }],
    outcome: 'already',
    effect: 'already',
    locale: null,
  },
  {
    name: 'a subscription of the form in force, "already" mailed an hour ago',
    rows: [{ status: 'active', locale: 'es', set: { lastAlreadyMailAt: AN_HOUR_AGO() } }],
    outcome: 'nothing',
    effect: 'none',
  },
  {
    name: 'a subscription of the form in force, "already" mailed two days ago',
    rows: [{ status: 'active', locale: 'es', set: { lastAlreadyMailAt: TWO_DAYS_AGO() } }],
    outcome: 'already',
    effect: 'already',
    locale: 'es',
  },
  // "at most one mail a day to an address" is one limit for all the mails of this kind: the
  // confirmation and "you are already subscribed" wait for the same day, whichever went last
  {
    name: 'a subscription of the form in force, the confirmation mailed an hour ago',
    rows: [{ status: 'active', locale: 'es', set: { lastConfirmMailAt: AN_HOUR_AGO() } }],
    outcome: 'nothing',
    effect: 'none',
  },
  {
    name: 'a subscription of the form in force, the confirmation mailed two days ago',
    rows: [{ status: 'active', locale: 'es', set: { lastConfirmMailAt: TWO_DAYS_AGO() } }],
    outcome: 'already',
    effect: 'already',
    locale: 'es',
  },
  {
    name: 'a subscription of the form in force, the confirmation an hour ago and "already" two days ago',
    rows: [
      {
        status: 'active',
        locale: 'es',
        set: { lastConfirmMailAt: AN_HOUR_AGO(), lastAlreadyMailAt: TWO_DAYS_AGO() },
      },
    ],
    outcome: 'nothing',
    effect: 'none',
  },
  {
    name: 'a subscription of the form in force, "already" an hour ago and the confirmation two days ago',
    rows: [
      {
        status: 'active',
        locale: 'es',
        set: { lastConfirmMailAt: TWO_DAYS_AGO(), lastAlreadyMailAt: AN_HOUR_AGO() },
      },
    ],
    outcome: 'nothing',
    effect: 'none',
  },
  {
    name: 'a subscription of the form in force, both mails two days ago',
    rows: [
      {
        status: 'active',
        locale: 'es',
        set: { lastConfirmMailAt: utc(-3 * DAY), lastAlreadyMailAt: TWO_DAYS_AGO() },
      },
    ],
    outcome: 'already',
    effect: 'already',
    locale: 'es',
  },
  {
    name: 'a subscription of the form paused by a complaint, the confirmation mailed an hour ago',
    rows: [{ status: 'paused_complaint', locale: 'es', set: { lastConfirmMailAt: AN_HOUR_AGO() } }],
    outcome: 'nothing',
    effect: 'none',
  },
  {
    name: 'a subscription of the form paused by a complaint',
    rows: [{ status: 'paused_complaint', locale: 'es' }],
    outcome: 'already',
    effect: 'already',
    locale: 'es',
  },
  {
    name: 'a request that waits, the confirmation mailed an hour ago',
    rows: [{ status: 'pending', locale: 'es', set: { lastConfirmMailAt: AN_HOUR_AGO() } }],
    outcome: 'nothing',
    effect: 'none',
  },
  {
    name: 'a request that waits, the confirmation mailed two days ago',
    rows: [{ status: 'pending', locale: 'es', set: { lastConfirmMailAt: TWO_DAYS_AGO() } }],
    outcome: 'confirm',
    effect: 'reissue',
    locale: 'de',
  },
  {
    name: 'a request that waits, "already" mailed an hour ago',
    rows: [
      {
        status: 'pending',
        locale: 'es',
        set: { lastConfirmMailAt: TWO_DAYS_AGO(), lastAlreadyMailAt: AN_HOUR_AGO() },
      },
    ],
    outcome: 'nothing',
    effect: 'none',
  },
  {
    name: 'a request that waits, "already" mailed two days ago',
    rows: [
      {
        status: 'pending',
        locale: 'es',
        set: { lastConfirmMailAt: utc(-3 * DAY), lastAlreadyMailAt: TWO_DAYS_AGO() },
      },
    ],
    outcome: 'confirm',
    effect: 'reissue',
    locale: 'de',
  },
  {
    name: 'a request that waits and expired, the confirmation mailed four days ago',
    rows: [
      {
        status: 'pending',
        locale: 'es',
        set: { lastConfirmMailAt: utc(-4 * DAY), confirmExpiresAt: utc(-DAY) },
      },
    ],
    outcome: 'confirm',
    effect: 'reissue',
    locale: 'de',
  },
  {
    name: 'a request that waits with no mail recorded',
    rows: [{ status: 'pending', locale: 'es' }],
    outcome: 'confirm',
    effect: 'reissue',
    locale: 'de',
  },
  {
    name: 'an address that has no row',
    rows: [],
    outcome: 'confirm',
    effect: 'create',
    locale: 'de',
  },
  {
    name: 'an address that only has an ended subscription',
    rows: [{ status: 'ended', locale: 'es' }],
    outcome: 'confirm',
    effect: 'create',
    locale: 'de',
  },
  {
    name: 'an address that only has a subscription stopped by a bounce',
    rows: [{ status: 'stopped_bounce', locale: 'es' }],
    outcome: 'confirm',
    effect: 'create',
    locale: 'de',
  },
];

type Prepared = { email: string; hmac: string };
const prepared = new Map<string, Prepared>();

beforeAll(async () => {
  fx = await setupNewsletterFixtures();
  accountUser = await createUser();
  pausedUser = await createUser();

  await inOwnerTx(
    async (db) => {
      for (const c of CASES) {
        const user = c.address === 'account' ? accountUser : pausedUser;
        const email = c.address ? user.email : uniqueEmail('req');
        const hmac = hex64();

        for (const row of c.rows) {
          subscriptionIds.push(
            await insertSubscription(db, {
              ...row,
              email,
              userId: row.source === 'account' ? user.id : undefined,
            }),
          );
        }

        if (c.blocked) {
          await insertRow(db, 'newsletter_form_blocklist', blockRow({ emailHmac: hmac }));
          blockedHmacs.push(hmac);
        }

        prepared.set(c.name, { email, hmac });
      }
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

// everybody who can reach the form: the answer must not depend on who asks
const ACTORS: [string, () => Actor | null][] = [
  ['a guest', GUEST],
  ['no context', () => null],
  ['a buyer', () => ({ role: 'USER', userId: fx.stranger.id })],
  ['an admin', () => ({ role: 'ADMIN', userId: fx.plainAdmin.id })],
  ['a manager', () => ({ role: 'ADMIN', userId: fx.manager.id })],
  ['root', () => ({ role: 'ROOT', userId: fx.root.id })],
  ['the system', () => ({ role: 'ADMIN' })],
];

async function askAs(db: DbSession, actor: Actor | null, c: Case, set = {}) {
  const { email, hmac } = prepared.get(c.name)!;
  const args = requestArgs({ email, emailHmac: hmac, locale: 'de', ...set });
  const outcome = await requestAs(db, actor, args);

  if (!outcome.ok) throw new Error(`the request was refused: ${codeOf(outcome)}`);

  return { args, answer: outcome.rows[0] as RequestResult };
}

describe.each(CASES)('the request on $name', (c) => {
  it.each(ACTORS)('is answered the same to %s', async (_who, actor) => {
    await inRolledBackTx(async (db) => {
      const { email } = prepared.get(c.name)!;
      const before = await subscriptionsOf(db, email);
      const linesBefore = await journalOfAddress(db, email);
      const now = await dbNow(db);

      const { args, answer } = await askAs(db, actor(), c);

      const live = before.find((row) =>
        ['pending', 'active', 'paused_complaint'].includes(row.status),
      );
      const expectedSalt =
        c.effect === 'create' ? args.manageSalt : c.outcome === 'nothing' ? null : live!.manageSalt;
      const expectedLocale = c.outcome === 'nothing' ? null : c.locale;

      expect(answer).toEqual({
        outcome: c.outcome,
        locale: expectedLocale,
        manage_salt: expectedSalt,
      });

      const after = await subscriptionsOf(db, email);
      const lines = await journalOfAddress(db, email);

      if (c.effect === 'none') {
        // a refusal to mail leaves no trace: not a row, not a stamp, not a line of the journal
        expect(after).toEqual(before);
        expect(lines).toEqual(linesBefore);
        return;
      }

      if (c.effect === 'already') {
        expect(after).toHaveLength(before.length);
        const changed = after.find((row) => row.id === live!.id)!;
        expect(near(changed.lastAlreadyMailAt, now)).toBe(true);
        // the stamp is the only change: the state and the tokens stay, and so do the other rows
        expect({ ...changed, lastAlreadyMailAt: null, updatedAt: null }).toEqual({
          ...live,
          lastAlreadyMailAt: null,
          updatedAt: null,
        });
        expect(after.filter((row) => row.id !== live!.id)).toEqual(
          before.filter((row) => row.id !== live!.id),
        );
        expect(lines).toEqual(linesBefore);
        return;
      }

      if (c.effect === 'reissue') {
        expect(after).toHaveLength(before.length);
        const row = after.find((r) => r.id === live!.id)!;
        // the new link, three days from now, the language of this request; the rest stays
        expect(row.confirmHash).toBe(args.confirmHash);
        expect(row.confirmHash).not.toBe(live!.confirmHash);
        expect(near(row.confirmExpiresAt, new Date(now.getTime() + 3 * DAY))).toBe(true);
        expect(near(row.lastConfirmMailAt, now)).toBe(true);
        expect(row.locale).toBe('de');
        expect({
          ...row,
          confirmHash: null,
          confirmExpiresAt: null,
          lastConfirmMailAt: null,
          locale: null,
          updatedAt: null,
        }).toEqual({
          ...live,
          confirmHash: null,
          confirmExpiresAt: null,
          lastConfirmMailAt: null,
          locale: null,
          updatedAt: null,
        });
        expect(lines.slice(0, linesBefore.length)).toEqual(linesBefore);
        expect(lines.slice(linesBefore.length)).toEqual([
          expect.objectContaining({
            subscriptionId: live!.id,
            event: 'requested',
            place: 'form',
            ip: IP,
            userAgent: AGENT,
            locale: 'de',
            campaignId: null,
            actorId: null,
          }),
        ]);
        return;
      }

      // create: the rows that were stay as they were, a request of its own comes beside them
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after).toHaveLength(before.length + 1);
      const created = after[before.length]!;
      expect(created).toMatchObject({
        email,
        emailHmac: args.emailHmac,
        userId: null,
        source: 'form',
        locale: 'de',
        status: 'pending',
        confirmHash: args.confirmHash,
        manageSalt: args.manageSalt,
        manageHash: args.manageHash,
        unsubscribeHash: args.unsubscribeHash,
        endedUserId: null,
        confirmedAt: null,
        endedAt: null,
        endReason: null,
        lastAlreadyMailAt: null,
      });
      expect(near(created.confirmExpiresAt, new Date(now.getTime() + 3 * DAY))).toBe(true);
      expect(near(created.lastConfirmMailAt, now)).toBe(true);
      expect(near(created.createdAt, now)).toBe(true);
      expect(lines.slice(0, linesBefore.length)).toEqual(linesBefore);
      expect(lines.slice(linesBefore.length)).toEqual([
        expect.objectContaining({
          subscriptionId: created.id,
          event: 'requested',
          place: 'form',
          ip: IP,
          userAgent: AGENT,
          locale: 'de',
        }),
      ]);
    });
  });
});

// one hash for both links: the unsubscribe token is a token of its own
const SAME_HASH = (() => {
  const same = hex64();
  return { manageHash: same, unsubscribeHash: same };
})();

describe('the request of an address', () => {
  it('is found however the address is written: lower case, no spaces around it', async () => {
    const c = CASES.find((x) =>
      x.name.startsWith('a subscription of the form in force, "already" not'),
    )!;
    const { email, hmac } = prepared.get(c.name)!;

    const answer = await inRolledBackTx(async (db) => {
      const outcome = await requestAs(
        db,
        GUEST(),
        requestArgs({ email: `  ${email.toUpperCase()} `, emailHmac: hmac }),
      );
      return outcome.ok ? outcome.rows[0] : codeOf(outcome);
    });

    expect(answer).toMatchObject({ outcome: 'already', locale: 'es' });
  });

  it('is kept in lower case without spaces, and the same address written otherwise finds it', async () => {
    const local = `Mixed-${hex64().slice(0, 12)}`;

    const { rows, second } = await inRolledBackTx(async (db) => {
      const first = await requestAs(
        db,
        GUEST(),
        requestArgs({ email: `  ${local}@Example.COM  ` }),
      );
      expect(first.ok && first.rows[0]!.outcome).toBe('confirm');

      const again = await requestAs(
        db,
        GUEST(),
        requestArgs({ email: `${local.toUpperCase()}@example.com` }),
      );

      return {
        rows: await subscriptionsOf(db, `${local.toLowerCase()}@example.com`),
        second: again.ok ? again.rows[0] : codeOf(again),
      };
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', source: 'form' });
    // the second request found the first one, mailed a moment ago
    expect(second).toMatchObject({ outcome: 'nothing' });
  });

  it('kills the old link when it is mailed again and makes the new one work, in the new language', async () => {
    const c = CASES.find(
      (x) => x.name === 'a request that waits, the confirmation mailed two days ago',
    )!;
    const { email } = prepared.get(c.name)!;

    await inRolledBackTx(async (db) => {
      const [old] = await subscriptionsOf(db, email);
      const { args } = await askAs(db, GUEST(), c);

      const stale = await callAs(db, GUEST(), SQL.confirm, old!.confirmHash, IP, AGENT);
      expect(stale).toEqual([{ outcome: 'invalid', locale: null }]);

      const fresh = await callAs(db, GUEST(), SQL.confirm, args.confirmHash, IP, AGENT);
      expect(fresh).toEqual([{ outcome: 'confirmed', locale: 'de' }]);
    });
  });

  it('is not an address the blocklist knows by its text: the HMAC the server computed decides', async () => {
    const c = CASES.find((x) => x.name === 'a blocked address that has no subscription')!;
    const { email, hmac } = prepared.get(c.name)!;

    await inRolledBackTx(async (db) => {
      // the address with another HMAC is not blocked
      const other = await requestAs(db, GUEST(), requestArgs({ email }));
      expect(other.ok && other.rows[0]!.outcome).toBe('confirm');
    });

    await inRolledBackTx(async (db) => {
      // another address with the HMAC of the blocked one is
      const blocked = await requestAs(db, GUEST(), requestArgs({ emailHmac: hmac }));
      expect(blocked.ok && blocked.rows[0]).toEqual({
        outcome: 'nothing',
        locale: null,
        manage_salt: null,
      });
    });
  });

  // the mail that asks to confirm and the mail that says "already subscribed" share one day: after the
  // person confirmed, the next request of the same day mails nothing, and the day after it does
  it('mails "already" only a day after the confirmation was mailed', async () => {
    await inOwnerTx(async (db) => {
      const args = requestArgs();
      const first = await requestAs(db, GUEST(), args);
      expect(first.ok && first.rows[0]!.outcome).toBe('confirm');
      expect(await callAs(db, GUEST(), SQL.confirm, args.confirmHash, IP, AGENT)).toEqual([
        { outcome: 'confirmed', locale: 'en' },
      ]);

      // a minute after the confirmation mail went: nothing goes
      const sameDay = await requestAs(db, GUEST(), requestArgs({ email: args.email }));
      expect(sameDay.ok && sameDay.rows[0]!.outcome).toBe('nothing');

      // the day after, "already" goes, and the next one waits for its own day
      await callAs(
        db,
        READER,
        `update cartlify.newsletter_subscriptions
         set "lastConfirmMailAt" = "lastConfirmMailAt" - interval '2 days' where email = $1`,
        args.email,
      );
      const nextDay = await requestAs(db, GUEST(), requestArgs({ email: args.email }));
      expect(nextDay.ok && nextDay.rows[0]!.outcome).toBe('already');

      const again = await requestAs(db, GUEST(), requestArgs({ email: args.email }));
      expect(again.ok && again.rows[0]!.outcome).toBe('nothing');
    });
  });

  it('makes one request when two come for a new address at the same time', async () => {
    const email = uniqueEmail('race');

    // two transactions of their own, on two connections, both commit
    const answers = await Promise.all(
      [0, 1].map(() =>
        inCommittedTx(async (db) => {
          const outcome = await requestAs(db, GUEST(), requestArgs({ email }));
          return outcome.ok ? outcome.rows[0]!.outcome : codeOf(outcome);
        }),
      ),
    );

    const rows = await inRolledBackTx((db) => subscriptionsOf(db, email));
    subscriptionIds.push(...rows.map((row) => row.id));

    // the second waited for the first, found its request and, mailed a moment ago, mailed nothing
    expect([...answers].sort()).toEqual(['confirm', 'nothing']);
    expect(rows).toHaveLength(1);
  });

  it('may come with no language: the subscription then has none', async () => {
    const row = await inRolledBackTx(async (db) => {
      const args = requestArgs({ locale: null });
      const outcome = await requestAs(db, GUEST(), args);
      expect(outcome.ok && outcome.rows[0]).toMatchObject({ outcome: 'confirm', locale: null });
      return (await subscriptionsOf(db, args.email))[0];
    });

    expect(row).toMatchObject({ locale: null, status: 'pending' });
  });

  it.each(['EN', 'eng', 'e', '', 'e1', ' en'])(
    'is refused a language that is not two lower-case letters: %p',
    async (locale) => {
      const outcome = await inRolledBackTx(async (db) =>
        requestAs(db, GUEST(), requestArgs({ locale })),
      );

      expect(codeOf(outcome)).toBe('NEWSLETTER_LOCALE_INVALID');
    },
  );

  it.each([
    ['the confirmation link', { confirmHash: 'not-a-sha256' }],
    ['the HMAC of the address', { emailHmac: 'not-an-hmac' }],
    ['the salt of the management link', { manageSalt: 'short' }],
    ['the hash of the management link', { manageHash: 'not-a-sha256' }],
    ['the hash of the unsubscribe link', { unsubscribeHash: 'not-a-sha256' }],
    ['the hash of the unsubscribe link, the same as of the management link', SAME_HASH],
  ])(
    'is refused by the checks of the table when %s is not what the server makes',
    async (_what, set) => {
      const outcome = await inRolledBackTx(async (db) => requestAs(db, GUEST(), requestArgs(set)));

      expect(outcome).toMatchObject({ ok: false, code: '23514' });
    },
  );
});

describe('the links of the request', () => {
  it('keeps the links a request has when it is asked again: the hashes of the new ask are not taken', async () => {
    await inOwnerTx(async (db) => {
      const email = uniqueEmail('keeps');
      const first = requestArgs({ email });
      await requestAs(db, GUEST(), first);
      // the confirmation was mailed two days ago: the form may mail again
      await db.rows(
        `update cartlify.newsletter_subscriptions
         set "lastConfirmMailAt" = (now() at time zone 'utc') - interval '2 days' where email = $1`,
        email,
      );

      const second = requestArgs({ email, emailHmac: first.emailHmac });
      const outcome = await requestAs(db, GUEST(), second);
      expect(outcome).toMatchObject({ ok: true, rows: [{ outcome: 'confirm' }] });

      const rows = await subscriptionsOf(db, email);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        confirmHash: second.confirmHash,
        manageSalt: first.manageSalt,
        manageHash: first.manageHash,
        unsubscribeHash: first.unsubscribeHash,
      });
    });
  });

  it('writes the hash of the unsubscribe link of a new request, and one for each request', async () => {
    await inRolledBackTx(async (db) => {
      const a = requestArgs();
      const b = requestArgs();
      await requestAs(db, GUEST(), a);
      await requestAs(db, GUEST(), b);

      const [rowA] = await subscriptionsOf(db, a.email);
      const [rowB] = await subscriptionsOf(db, b.email);
      expect(rowA!.unsubscribeHash).toBe(a.unsubscribeHash);
      expect(rowB!.unsubscribeHash).toBe(b.unsubscribeHash);
      expect(rowA!.unsubscribeHash).not.toBe(rowA!.manageHash);
    });
  });

  it('is refused when the hash of the unsubscribe link is taken by another subscription', async () => {
    await inRolledBackTx(async (db) => {
      const a = requestArgs();
      await requestAs(db, GUEST(), a);

      const b = requestArgs({ unsubscribeHash: a.unsubscribeHash });
      const outcome = await requestAs(db, GUEST(), b);

      expect(outcome).toMatchObject({ ok: false, code: '23505' });
    });
  });
});

describe('the consent of the request', () => {
  it('records the version of the privacy policy in force in the line of the request', async () => {
    await inRolledBackTx(async (db) => {
      const version = await publishPrivacy(db, fx.root.id);
      const args = requestArgs();
      await requestAs(db, GUEST(), args);

      const [row] = await subscriptionsOf(db, args.email);
      const lines = await journalOf(db, row!.id);

      expect(lines).toEqual([
        expect.objectContaining({ event: 'requested', privacyVersion: version }),
      ]);
    });
  });

  it('records the version in the line of the confirmation too, and the newest one', async () => {
    await inRolledBackTx(async (db) => {
      const first = await publishPrivacy(db, fx.root.id);
      const args = requestArgs();
      await requestAs(db, GUEST(), args);

      const newest = await publishPrivacy(db, fx.root.id);
      expect(newest).toBeGreaterThan(first);
      await callAs(db, GUEST(), SQL.confirm, args.confirmHash, IP, AGENT);

      const [row] = await subscriptionsOf(db, args.email);
      const lines = await journalOf(db, row!.id);

      expect(lines.map((line) => [line.event, line.privacyVersion])).toEqual([
        ['requested', first],
        ['confirmed', newest],
      ]);
    });
  });
});

describe('the tables behind the request', () => {
  it('stay closed to the guest who made the request: it reads and writes through the function only', async () => {
    await inRolledBackTx(async (db) => {
      const args = requestArgs();
      await requestAs(db, GUEST(), args);

      const guest = GUEST();
      for (const table of [
        'newsletter_subscriptions',
        'newsletter_subscription_events',
        'newsletter_campaigns',
        'newsletter_recipients',
        'newsletter_form_blocklist',
      ]) {
        const rows = await callAs<{ n: number }>(
          db,
          guest,
          `select count(*)::int as n from cartlify.${table}`,
        );
        expect(rows).toEqual([{ n: 0 }]);
      }

      const write = await attemptAs(
        db,
        guest,
        `insert into cartlify.newsletter_subscriptions
           (email, "emailHmac", source, status, "manageSalt", "manageHash", "unsubscribeHash")
         values ($1, $2, 'form', 'active', $3, $4, $5)`,
        uniqueEmail('direct'),
        hex64(),
        hex64(),
        hex64(),
        hex64(),
      );
      expect(write).toMatchObject({ ok: false, code: '42501' });

      // root sees what the guest's request made
      const [row] = await subscriptionsOf(db, args.email);
      expect(row).toMatchObject({ status: 'pending' });
      expect(
        (
          await callAs(
            db,
            READER,
            'select 1 as one from cartlify.newsletter_subscriptions where id = $1',
            row!.id,
          )
        ).length,
      ).toBe(1);
    });
  });
});
