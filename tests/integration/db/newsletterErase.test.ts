import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor } from '../../helpers/db.js';
import { createUser, uniqueEmail } from '../../helpers/factories.js';
import {
  blockRow,
  eventRow,
  hex64,
  insertRow,
  insertSubscription,
  recipientRow,
  removeNewsletterFixtures,
  removeSubscriptionRows,
  setupNewsletterFixtures,
  type NewsletterFixtures,
  type SubscriptionStatus,
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
  near,
  requestArgs,
  requestAs,
  subscriptionsOf,
  type EventRow,
  type SubscriptionRow,
} from '../../helpers/newsletterFns.js';
import { inOwnerTx, type OwnerSession } from '../../helpers/ownerDb.js';

// A manager erases an address on the word of the person (the request comes to support@):
// cartlify.newsletter_admin_erase_address. Every subscription the address ever had is made anonymous
// in place: the address becomes a placeholder, the tokens are replaced, the HMAC and the browser and
// the address of the journal are emptied, what is live ends (removed_by_admin). The dates, the
// states, the journal lines themselves, the mails of the campaigns and the blocklist stay. A case
// makes its rows in a session of the owner of the database that rolls back

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

const MANAGER = (): Actor => ({ role: 'ADMIN', userId: fx.manager.id });
const ROOT = (): Actor => ({ role: 'ROOT', userId: fx.root.id });
const PLAIN_ADMIN = (): Actor => ({ role: 'ADMIN', userId: fx.plainAdmin.id });
const BUYER = (): Actor => ({ role: 'USER', userId: fx.stranger.id });

const FORBIDDEN = 'NEWSLETTER_FORBIDDEN';
const HEX64 = /^[0-9a-f]{64}$/;
const placeholderOf = (id: number) => `deleted+${id}@deleted.invalid`;

type Live = Extract<SubscriptionStatus, 'pending' | 'active' | 'paused_complaint'>;

type Address = {
  email: string;
  hmac: string;
  // the rows of the address, oldest first: ended, stopped by a bounce, and the live one
  ended: number;
  stopped: number;
  live: number;
  // a line of the journal of each, a mail of a campaign for each
  lines: Record<'ended' | 'stopped' | 'live', number[]>;
  mails: number[];
};

// an address with everything the person left behind: three subscriptions in three states, each with
// two lines that carry the address and the browser of the request, a mail of a campaign for each
async function addressIn(
  db: OwnerSession,
  opts: { live?: Live; source?: 'form' | 'account'; user?: { id: number; email: string } } = {},
): Promise<Address> {
  const source = opts.source ?? 'form';
  const email = opts.user?.email ?? uniqueEmail('erase');
  const hmac = hex64();
  const live = opts.live ?? 'active';

  const ended = await insertSubscription(db, {
    email,
    status: 'ended',
    locale: 'en',
    set: { emailHmac: hmac },
  });
  const stopped = await insertSubscription(db, {
    email,
    status: 'stopped_bounce',
    locale: 'es',
    set: { emailHmac: hmac },
  });
  const liveId = await insertSubscription(db, {
    email,
    status: live,
    source,
    userId: source === 'account' ? opts.user?.id : undefined,
    locale: 'de',
    set: source === 'form' ? { emailHmac: hmac } : {},
  });

  const lines = { ended: [] as number[], stopped: [] as number[], live: [] as number[] };
  for (const [name, id] of [
    ['ended', ended],
    ['stopped', stopped],
    ['live', liveId],
  ] as const) {
    lines[name].push(await insertRow(db, 'newsletter_subscription_events', eventRow(id)));
    lines[name].push(
      await insertRow(
        db,
        'newsletter_subscription_events',
        eventRow(id, { event: 'subscribed', place: 'profile', ip: '198.51.100.4', userAgent: 'x' }),
      ),
    );
  }

  const mails = [];
  for (const id of [ended, stopped, liveId]) {
    mails.push(await insertRow(db, 'newsletter_recipients', recipientRow(fx.campaign, id)));
  }

  return { email, hmac, ended, stopped, live: liveId, lines, mails };
}

const rowOf = async (db: OwnerSession, id: number): Promise<SubscriptionRow> => {
  const [row] = await callAs<SubscriptionRow>(
    db,
    READER,
    `select id, email, "emailHmac", "userId", source::text as source, locale,
            status::text as status, "confirmHash", "confirmExpiresAt", "manageSalt", "manageHash",
            "unsubscribeHash", "endedUserId", "lastConfirmMailAt", "lastAlreadyMailAt", "createdAt",
            "confirmedAt", "endedAt", "endReason"::text as "endReason", "updatedAt"
     from cartlify.newsletter_subscriptions where id = $1`,
    id,
  );
  return row!;
};

// the rows of the ids, one after another (a session is one connection: no two statements at once)
async function rowsOfIds(db: OwnerSession, ids: number[]): Promise<SubscriptionRow[]> {
  const rows: SubscriptionRow[] = [];
  for (const id of ids) rows.push(await rowOf(db, id));
  return rows;
}

const linesOf = (db: OwnerSession, ids: number[]) =>
  callAs<EventRow & { createdAt: Date }>(
    db,
    READER,
    `select id, "subscriptionId", event::text as event, place::text as place, ip, "userAgent",
            locale, "campaignId", "privacyVersion", "actorId", "createdAt"
     from cartlify.newsletter_subscription_events where "subscriptionId" = any($1::int[]) order by id`,
    ids,
  );

const mailsOf = (db: OwnerSession, ids: number[]) =>
  callAs<{ id: number; subscriptionId: number; status: string; locale: string }>(
    db,
    READER,
    `select id, "subscriptionId", status::text as status, locale
     from cartlify.newsletter_recipients where id = any($1::int[]) order by id`,
    ids,
  );

const erase = (db: OwnerSession, actor: Actor | null, id: number | null) =>
  attemptAs<{ erased: number }>(db, actor, SQL.adminErase, id);

describe('cartlify.newsletter_admin_erase_address', () => {
  describe.each(['pending', 'active', 'paused_complaint'] as Live[])(
    'an address with a live subscription (%s)',
    (live) => {
      it('makes every subscription of the address anonymous, and says how many', async () => {
        await inOwnerTx(async (db) => {
          const address = await addressIn(db, { live });
          const ids = [address.ended, address.stopped, address.live];
          const before = await rowsOfIds(db, ids);
          const now = await dbNow(db);

          const outcome = await erase(db, MANAGER(), address.live);
          expect(outcome).toEqual({ ok: true, rows: [{ erased: 3 }] });

          const after = await rowsOfIds(db, ids);
          for (const [index, row] of after.entries()) {
            const was = before[index]!;
            expect(row).toMatchObject({
              email: placeholderOf(row.id),
              emailHmac: null,
              confirmHash: null,
              confirmExpiresAt: null,
              endedUserId: null,
            });
            // the tokens are new, valid and nobody's
            for (const key of ['manageHash', 'unsubscribeHash'] as const) {
              expect(row[key]).toMatch(HEX64);
              expect(row[key]).not.toBe(was[key]);
            }
            expect(row.manageSalt).not.toBe(was.manageSalt);
            expect(row.manageSalt.length).toBeGreaterThanOrEqual(16);
            expect(row.manageSalt.length).toBeLessThanOrEqual(128);
            expect(row.manageHash).not.toBe(row.unsubscribeHash);
            // what the row says of the person's choices and dates stays
            expect(row).toMatchObject({
              id: was.id,
              userId: was.userId,
              source: was.source,
              locale: was.locale,
              createdAt: was.createdAt,
              confirmedAt: was.confirmedAt,
              lastConfirmMailAt: was.lastConfirmMailAt,
              lastAlreadyMailAt: was.lastAlreadyMailAt,
            });
          }

          // the live one ends now, by the admin; the ones that ended keep how and when
          expect(after[2]).toMatchObject({ status: 'ended', endReason: 'removed_by_admin' });
          expect(near(after[2]!.endedAt, now)).toBe(true);
          expect(after[0]).toMatchObject({
            status: 'ended',
            endReason: before[0]!.endReason,
            endedAt: before[0]!.endedAt,
          });
          expect(after[1]).toMatchObject({
            status: 'stopped_bounce',
            endReason: 'bounced',
            endedAt: before[1]!.endedAt,
          });
        });
      });

      it('empties the address and the browser of every line of the journal, and keeps the lines', async () => {
        await inOwnerTx(async (db) => {
          const address = await addressIn(db, { live });
          const ids = [address.ended, address.stopped, address.live];
          const before = await linesOf(db, ids);
          expect(before.every((line) => line.ip !== null)).toBe(true);

          await erase(db, MANAGER(), address.live);

          const after = await linesOf(db, ids);
          expect(after).toHaveLength(before.length);
          expect(after.every((line) => line.ip === null && line.userAgent === null)).toBe(true);
          // the lines stay otherwise as they were: what, where, when, in which language
          expect(after.map((line) => ({ ...line, ip: null, userAgent: null }))).toEqual(
            before.map((line) => ({ ...line, ip: null, userAgent: null })),
          );
        });
      });

      it('leaves the mails of the campaigns and the blocklist alone', async () => {
        await inOwnerTx(async (db) => {
          const address = await addressIn(db, { live });
          const block = await insertRow(
            db,
            'newsletter_form_blocklist',
            blockRow({ emailHmac: address.hmac }),
          );
          const before = await mailsOf(db, address.mails);
          expect(before).toHaveLength(3);

          await erase(db, MANAGER(), address.live);

          expect(await mailsOf(db, address.mails)).toEqual(before);
          const listed = await callAs(
            db,
            READER,
            'select id from cartlify.newsletter_form_blocklist where id = $1',
            block,
          );
          expect(listed).toEqual([{ id: block }]);
        });
      });

      it('leaves the other addresses alone, the one beside it with the same name before the plus too', async () => {
        await inOwnerTx(async (db) => {
          const address = await addressIn(db, { live });
          const neighbour = await addressIn(db, { live });
          const [local, domain] = address.email.split('@');
          const plus = await insertSubscription(db, {
            status: 'active',
            email: `${local}+news@${domain}`,
          });
          const before = {
            neighbour: await rowsOfIds(db, [neighbour.ended, neighbour.stopped, neighbour.live]),
            plus: await rowOf(db, plus),
            lines: await linesOf(db, [neighbour.ended, neighbour.stopped, neighbour.live]),
          };

          await erase(db, MANAGER(), address.live);

          expect(await rowsOfIds(db, [neighbour.ended, neighbour.stopped, neighbour.live])).toEqual(
            before.neighbour,
          );
          expect(await rowOf(db, plus)).toEqual(before.plus);
          expect(await linesOf(db, [neighbour.ended, neighbour.stopped, neighbour.live])).toEqual(
            before.lines,
          );
        });
      });
    },
  );

  it('erases a subscription of an account the same way, and keeps the account it belongs to', async () => {
    await inOwnerTx(async (db) => {
      const user = await createUser();
      const address = await addressIn(db, { source: 'account', user });
      const before = await rowOf(db, address.live);

      expect(await erase(db, MANAGER(), address.live)).toEqual({
        ok: true,
        rows: [{ erased: 3 }],
      });

      const after = await rowOf(db, address.live);
      expect(after).toMatchObject({
        email: placeholderOf(address.live),
        emailHmac: null,
        source: 'account',
        userId: user.id,
        status: 'ended',
        endReason: 'removed_by_admin',
      });
      expect(after.manageHash).not.toBe(before.manageHash);
      expect(after.unsubscribeHash).not.toBe(before.unsubscribeHash);
    });
  });

  it('erases the whole address whichever of its rows the id names', async () => {
    for (const named of ['ended', 'stopped', 'live'] as const) {
      await inOwnerTx(async (db) => {
        const address = await addressIn(db);

        expect(await erase(db, MANAGER(), address[named])).toEqual({
          ok: true,
          rows: [{ erased: 3 }],
        });

        for (const id of [address.ended, address.stopped, address.live]) {
          expect((await rowOf(db, id)).email).toBe(placeholderOf(id));
        }
      });
    }
  });

  it('erases a lone subscription, and its single row is the count', async () => {
    await inOwnerTx(async (db) => {
      const id = await insertSubscription(db, { status: 'active' });

      expect(await erase(db, MANAGER(), id)).toEqual({ ok: true, rows: [{ erased: 1 }] });
      expect(await rowOf(db, id)).toMatchObject({
        email: placeholderOf(id),
        status: 'ended',
        endReason: 'removed_by_admin',
      });
    });
  });

  it('forgets the account that ended a subscription of the form with the account', async () => {
    await inOwnerTx(async (db) => {
      const user = await createUser();
      const id = await insertSubscription(db, {
        status: 'ended',
        set: { endReason: 'account_deleted', endedUserId: user.id },
      });
      expect((await rowOf(db, id)).endedUserId).toBe(user.id);

      expect(await erase(db, MANAGER(), id)).toEqual({ ok: true, rows: [{ erased: 1 }] });

      expect((await rowOf(db, id)).endedUserId).toBeNull();
    });
  });

  it('gives each row a token of its own, and none that was given before', async () => {
    await inOwnerTx(async (db) => {
      const a = await addressIn(db);
      const b = await addressIn(db);
      const ids = [a.ended, a.stopped, a.live, b.ended, b.stopped, b.live];
      const old = await rowsOfIds(db, ids);

      await erase(db, MANAGER(), a.live);
      await erase(db, MANAGER(), b.live);

      const fresh = await rowsOfIds(db, ids);
      const tokens = fresh.flatMap((row) => [row.manageHash, row.unsubscribeHash]);
      expect(new Set(tokens).size).toBe(tokens.length);
      const salts = fresh.map((row) => row.manageSalt);
      expect(new Set(salts).size).toBe(salts.length);
      const oldTokens = new Set(
        old.flatMap((row) => [row.manageHash, row.unsubscribeHash, row.confirmHash ?? '']),
      );
      for (const token of tokens) expect(oldTokens.has(token)).toBe(false);
    });
  });

  it('kills the links of the mails the address was sent: nothing opens by a token it had', async () => {
    await inOwnerTx(async (db) => {
      const address = await addressIn(db, { live: 'pending' });
      const before = await rowOf(db, address.live);
      const old = {
        confirm: before.confirmHash!,
        manage: before.manageHash,
        unsubscribe: before.unsubscribeHash,
      };

      await erase(db, MANAGER(), address.live);

      const confirm = await attemptAs(db, GUEST(), SQL.confirm, old.confirm, IP, AGENT);
      expect(confirm).toEqual({ ok: true, rows: [{ outcome: 'invalid', locale: null }] });
      expect(codeOf(await attemptAs(db, GUEST(), SQL.manageGet, old.manage))).toBe(
        'NEWSLETTER_LINK_INVALID',
      );
      expect(
        codeOf(await attemptAs(db, GUEST(), SQL.oneClick, old.unsubscribe, null, IP, AGENT)),
      ).toBe('NEWSLETTER_LINK_INVALID');
      expect(await attemptAs(db, GUEST(), SQL.notMe, old.confirm, IP, AGENT)).toEqual({
        ok: true,
        rows: [{ done: false }],
      });
    });
  });

  it('lets the address ask again afterwards: a request of its own, beside the erased rows', async () => {
    await inOwnerTx(async (db) => {
      const address = await addressIn(db, { live: 'active' });
      await erase(db, MANAGER(), address.live);

      const asked = await requestAs(
        db,
        GUEST(),
        requestArgs({ email: address.email, emailHmac: address.hmac }),
      );
      expect(asked).toMatchObject({ ok: true, rows: [{ outcome: 'confirm' }] });

      const rows = await subscriptionsOf(db, address.email);
      expect(rows.map((row) => row.status)).toEqual(['pending']);
    });
  });

  it('does nothing the second time: the rows are anonymous already, the count is nought', async () => {
    await inOwnerTx(async (db) => {
      const address = await addressIn(db);
      await erase(db, MANAGER(), address.live);
      const ids = [address.ended, address.stopped, address.live];
      const after = await rowsOfIds(db, ids);
      const lines = await linesOf(db, ids);

      for (const id of ids) {
        expect(await erase(db, MANAGER(), id)).toEqual({ ok: true, rows: [{ erased: 0 }] });
      }

      expect(await rowsOfIds(db, ids)).toEqual(after);
      expect(await linesOf(db, ids)).toEqual(lines);
    });
  });

  it('erases a row that appeared beside the erased ones later, and only that one', async () => {
    await inOwnerTx(async (db) => {
      const address = await addressIn(db);
      await erase(db, MANAGER(), address.live);
      const erased = await rowsOfIds(db, [address.ended, address.stopped, address.live]);

      const later = await insertSubscription(db, { status: 'active', email: address.email });
      expect(await erase(db, MANAGER(), later)).toEqual({ ok: true, rows: [{ erased: 1 }] });

      expect(await rowsOfIds(db, [address.ended, address.stopped, address.live])).toEqual(erased);
      expect((await rowOf(db, later)).email).toBe(placeholderOf(later));
    });
  });

  it('answers nought for a subscription that does not exist, and changes nothing', async () => {
    await inOwnerTx(async (db) => {
      const address = await addressIn(db);
      const before = await rowOf(db, address.live);

      expect(await erase(db, MANAGER(), 2147483647)).toEqual({ ok: true, rows: [{ erased: 0 }] });
      expect(await erase(db, MANAGER(), null)).toEqual({ ok: true, rows: [{ erased: 0 }] });
      expect(await rowOf(db, address.live)).toEqual(before);
    });
  });

  describe('who may', () => {
    it.each([
      ['an admin with the right', MANAGER],
      ['root', ROOT],
      ['root without an account', () => ({ role: 'ROOT' }) as Actor],
    ])('erase an address: %s', async (_who, actor) => {
      await inOwnerTx(async (db) => {
        const address = await addressIn(db);

        expect(await erase(db, actor(), address.live)).toEqual({ ok: true, rows: [{ erased: 3 }] });
      });
    });

    it.each([
      ['a guest', GUEST],
      ['no context', () => null],
      ['a buyer', BUYER],
      ['an admin without the right to run the newsletters', PLAIN_ADMIN],
      ['the system', () => SYSTEM],
    ])('not: %s', async (_who, actor) => {
      await inOwnerTx(async (db) => {
        const address = await addressIn(db);
        const ids = [address.ended, address.stopped, address.live];
        const before = await rowsOfIds(db, ids);
        const lines = await linesOf(db, ids);

        expect(codeOf(await erase(db, actor(), address.live))).toBe(FORBIDDEN);
        // not even to tell whether an id exists
        expect(codeOf(await erase(db, actor(), 2147483647))).toBe(FORBIDDEN);

        expect(await rowsOfIds(db, ids)).toEqual(before);
        expect(await linesOf(db, ids)).toEqual(lines);
      });
    });

    it('is run by the role of the app for a manager, and refused to the others', async () => {
      const id = await inOwnerTx(
        async (db) => {
          return insertSubscription(db, { status: 'active' });
        },
        { commit: true },
      );

      try {
        const answers = await inRolledBackTx(async (db) => ({
          guest: codeOf(await attemptAs(db, GUEST(), SQL.adminErase, id)),
          manager: await attemptAs(db, MANAGER(), SQL.adminErase, id),
        }));

        expect(answers.guest).toBe(FORBIDDEN);
        expect(answers.manager).toEqual({ ok: true, rows: [{ erased: 1 }] });
      } finally {
        await removeSubscriptionRows([id]);
      }
    });
  });
});
