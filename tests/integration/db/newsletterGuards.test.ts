import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession, type Outcome } from '../../helpers/db.js';
import { createUser } from '../../helpers/factories.js';
import {
  attemptInsert,
  blockRow,
  draftCampaignIn,
  eventRow,
  hex64,
  insertRow,
  insertSubscription,
  recipientIn,
  recipientRow,
  removeNewsletterFixtures,
  setupNewsletterFixtures,
  utc,
  type NewsletterFixtures,
  type RecipientState,
  type SubscriptionStatus,
} from '../../helpers/newsletterDb.js';
import { inOwnerTx, type OwnerSession } from '../../helpers/ownerDb.js';

// what a change of a row of the newsletter tables may be, whoever the policies let reach it: the
// guards of db/05 (trg_<table>_update_columns, the journal's trg_..._append_only) compare the new row
// with the old one. A change by the app role is tried in a transaction of cartlify_app, a step of
// the database's own functions in one of the owner (tests/helpers/ownerDb.ts); both roll back

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

const DAY = 86_400_000;

const MANAGER = (): Actor => ({ role: 'ADMIN', userId: fx.manager.id });
const ROOT = (): Actor => ({ role: 'ROOT', userId: fx.root.id });
const PLAIN_ADMIN = (): Actor => ({ role: 'ADMIN', userId: fx.plainAdmin.id });
// the system: the admin context without a user id
const SYSTEM: Actor = { role: 'ADMIN' };
const GUEST = (): Actor => ({ role: 'GUEST', guestId: randomUUID() });

// in an owner session: a campaign made in the name of the actor given, who runs the newsletters
async function ownerCampaign(db: OwnerSession, actor: Actor): Promise<number> {
  await db.as(actor);
  const [row] = await db.rows<{ id: number }>(
    `insert into cartlify.newsletter_campaigns (name, "missingLocale", content, "createdById", "updatedById")
     values ('Owner', 'skip', '{"en":{}}'::jsonb, $1::int, $1::int) returning id`,
    actor.userId,
  );
  return row!.id;
}

// what a statement came to: the row it touched, nothing to touch, or the code it was refused with
const resultOf = (outcome: Outcome): string =>
  outcome.ok ? (outcome.rows.length ? 'row' : 'none') : (outcome.code ?? 'refused');

describe('the guards are in place', () => {
  it('has a guard on the update of every table of the newsletters, and on the role and the right of a user', async () => {
    const guards = await inRolledBackTx((db) =>
      db.rows<{ table: string; name: string; events: string }>(
        `select c.relname as "table", t.tgname as name,
                concat_ws(',',
                  case when t.tgtype & 4 <> 0 then 'insert' end,
                  case when t.tgtype & 16 <> 0 then 'update' end,
                  case when t.tgtype & 8 <> 0 then 'delete' end) as events
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         where c.relnamespace = 'cartlify'::regnamespace
           and (c.relname like 'newsletter\\_%'
                or t.tgname in ('trg_users_clear_newsletter_manager', 'trg_users_insert_columns'))
           and not t.tgisinternal and t.tgenabled = 'O'
         order by c.relname, t.tgname`,
      ),
    );

    expect(guards).toEqual([
      {
        table: 'newsletter_campaigns',
        name: 'trg_newsletter_campaigns_update_columns',
        events: 'update',
      },
      {
        table: 'newsletter_form_blocklist',
        name: 'trg_newsletter_form_blocklist_update_columns',
        events: 'update',
      },
      {
        table: 'newsletter_recipients',
        name: 'trg_newsletter_recipients_update_columns',
        events: 'update',
      },
      {
        table: 'newsletter_subscription_events',
        name: 'trg_newsletter_subscription_events_append_only',
        events: 'update,delete',
      },
      {
        table: 'newsletter_subscriptions',
        name: 'trg_newsletter_subscriptions_update_columns',
        events: 'update',
      },
      { table: 'users', name: 'trg_users_clear_newsletter_manager', events: 'update' },
      { table: 'users', name: 'trg_users_insert_columns', events: 'insert' },
    ]);
  });
});

describe('the refusals of the guards', () => {
  // a refusal is a code, not a sentence (the server looks the code up in the message)
  it('name their codes', async () => {
    const subscription = await inOwnerTx(async (db) => {
      const id = await insertSubscription(db);
      return db.attempt(
        `update cartlify.newsletter_subscriptions set email = 'other@example.com' where id = $1 returning id`,
        id,
      );
    });
    const { campaign, recipient } = await inRolledBackTx(async (db) => {
      const id = await draftCampaignIn(db, MANAGER());
      await db.as(SYSTEM);
      return {
        campaign: await db.attempt(
          `update cartlify.newsletter_campaigns set name = 'Renamed' where id = $1 returning id`,
          id,
        ),
        recipient: await db.attempt(
          `update cartlify.newsletter_recipients set locale = 'es' where id = $1 returning id`,
          fx.recipient,
        ),
      };
    });

    expect(subscription).toMatchObject({
      ok: false,
      code: '42501',
      message: expect.stringContaining('NEWSLETTER_SUBSCRIPTION_UPDATE_FORBIDDEN'),
    });
    expect(campaign).toMatchObject({
      ok: false,
      code: '42501',
      message: expect.stringContaining('NEWSLETTER_CAMPAIGN_UPDATE_FORBIDDEN'),
    });
    expect(recipient).toMatchObject({
      ok: false,
      code: '42501',
      message: expect.stringContaining('NEWSLETTER_RECIPIENT_UPDATE_FORBIDDEN'),
    });
  });
});

describe('the guard of the subscriptions', () => {
  // the sequence of a subscription: pending to active or ended; active to paused by a complaint,
  // stopped by a bounce or ended; paused back to active or on to stopped and ended; stopped to
  // ended; ended is the end
  const MOVES: [SubscriptionStatus, SubscriptionStatus, string | null, boolean][] = [
    ['pending', 'active', null, true],
    ['pending', 'ended', 'not_me', true],
    ['pending', 'paused_complaint', null, false],
    ['pending', 'stopped_bounce', 'bounced', false],
    ['active', 'paused_complaint', null, true],
    ['active', 'stopped_bounce', 'bounced', true],
    ['active', 'ended', 'unsubscribed', true],
    ['active', 'pending', null, false],
    ['paused_complaint', 'active', null, true],
    ['paused_complaint', 'stopped_bounce', 'bounced', true],
    ['paused_complaint', 'ended', 'account_deleted', true],
    ['paused_complaint', 'pending', null, false],
    ['stopped_bounce', 'ended', 'account_deleted', true],
    ['stopped_bounce', 'active', null, false],
    ['stopped_bounce', 'paused_complaint', null, false],
    ['ended', 'active', null, false],
    ['ended', 'pending', null, false],
    ['ended', 'paused_complaint', null, false],
    ['ended', 'stopped_bounce', 'bounced', false],
  ];

  it.each(MOVES)('moves %s to %s (reason %s): allowed %s', async (from, to, reason, allowed) => {
    const result = await inOwnerTx(async (db) => {
      const id = await insertSubscription(db, { status: from });
      return resultOf(
        await db.attempt(
          `update cartlify.newsletter_subscriptions
           set status = $2::cartlify."NewsletterSubscriptionStatus", "confirmHash" = null,
               "confirmExpiresAt" = null,
               "endedAt" = case when $3::cartlify."NewsletterEndReason" is null then null else $4::timestamp end,
               "endReason" = $3::cartlify."NewsletterEndReason"
           where id = $1 returning id`,
          id,
          to,
          reason,
          utc(),
        ),
      );
    });

    expect(result).toBe(allowed ? 'row' : '42501');
  });

  it.each([
    ['the language', `locale = 'es'`],
    ['the language emptied', 'locale = null'],
    ['the time of the last mail of confirmation', `"lastConfirmMailAt" = '2026-01-01'::timestamp`],
    [
      'the time of the last mail "already subscribed"',
      `"lastAlreadyMailAt" = '2026-01-01'::timestamp`,
    ],
    ['the time of the change', `"updatedAt" = '2026-01-01'::timestamp`],
  ])('lets the owner change %s of a subscription', async (_what, set) => {
    const result = await inOwnerTx(async (db) => {
      const id = await insertSubscription(db, { locale: 'en' });
      return resultOf(
        await db.attempt(
          `update cartlify.newsletter_subscriptions set ${set} where id = $1 returning id`,
          id,
        ),
      );
    });

    expect(result).toBe('row');
  });

  it.each([
    ['the email', `email = 'someone-else@example.com'`],
    ['the time it was made', `"createdAt" = '2020-01-01'::timestamp`],
    ['the id', 'id = id + 1000000'],
  ])('never lets %s of a subscription change', async (_what, set) => {
    const result = await inOwnerTx(async (db) => {
      const id = await insertSubscription(db);
      return resultOf(
        await db.attempt(
          `update cartlify.newsletter_subscriptions set ${set} where id = $1 returning id`,
          id,
        ),
      );
    });

    expect(result).toBe('42501');
  });

  it('turns a pending subscription of the form into one of the account that asked for its own address', async () => {
    const result = await inOwnerTx(async (db) => {
      const id = await insertSubscription(db, { status: 'pending' });
      return resultOf(
        await db.attempt(
          `update cartlify.newsletter_subscriptions
           set source = 'account', "userId" = $2, "emailHmac" = null, status = 'active',
               "confirmHash" = null, "confirmExpiresAt" = null, "confirmedAt" = $3::timestamp
           where id = $1 returning id`,
          id,
          fx.stranger.id,
          utc(),
        ),
      );
    });

    expect(result).toBe('row');
  });

  it('does not turn a subscription that is already live into one of the account', async () => {
    const result = await inOwnerTx(async (db) => {
      const id = await insertSubscription(db, { status: 'active' });
      return resultOf(
        await db.attempt(
          `update cartlify.newsletter_subscriptions
           set source = 'account', "userId" = $2, "emailHmac" = null where id = $1 returning id`,
          id,
          fx.stranger.id,
        ),
      );
    });

    expect(result).toBe('42501');
  });

  it('does not turn a subscription of an account into one of the form', async () => {
    const result = await inOwnerTx(async (db) => {
      const id = await insertSubscription(db, { source: 'account', userId: fx.stranger.id });
      return resultOf(
        await db.attempt(
          `update cartlify.newsletter_subscriptions
           set source = 'form', "userId" = null, "emailHmac" = $2 where id = $1 returning id`,
          id,
          hex64(),
        ),
      );
    });

    expect(result).toBe('42501');
  });

  it('does not hand a subscription of an account to another account', async () => {
    const result = await inOwnerTx(async (db) => {
      const id = await insertSubscription(db, { source: 'account', userId: fx.stranger.id });
      return resultOf(
        await db.attempt(
          `update cartlify.newsletter_subscriptions set "userId" = $2 where id = $1 returning id`,
          id,
          fx.subscriber.id,
        ),
      );
    });

    expect(result).toBe('42501');
  });

  it('does not give a subscription of the form an account while it stays one of the form', async () => {
    const result = await inOwnerTx(async (db) => {
      const id = await insertSubscription(db, { status: 'pending' });
      return resultOf(
        await db.attempt(
          `update cartlify.newsletter_subscriptions set "userId" = $2 where id = $1 returning id`,
          id,
          fx.stranger.id,
        ),
      );
    });

    expect(result).toBe('42501');
  });

  it.each([
    ['the language', `locale = 'es'`],
    ['the time of the last mail of confirmation', `"lastConfirmMailAt" = '2026-01-01'::timestamp`],
    ['the reason of the end', `"endReason" = 'account_deleted'`],
    ['the time of the end', `"endedAt" = '2026-01-01'::timestamp`],
    ['the hash of the link of management', `"manageHash" = '${'a'.repeat(64)}'`],
  ])('keeps an ended subscription as it is: %s does not change', async (_what, set) => {
    const result = await inOwnerTx(async (db) => {
      const id = await insertSubscription(db, { status: 'ended', locale: 'en' });
      return resultOf(
        await db.attempt(
          `update cartlify.newsletter_subscriptions set ${set} where id = $1 returning id`,
          id,
        ),
      );
    });

    expect(result).toBe('42501');
  });

  it('lets only the time of the change of an ended subscription move', async () => {
    const result = await inOwnerTx(async (db) => {
      const id = await insertSubscription(db, { status: 'ended' });
      return resultOf(
        await db.attempt(
          `update cartlify.newsletter_subscriptions set "updatedAt" = '2026-01-01'::timestamp
           where id = $1 returning id`,
          id,
        ),
      );
    });

    expect(result).toBe('row');
  });

  // The step of an admin who erases an address (cartlify.newsletter_admin_erase_address): the address
  // becomes the placeholder of the row, its HMAC and links are replaced, a live row ends. Nothing else
  // may empty the HMAC or change the address or the links of an ended row
  describe('the erasing of an address', () => {
    const erased = (id: number) => `deleted+${id}@deleted.invalid`;
    const hex = () => hex64();

    // the whole step on one row, as the function makes it
    const FULL = `update cartlify.newsletter_subscriptions
      set email = $2, "emailHmac" = null, "confirmHash" = null, "confirmExpiresAt" = null,
          "endedUserId" = null, "manageSalt" = $3, "manageHash" = $4, "unsubscribeHash" = $5,
          status = $6::cartlify."NewsletterSubscriptionStatus",
          "endedAt" = coalesce("endedAt", $7::timestamp),
          "endReason" = coalesce("endReason", 'removed_by_admin'),
          "updatedAt" = $7::timestamp
      where id = $1 returning id`;

    const fullStep = async (db: OwnerSession, id: number, over: Record<number, unknown> = {}) => {
      const [row] = await db.rows<{ status: string }>(
        'select status::text as status from cartlify.newsletter_subscriptions where id = $1',
        id,
      );
      const ended = row!.status === 'ended' || row!.status === 'stopped_bounce';
      const values: unknown[] = [
        id,
        erased(id),
        hex() + hex(),
        hex(),
        hex(),
        ended ? row!.status : 'ended',
        utc(),
      ];
      for (const [index, value] of Object.entries(over)) values[Number(index)] = value;
      return resultOf(await db.attempt(FULL, ...values));
    };

    it.each([
      'pending',
      'active',
      'paused_complaint',
      'stopped_bounce',
      'ended',
    ] as SubscriptionStatus[])('is allowed to the owner on a row that is %s', async (status) => {
      const result = await inOwnerTx(async (db) => {
        const id = await insertSubscription(db, { status });
        return fullStep(db, id);
      });

      expect(result).toBe('row');
    });

    it('is allowed on a subscription of an account, which keeps its account', async () => {
      const result = await inOwnerTx(async (db) => {
        const id = await insertSubscription(db, {
          source: 'account',
          userId: fx.stranger.id,
          status: 'active',
        });
        return fullStep(db, id);
      });

      expect(result).toBe('row');
    });

    it.each([
      ['an address that is no placeholder', 'someone-else@example.com'],
      ['the placeholder of a row that does not exist here', 'deleted+1@deleted.invalid'],
      ['a placeholder with a capital', 'Deleted+1@deleted.invalid'],
      ['a placeholder on another domain', 'deleted+1@example.com'],
    ])('is refused with %s', async (_what, email) => {
      const result = await inOwnerTx(async (db) => {
        const id = await insertSubscription(db, { status: 'active' });
        return fullStep(db, id, { 1: email });
      });

      expect(result).toBe('42501');
    });

    it('is refused when the placeholder is of another row', async () => {
      const result = await inOwnerTx(async (db) => {
        const id = await insertSubscription(db, { status: 'active' });
        return fullStep(db, id, { 1: erased(id + 1) });
      });

      expect(result).toBe('42501');
    });

    it.each([
      ['the language too', `, locale = 'es'`],
      ['the time it was made too', `, "createdAt" = '2020-01-01'::timestamp`],
      ['the time it was confirmed too', `, "confirmedAt" = '2020-01-01'::timestamp`],
      ['the last mail of confirmation too', `, "lastConfirmMailAt" = '2020-01-01'::timestamp`],
    ])(
      'is refused when it changes %s: the step is the anonymizing and nothing more',
      async (_what, extra) => {
        const result = await inOwnerTx(async (db) => {
          const id = await insertSubscription(db, { status: 'active', locale: 'en' });
          return resultOf(
            await db.attempt(
              `update cartlify.newsletter_subscriptions
             set email = $2, "emailHmac" = null, "manageSalt" = $3, "manageHash" = $4,
                 "unsubscribeHash" = $5, status = 'ended', "endedAt" = $6::timestamp,
                 "endReason" = 'removed_by_admin' ${extra}
             where id = $1 returning id`,
              id,
              erased(id),
              hex() + hex(),
              hex(),
              hex(),
              utc(),
            ),
          );
        });

        expect(result).toBe('42501');
      },
    );

    it.each([
      ['the salt', 'manageSalt'],
      ['the hash of the link of management', 'manageHash'],
      ['the hash of the link of the unsubscribe', 'unsubscribeHash'],
    ])('is refused when %s is not replaced', async (_what, kept) => {
      const result = await inOwnerTx(async (db) => {
        const id = await insertSubscription(db, { status: 'active' });
        const [row] = await db.rows<Record<string, string>>(
          `select "manageSalt", "manageHash", "unsubscribeHash"
           from cartlify.newsletter_subscriptions where id = $1`,
          id,
        );
        const next: Record<string, string> = {
          manageSalt: hex() + hex(),
          manageHash: hex(),
          unsubscribeHash: hex(),
          [kept]: row![kept]!,
        };
        return resultOf(
          await db.attempt(
            `update cartlify.newsletter_subscriptions
             set email = $2, "emailHmac" = null, "manageSalt" = $3, "manageHash" = $4,
                 "unsubscribeHash" = $5, status = 'ended', "endedAt" = $6::timestamp,
                 "endReason" = 'removed_by_admin'
             where id = $1 returning id`,
            id,
            erased(id),
            next.manageSalt,
            next.manageHash,
            next.unsubscribeHash,
            utc(),
          ),
        );
      });

      expect(result).toBe('42501');
    });

    it('is refused on a row that is anonymous already: the placeholder is not a new address', async () => {
      const result = await inOwnerTx(async (db) => {
        const id = await insertSubscription(db, { status: 'active' });
        await fullStep(db, id);
        return fullStep(db, id);
      });

      expect(result).toBe('42501');
    });

    it('is refused when the row is left alive: a live row ends with it', async () => {
      const result = await inOwnerTx(async (db) => {
        const id = await insertSubscription(db, { status: 'active' });
        return fullStep(db, id, { 5: 'active' });
      });

      expect(result).toBe('42501');
    });

    it.each([
      ['the address alone', `email = 'someone-else@example.com'`],
      ['the HMAC alone', '"emailHmac" = null'],
      ['the links alone', `"manageHash" = '${'b'.repeat(64)}'`],
      ['the link of the unsubscribe alone', `"unsubscribeHash" = '${'c'.repeat(64)}'`],
    ])('never lets %s of an ended subscription change', async (_what, set) => {
      const result = await inOwnerTx(async (db) => {
        const id = await insertSubscription(db, { status: 'ended' });
        return resultOf(
          await db.attempt(
            `update cartlify.newsletter_subscriptions set ${set} where id = $1 returning id`,
            id,
          ),
        );
      });

      // the row had an HMAC: the check would stand against a form row without one only when it is
      // live; the guard says no to all of these before
      expect(result).toBe('42501');
    });

    it.each([
      ['the HMAC emptied', '"emailHmac" = null'],
      ['the address changed', `email = 'someone-else@example.com'`],
      [
        'the address made the placeholder, with nothing else',
        `email = 'deleted+' || id || '@deleted.invalid'`,
      ],
    ])(
      'never lets a subscription that was stopped by a bounce have %s alone',
      async (_what, set) => {
        const result = await inOwnerTx(async (db) => {
          const id = await insertSubscription(db, { status: 'stopped_bounce' });
          return resultOf(
            await db.attempt(
              `update cartlify.newsletter_subscriptions set ${set} where id = $1 returning id`,
              id,
            ),
          );
        });

        expect(result).toBe('42501');
      },
    );

    it('never lets the HMAC of a live row be emptied', async () => {
      const result = await inOwnerTx(async (db) => {
        const id = await insertSubscription(db, { status: 'active' });
        return resultOf(
          await db.attempt(
            'update cartlify.newsletter_subscriptions set "emailHmac" = null where id = $1 returning id',
            id,
          ),
        );
      });

      expect(['42501', '23514']).toContain(result);
    });

    it('is not passed by the app role, which no policy lets reach a row to change', async () => {
      const result = await inRolledBackTx(async (db) => {
        await db.as(ROOT());
        return resultOf(
          await db.attempt(
            `update cartlify.newsletter_subscriptions set email = $2 where id = $1 returning id`,
            fx.formSub,
            erased(fx.formSub),
          ),
        );
      });

      expect(result).toBe('none');
    });
  });

  describe('the account that ended a subscription of the form', () => {
    it('is written in the move that ends the subscription', async () => {
      const result = await inOwnerTx(async (db) => {
        const id = await insertSubscription(db, { status: 'active' });
        return resultOf(
          await db.attempt(
            `update cartlify.newsletter_subscriptions
             set status = 'ended', "endedAt" = $3::timestamp, "endReason" = 'account_deleted',
                 "endedUserId" = $2::int
             where id = $1 returning id`,
            id,
            fx.stranger.id,
            utc(),
          ),
        );
      });

      expect(result).toBe('row');
    });

    it('is not written into a subscription that ended already: it is frozen', async () => {
      const result = await inOwnerTx(async (db) => {
        const id = await insertSubscription(db, { status: 'ended' });
        return resultOf(
          await db.attempt(
            `update cartlify.newsletter_subscriptions set "endedUserId" = $2::int where id = $1 returning id`,
            id,
            fx.stranger.id,
          ),
        );
      });

      expect(result).toBe('42501');
    });

    it('is emptied by the key when the account goes, in a subscription that ended', async () => {
      const result = await inOwnerTx(async (db) => {
        const id = await insertSubscription(db, {
          status: 'ended',
          set: { endReason: 'account_deleted', endedUserId: fx.stranger.id },
        });
        return resultOf(
          await db.attempt(
            `update cartlify.newsletter_subscriptions set "endedUserId" = null where id = $1 returning id`,
            id,
          ),
        );
      });

      // the action of the foreign key (on delete set null) runs as the owner of the table
      expect(result).toBe('row');
    });

    it('is not written beside another change of an ended subscription', async () => {
      const result = await inOwnerTx(async (db) => {
        const id = await insertSubscription(db, {
          status: 'ended',
          set: { endReason: 'account_deleted', endedUserId: fx.stranger.id },
        });
        return resultOf(
          await db.attempt(
            `update cartlify.newsletter_subscriptions
             set "endedUserId" = null, locale = 'es' where id = $1 returning id`,
            id,
          ),
        );
      });

      expect(result).toBe('42501');
    });
  });

  it('is not passed by the app role, which no policy lets reach a row to change', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(ROOT());
      return resultOf(
        await db.attempt(
          `update cartlify.newsletter_subscriptions set locale = 'es' where id = $1 returning id`,
          fx.formSub,
        ),
      );
    });

    expect(result).toBe('none');
  });

  it('is not held back by the journal when a subscription without a line is removed', async () => {
    const result = await inOwnerTx(async (db) => {
      const id = await insertSubscription(db);
      return resultOf(
        await db.attempt(
          'delete from cartlify.newsletter_subscriptions where id = $1 returning id',
          id,
        ),
      );
    });

    expect(result).toBe('row');
  });
});

describe('the guard of the journal of a subscription', () => {
  it('lets the owner add a line', async () => {
    const result = await inOwnerTx(async (db) => {
      const id = await insertSubscription(db);
      return resultOf(await attemptInsert(db, 'newsletter_subscription_events', eventRow(id)));
    });

    expect(result).toBe('row');
  });

  it('lets nobody change a line: not even the owner finds a row it may update', async () => {
    const result = await inOwnerTx(async (db) => {
      const id = await insertSubscription(db);
      const line = await insertRow(db, 'newsletter_subscription_events', eventRow(id));
      return resultOf(
        await db.attempt(
          `update cartlify.newsletter_subscription_events set place = 'system' where id = $1 returning id`,
          line,
        ),
      );
    });

    expect(result).toBe('none');
  });

  describe('the address and the browser of a line', () => {
    // a subscription an admin erased: ended, with the placeholder of its id in the place of the address
    async function erasedIn(db: OwnerSession, status: SubscriptionStatus = 'ended') {
      const id = await insertSubscription(db, { status });
      await db.rows(
        `update cartlify.newsletter_subscriptions set email = 'deleted+' || id || '@deleted.invalid',
           "emailHmac" = null, "manageSalt" = $2, "manageHash" = $3, "unsubscribeHash" = $4
         where id = $1`,
        id,
        hex64() + hex64(),
        hex64(),
        hex64(),
      );
      const line = await insertRow(db, 'newsletter_subscription_events', eventRow(id));
      return { id, line };
    }

    const EMPTY = `update cartlify.newsletter_subscription_events set ip = null, "userAgent" = null
                    where id = $1 returning id`;

    it.each(['ended', 'stopped_bounce'] as SubscriptionStatus[])(
      'are emptied by the owner on a line of an erased subscription that is %s',
      async (status) => {
        const result = await inOwnerTx(async (db) => {
          const { line } = await erasedIn(db, status);
          return resultOf(await db.attempt(EMPTY, line));
        });

        expect(result).toBe('row');
      },
    );

    it('are the only thing of a line that changes: with the address, the place is refused', async () => {
      const result = await inOwnerTx(async (db) => {
        const { line } = await erasedIn(db);
        return resultOf(
          await db.attempt(
            `update cartlify.newsletter_subscription_events
             set ip = null, "userAgent" = null, place = 'system' where id = $1 returning id`,
            line,
          ),
        );
      });

      expect(result).toBe('42501');
    });

    it('are kept as they are on a line of a subscription that was not erased', async () => {
      const result = await inOwnerTx(async (db) => {
        const id = await insertSubscription(db, { status: 'ended' });
        const line = await insertRow(db, 'newsletter_subscription_events', eventRow(id));
        return resultOf(await db.attempt(EMPTY, line));
      });

      expect(result).toBe('none');
    });

    it('are not given another value: only emptied (the policy checks the new row)', async () => {
      const result = await inOwnerTx(async (db) => {
        const { line } = await erasedIn(db);
        return resultOf(
          await db.attempt(
            `update cartlify.newsletter_subscription_events set ip = '10.0.0.1' where id = $1 returning id`,
            line,
          ),
        );
      });

      expect(result).toBe('42501');
    });

    it('say the same to a role that would skip the policies: the guard is the second wall', async () => {
      const results = await inOwnerTx(async (db) => {
        await db.rows(
          'alter table cartlify.newsletter_subscription_events no force row level security',
        );
        const erased = await erasedIn(db);
        const live = await insertSubscription(db, { status: 'active' });
        const liveLine = await insertRow(db, 'newsletter_subscription_events', eventRow(live));
        // an ended subscription that nobody erased: its address is its own
        const ended = await insertSubscription(db, { status: 'ended' });
        const endedLine = await insertRow(db, 'newsletter_subscription_events', eventRow(ended));

        return {
          erasedLine: resultOf(await db.attempt(EMPTY, erased.line)),
          liveLine: await db.attempt(EMPTY, liveLine),
          endedLine: await db.attempt(EMPTY, endedLine),
          place: await db.attempt(
            `update cartlify.newsletter_subscription_events set ip = null, place = 'system'
             where id = $1 returning id`,
            erased.line,
          ),
        };
      });

      expect(results.erasedLine).toBe('row');
      for (const refused of [results.liveLine, results.endedLine, results.place]) {
        expect(refused).toMatchObject({
          ok: false,
          code: '42501',
          message: expect.stringContaining('NEWSLETTER_EVENTS_APPEND_ONLY'),
        });
      }
    });

    it('are not emptied by the app role, whoever the actor is', async () => {
      const result = await inRolledBackTx(async (db) => {
        await db.as(ROOT());
        return resultOf(await db.attempt(EMPTY, fx.endedEvent));
      });

      expect(result).toBe('none');
    });
  });

  it('says it again to a role that would skip the policies: no change of a line, and no delete while the subscription lives', async () => {
    const results = await inOwnerTx(async (db) => {
      // the owner is held by the policies because they are forced; without that the guard is the
      // only wall left
      await db.rows(
        'alter table cartlify.newsletter_subscription_events no force row level security',
      );
      const id = await insertSubscription(db);
      const line = await insertRow(db, 'newsletter_subscription_events', eventRow(id));
      const change = await db.attempt(
        `update cartlify.newsletter_subscription_events set place = 'system' where id = $1 returning id`,
        line,
      );
      const remove = await db.attempt(
        'delete from cartlify.newsletter_subscription_events where id = $1 returning id',
        line,
      );
      return { change, remove };
    });

    expect(results.change).toMatchObject({
      ok: false,
      code: '42501',
      message: expect.stringContaining('NEWSLETTER_EVENTS_APPEND_ONLY'),
    });
    expect(results.remove).toMatchObject({
      ok: false,
      code: '42501',
      message: expect.stringContaining('NEWSLETTER_EVENTS_APPEND_ONLY'),
    });
  });

  // a line goes only with its subscription, when the term of the proof of the consent has passed:
  // the subscription has ended
  it.each([
    ['pending', false],
    ['active', false],
    ['paused_complaint', false],
    ['stopped_bounce', true],
    ['ended', true],
  ] as [SubscriptionStatus, boolean][])(
    'removes a line when its subscription is %s: %s',
    async (status, allowed) => {
      const outcome = await inOwnerTx(async (db) => {
        const id = await insertSubscription(db, { status });
        const line = await insertRow(db, 'newsletter_subscription_events', eventRow(id));
        return db.attempt(
          'delete from cartlify.newsletter_subscription_events where id = $1 returning id',
          line,
        );
      });

      expect(resultOf(outcome)).toBe(allowed ? 'row' : '42501');
      if (!allowed) {
        expect(outcome).toMatchObject({
          ok: false,
          message: expect.stringContaining('NEWSLETTER_EVENTS_APPEND_ONLY'),
        });
      }
    },
  );

  it('lets a pending request be taken away whole: end it, then its journal, then the row', async () => {
    const steps = await inOwnerTx(async (db) => {
      const id = await insertSubscription(db, { status: 'pending' });
      await insertRow(db, 'newsletter_subscription_events', eventRow(id));

      return [
        resultOf(
          await db.attempt(
            `update cartlify.newsletter_subscriptions
             set status = 'ended', "confirmHash" = null, "confirmExpiresAt" = null,
                 "endedAt" = $2::timestamp, "endReason" = 'not_me'
             where id = $1 returning id`,
            id,
            utc(),
          ),
        ),
        resultOf(
          await db.attempt(
            'delete from cartlify.newsletter_subscription_events where "subscriptionId" = $1 returning id',
            id,
          ),
        ),
        resultOf(
          await db.attempt(
            'delete from cartlify.newsletter_subscriptions where id = $1 returning id',
            id,
          ),
        ),
      ];
    });

    expect(steps).toEqual(['row', 'row', 'row']);
  });

  it('keeps a subscription that has a journal: its row is not removed before the lines', async () => {
    const outcome = await inOwnerTx(async (db) => {
      const id = await insertSubscription(db, { status: 'ended' });
      await insertRow(db, 'newsletter_subscription_events', eventRow(id));
      return db.attempt(
        'delete from cartlify.newsletter_subscriptions where id = $1 returning id',
        id,
      );
    });

    expect(outcome).toMatchObject({ ok: false, code: '23503' });
  });
});

describe('the guard of the campaigns', () => {
  type Step = 'schedule' | 'unschedule' | 'cancel' | 'start' | 'finish' | 'stop';
  type State = 'draft' | 'scheduled' | 'sending' | 'finished' | 'stopped' | 'cancelled';

  const STATES: State[] = ['draft', 'scheduled', 'sending', 'finished', 'stopped', 'cancelled'];
  const STEPS: Step[] = ['schedule', 'unschedule', 'cancel', 'start', 'finish', 'stop'];

  const NAMES_THE_EDITOR = `"updatedById" = cartlify.current_actor_id()`;
  const STEP_SQL: Record<Step, string> = {
    schedule: `update cartlify.newsletter_campaigns
               set status = 'scheduled', "scheduledAt" = $2::timestamp, ${NAMES_THE_EDITOR}
               where id = $1 returning id`,
    unschedule: `update cartlify.newsletter_campaigns
                 set status = 'draft', ${NAMES_THE_EDITOR} where id = $1 returning id`,
    cancel: `update cartlify.newsletter_campaigns
             set status = 'cancelled', "cancelledAt" = $2::timestamp, ${NAMES_THE_EDITOR}
             where id = $1 returning id`,
    start: `update cartlify.newsletter_campaigns
            set status = 'sending', "startedAt" = $2::timestamp,
                "productsSnapshot" = '{"products":[]}'::jsonb, "plannedCount" = 3
            where id = $1 returning id`,
    finish: `update cartlify.newsletter_campaigns
             set status = 'finished', "finishedAt" = $2::timestamp, "sentCount" = 2, "rejectedCount" = 1
             where id = $1 returning id`,
    stop: `update cartlify.newsletter_campaigns
           set status = 'stopped', "stoppedAt" = $2::timestamp, ${NAMES_THE_EDITOR}
           where id = $1 returning id`,
  };

  // who takes a step: the one who runs the newsletters, or the system that sends them
  const WHO: Record<Step, 'manager' | 'system'> = {
    schedule: 'manager',
    unschedule: 'manager',
    cancel: 'manager',
    start: 'system',
    finish: 'system',
    stop: 'manager',
  };

  // the steps from each state: the others are no move of a campaign
  const FROM: Record<State, Step[]> = {
    draft: ['schedule'],
    scheduled: ['unschedule', 'cancel', 'start'],
    sending: ['finish', 'stop'],
    finished: [],
    stopped: [],
    cancelled: [],
  };

  const PATH: Record<State, Step[]> = {
    draft: [],
    scheduled: ['schedule'],
    sending: ['schedule', 'start'],
    finished: ['schedule', 'start', 'finish'],
    stopped: ['schedule', 'start', 'stop'],
    cancelled: ['schedule', 'cancel'],
  };

  // a step that changes nothing about the state but the editor or the time: an edit of a draft or
  // of a scheduled campaign
  const SAME_STATE_EDIT: Partial<Record<State, Step>> = {
    draft: 'unschedule',
    scheduled: 'schedule',
  };

  const actorOf = (who: 'manager' | 'root' | 'system'): Actor =>
    who === 'system' ? SYSTEM : who === 'root' ? ROOT() : MANAGER();

  // the parameters of a step: the campaign, and the moment some steps record
  const paramsOf = (step: Step, id: number, at = utc(DAY)) =>
    STEP_SQL[step].includes('$2') ? [id, at] : [id];

  // a campaign the manager made, taken to a state by the steps the right actors take
  async function campaignIn(db: DbSession, state: State): Promise<number> {
    const id = await draftCampaignIn(db, MANAGER());

    for (const step of PATH[state]) {
      await db.as(WHO[step] === 'system' ? SYSTEM : MANAGER());
      const done = await db.rows(STEP_SQL[step], ...paramsOf(step, id));
      expect(done).toHaveLength(1);
    }

    return id;
  }

  const CASES = STATES.flatMap((state) =>
    STEPS.flatMap((step) =>
      (['manager', 'root', 'system'] as const).map((who) => [state, step, who] as const),
    ),
  );

  it.each(CASES)('a %s campaign: the step %s by %s', async (state, step, who) => {
    const result = await inRolledBackTx(async (db) => {
      const id = await campaignIn(db, state);
      await db.as(actorOf(who));
      return resultOf(await db.attempt(STEP_SQL[step], ...paramsOf(step, id, utc(2 * DAY))));
    });

    const isTheMove = FROM[state].includes(step);
    const rightActor = WHO[step] === 'system' ? who === 'system' : who !== 'system';
    const isEdit = SAME_STATE_EDIT[state] === step && who !== 'system';

    expect(result).toBe((isTheMove && rightActor) || isEdit ? 'row' : '42501');
  });

  describe('the cancellation because of the limit', () => {
    const LIMIT_CANCEL = `update cartlify.newsletter_campaigns
      set status = 'cancelled', "cancelledAt" = $2::timestamp, "cancelReason" = 'limit'
      where id = $1 returning id`;
    const reasonOf = async (db: DbSession, id: number) => {
      const [row] = await db.rows<{ status: string; reason: string | null; editor: number | null }>(
        `select status::text as status, "cancelReason"::text as reason, "updatedById" as editor
         from cartlify.newsletter_campaigns where id = $1`,
        id,
      );
      return row!;
    };

    it('is a step of the system from a scheduled campaign, and the reason is written', async () => {
      const result = await inRolledBackTx(async (db) => {
        const id = await campaignIn(db, 'scheduled');
        const before = await reasonOf(db, id);
        await db.as(SYSTEM);
        const outcome = resultOf(await db.attempt(LIMIT_CANCEL, id, utc(DAY)));
        await db.as(ROOT());
        return { outcome, before, after: await reasonOf(db, id) };
      });

      expect(result.outcome).toBe('row');
      expect(result.after).toEqual({
        status: 'cancelled',
        reason: 'limit',
        editor: result.before.editor,
      });
    });

    it.each(STATES.filter((state) => state !== 'scheduled'))(
      'is no step of the system from a campaign that is %s',
      async (state) => {
        const result = await inRolledBackTx(async (db) => {
          const id = await campaignIn(db, state);
          await db.as(SYSTEM);
          return resultOf(await db.attempt(LIMIT_CANCEL, id, utc(DAY)));
        });

        expect(result).toBe('42501');
      },
    );

    it.each([
      ['the manager', MANAGER],
      ['root', ROOT],
    ])("is not a step of %s: the reason is the system's to give", async (_who, actor) => {
      const result = await inRolledBackTx(async (db) => {
        const id = await campaignIn(db, 'scheduled');
        await db.as(actor());
        return resultOf(
          await db.attempt(
            `update cartlify.newsletter_campaigns
             set status = 'cancelled', "cancelledAt" = $2::timestamp, "cancelReason" = 'limit',
                 ${NAMES_THE_EDITOR}
             where id = $1 returning id`,
            id,
            utc(DAY),
          ),
        );
      });

      expect(result).toBe('42501');
    });

    it('leaves the reason empty when the manager cancels: it was the manager who did', async () => {
      const after = await inRolledBackTx(async (db) => {
        const id = await campaignIn(db, 'scheduled');
        await db.as(MANAGER());
        await db.rows(STEP_SQL.cancel, id, utc(DAY));
        return reasonOf(db, id);
      });

      expect(after).toMatchObject({ status: 'cancelled', reason: null });
    });

    it('is not a cancellation without the reason, when the system makes it', async () => {
      const result = await inRolledBackTx(async (db) => {
        const id = await campaignIn(db, 'scheduled');
        await db.as(SYSTEM);
        return resultOf(
          await db.attempt(
            `update cartlify.newsletter_campaigns
             set status = 'cancelled', "cancelledAt" = $2::timestamp where id = $1 returning id`,
            id,
            utc(DAY),
          ),
        );
      });

      expect(result).toBe('42501');
    });

    it.each([
      ['the name', `name = 'Renamed'`],
      ['the text', `content = '{"en":{}}'::jsonb`],
      ['the time it was scheduled for', `"scheduledAt" = '2031-01-01'::timestamp`],
      ['the editor', `"updatedById" = $3::int`],
      ['the totals', '"sentCount" = 1'],
    ])('does not let the system change %s on the way', async (_what, extra) => {
      const result = await inRolledBackTx(async (db) => {
        const id = await campaignIn(db, 'scheduled');
        await db.as(SYSTEM);
        return resultOf(
          await db.attempt(
            `update cartlify.newsletter_campaigns
             set status = 'cancelled', "cancelledAt" = $2::timestamp, "cancelReason" = 'limit',
                 ${extra}
             where id = $1 returning id`,
            ...(extra.includes('$3') ? [id, utc(DAY), fx.root.id] : [id, utc(DAY)]),
          ),
        );
      });

      expect(result).toBe('42501');
    });

    it.each([
      ['the manager', MANAGER],
      ['root', ROOT],
      ['the system', () => SYSTEM],
    ])(
      'lets %s set a reason on a campaign that is cancelled already: nobody does',
      async (_who, actor) => {
        const result = await inRolledBackTx(async (db) => {
          const id = await campaignIn(db, 'cancelled');
          await db.as(actor());
          return resultOf(
            await db.attempt(
              `update cartlify.newsletter_campaigns set "cancelReason" = 'limit' where id = $1 returning id`,
              id,
            ),
          );
        });

        expect(result).toBe('42501');
      },
    );

    it('is no way for the system to cancel a campaign it started', async () => {
      const result = await inRolledBackTx(async (db) => {
        const id = await campaignIn(db, 'sending');
        await db.as(SYSTEM);
        return resultOf(
          await db.attempt(
            `update cartlify.newsletter_campaigns
             set status = 'cancelled', "cancelledAt" = $2::timestamp, "cancelReason" = 'limit'
             where id = $1 returning id`,
            id,
            utc(DAY),
          ),
        );
      });

      expect(result).toBe('42501');
    });

    it.each([
      ['a guest', () => GUEST()],
      ['a buyer', () => ({ role: 'USER', userId: fx.stranger.id }) as Actor],
      ['an admin without the right to run the newsletters', PLAIN_ADMIN],
    ])('is not a step of %s: they find no row to change', async (_who, actor) => {
      const result = await inRolledBackTx(async (db) => {
        const id = await campaignIn(db, 'scheduled');
        await db.as(actor());
        return resultOf(await db.attempt(LIMIT_CANCEL, id, utc(DAY)));
      });

      expect(result).toBe('none');
    });
  });

  describe('the text', () => {
    const EDIT = `update cartlify.newsletter_campaigns
                  set content = $2::jsonb, name = 'Renamed', "missingLocale" = 'skip',
                      "scheduledAt" = $3::timestamp, ${NAMES_THE_EDITOR}
                  where id = $1 returning id`;
    const content = JSON.stringify({ en: { subject: 'New', preview: 'p', blocks: [] } });

    it.each(STATES)('is edited by the manager when the campaign is %s', async (state) => {
      const result = await inRolledBackTx(async (db) => {
        const id = await campaignIn(db, state);
        await db.as(MANAGER());
        return resultOf(await db.attempt(EDIT, id, content, utc(2 * DAY)));
      });

      expect(result).toBe(state === 'draft' || state === 'scheduled' ? 'row' : '42501');
    });

    it('is edited by root too: every manager edits every campaign', async () => {
      const result = await inRolledBackTx(async (db) => {
        const id = await campaignIn(db, 'scheduled');
        await db.as(ROOT());
        return resultOf(await db.attempt(EDIT, id, content, utc(2 * DAY)));
      });

      expect(result).toBe('row');
    });

    it('is never edited by the system, which only moves a campaign', async () => {
      const result = await inRolledBackTx(async (db) => {
        const id = await campaignIn(db, 'scheduled');
        await db.as(SYSTEM);
        return resultOf(await db.attempt(EDIT, id, content, utc(2 * DAY)));
      });

      expect(result).toBe('42501');
    });

    it('names who edited it: an edit in the name of another is refused', async () => {
      const result = await inRolledBackTx(async (db) => {
        const id = await campaignIn(db, 'draft');
        await db.as(MANAGER());
        return resultOf(
          await db.attempt(
            `update cartlify.newsletter_campaigns set name = 'Renamed', "updatedById" = $2::int
             where id = $1 returning id`,
            id,
            fx.root.id,
          ),
        );
      });

      expect(result).toBe('42501');
    });
  });

  describe('the totals', () => {
    const COUNTS = `update cartlify.newsletter_campaigns
                    set "sentCount" = "sentCount" + 1, "undeliveredCount" = "undeliveredCount" + 1,
                        "complaintCount" = "complaintCount" + 1, "unsubscribedCount" = "unsubscribedCount" + 1
                    where id = $1 returning id`;

    // late events (a bounce, a complaint, an unsubscribe) move the totals after the sending is over
    it.each(STATES)('are moved by the system when the campaign is %s', async (state) => {
      const result = await inRolledBackTx(async (db) => {
        const id = await campaignIn(db, state);
        await db.as(SYSTEM);
        return resultOf(await db.attempt(COUNTS, id));
      });

      expect(result).toBe(state === 'draft' || state === 'scheduled' ? '42501' : 'row');
    });

    it.each(['manager', 'root'] as const)(
      'are not moved by %s: a report is not edited',
      async (who) => {
        const result = await inRolledBackTx(async (db) => {
          const id = await campaignIn(db, 'sending');
          await db.as(actorOf(who));
          return resultOf(await db.attempt(COUNTS, id));
        });

        expect(result).toBe('42501');
      },
    );

    it.each([
      ['sending', 'row'],
      ['finished', '42501'],
      ['stopped', '42501'],
    ] as [State, string][])(
      'count the mails that were to go only while the campaign is sending (%s: %s)',
      async (state, expected) => {
        const result = await inRolledBackTx(async (db) => {
          const id = await campaignIn(db, state);
          await db.as(SYSTEM);
          return resultOf(
            await db.attempt(
              'update cartlify.newsletter_campaigns set "plannedCount" = 9 where id = $1 returning id',
              id,
            ),
          );
        });

        expect(result).toBe(expected);
      },
    );

    it('are moved by a function of the database for anybody: an unsubscribe by the link of a mail', async () => {
      const results = await inOwnerTx(async (db) => {
        const sending = await ownerCampaign(db, MANAGER());
        await db.rows(STEP_SQL.schedule, ...paramsOf('schedule', sending));
        const draft = await ownerCampaign(db, MANAGER());
        await db.as(SYSTEM);
        await db.rows(STEP_SQL.start, ...paramsOf('start', sending));

        // the guest who taps "unsubscribe" in a mail client reaches the campaign only through a
        // function of the database, which runs as the owner for whoever is calling
        await db.as(GUEST());
        return {
          totals: resultOf(
            await db.attempt(
              `update cartlify.newsletter_campaigns set "unsubscribedCount" = "unsubscribedCount" + 1
               where id = $1 returning id`,
              sending,
            ),
          ),
          text: resultOf(
            await db.attempt(
              `update cartlify.newsletter_campaigns set name = 'Renamed' where id = $1 returning id`,
              sending,
            ),
          ),
          totalsOfDraft: resultOf(
            await db.attempt(
              `update cartlify.newsletter_campaigns set "unsubscribedCount" = 1 where id = $1 returning id`,
              draft,
            ),
          ),
        };
      });

      expect(results).toEqual({ totals: 'row', text: '42501', totalsOfDraft: '42501' });
    });
  });

  describe('what never changes', () => {
    it.each([
      ['the id', () => ({ set: 'id = id + 1000000', values: [] as unknown[] })],
      ['the maker', () => ({ set: `"createdById" = $2::int`, values: [fx.root.id] })],
      [
        'the time it was made',
        () => ({ set: `"createdAt" = '2020-01-01'::timestamp`, values: [] }),
      ],
      [
        'the campaign it is a copy of',
        () => ({ set: `"copiedFromId" = $2::int`, values: [fx.campaign] }),
      ],
      ['the time it started', () => ({ set: `"startedAt" = '2020-01-01'::timestamp`, values: [] })],
      ['the data of the products', () => ({ set: `"productsSnapshot" = '[]'::jsonb`, values: [] })],
    ])('is %s, for the manager of a draft', async (_what, change) => {
      const { set, values } = change();
      const result = await inRolledBackTx(async (db) => {
        const id = await draftCampaignIn(db, MANAGER());
        await db.as(MANAGER());
        return resultOf(
          await db.attempt(
            `update cartlify.newsletter_campaigns set ${set}, ${NAMES_THE_EDITOR} where id = $1 returning id`,
            id,
            ...values,
          ),
        );
      });

      expect(result).toBe('42501');
    });

    it('is the data of the products once the campaign has started: the system does not take them again', async () => {
      const result = await inRolledBackTx(async (db) => {
        const id = await campaignIn(db, 'sending');
        await db.as(SYSTEM);
        return resultOf(
          await db.attempt(
            `update cartlify.newsletter_campaigns set "productsSnapshot" = '[]'::jsonb where id = $1 returning id`,
            id,
          ),
        );
      });

      expect(result).toBe('42501');
    });
  });

  describe('the copy of a deleted draft', () => {
    it.each(['draft', 'scheduled', 'finished'] as const)(
      'loses the link to its original when the copy is %s, and the original goes',
      async (state) => {
        const { removed, copiedFromId } = await inRolledBackTx(async (db) => {
          const original = await draftCampaignIn(db, MANAGER());
          await db.as(MANAGER());
          const [copy] = await db.rows<{ id: number }>(
            `insert into cartlify.newsletter_campaigns
               (name, "missingLocale", content, "createdById", "updatedById", "copiedFromId")
             values ('Copy', 'skip', '{"en":{}}'::jsonb, $1::int, $1::int, $2::int) returning id`,
            fx.manager.id,
            original,
          );
          for (const step of PATH[state]) {
            await db.as(WHO[step] === 'system' ? SYSTEM : MANAGER());
            await db.rows(STEP_SQL[step], ...paramsOf(step, copy!.id));
          }
          await db.as(MANAGER());
          const removed = await db.attempt(
            'delete from cartlify.newsletter_campaigns where id = $1 returning id',
            original,
          );
          const [after] = await db.rows<{ copiedFromId: number | null }>(
            'select "copiedFromId" from cartlify.newsletter_campaigns where id = $1',
            copy!.id,
          );
          return { removed: resultOf(removed), copiedFromId: after!.copiedFromId };
        });

        expect(removed).toBe('row');
        expect(copiedFromId).toBeNull();
      },
    );
  });
});

describe('the guard of the recipients', () => {
  it('lets the owner add a recipient as a mail that waits, and nothing else', async () => {
    const results = await inOwnerTx(async (db) => {
      const subscription = await insertSubscription(db);
      const queued = await attemptInsert(
        db,
        'newsletter_recipients',
        recipientRow(fx.campaign, subscription),
      );
      const sentAlready = await attemptInsert(
        db,
        'newsletter_recipients',
        recipientRow(fx.campaign, subscription, { status: 'sent', sentAt: utc() }),
      );
      const tried = await attemptInsert(
        db,
        'newsletter_recipients',
        recipientRow(fx.campaign, subscription, { attempts: 1 }),
      );
      const withId = await attemptInsert(
        db,
        'newsletter_recipients',
        recipientRow(fx.campaign, subscription, { providerMessageId: 'abc' }),
      );
      return [queued, sentAlready, tried, withId].map(resultOf);
    });

    expect(results).toEqual(['row', '42501', '42501', '42501']);
  });

  it('lets the owner record how the sending went', async () => {
    const result = await inOwnerTx(async (db) => {
      const subscription = await insertSubscription(db);
      const id = await insertRow(
        db,
        'newsletter_recipients',
        recipientRow(fx.campaign, subscription),
      );
      return resultOf(
        await db.attempt(
          `update cartlify.newsletter_recipients
           set attempts = 1, status = 'sent', "providerMessageId" = 'abc', "sentAt" = $2::timestamp
           where id = $1 returning id`,
          id,
          utc(),
        ),
      );
    });

    expect(result).toBe('row');
  });

  const CHANGES: [
    string,
    (other: { campaign: number; subscription: number }) => [string, unknown[]],
  ][] = [
    ['the language', () => [`locale = 'es'`, []]],
    ['the campaign', (other) => ['"campaignId" = $2::int', [other.campaign]]],
    ['the subscription', (other) => ['"subscriptionId" = $2::int', [other.subscription]]],
    ['the time it was made', () => [`"createdAt" = '2020-01-01'::timestamp`, []]],
    ['the id', () => ['id = id + 1000000', []]],
  ];

  it.each(CHANGES)('never lets %s of a recipient change, for the owner', async (_what, change) => {
    const result = await inOwnerTx(async (db) => {
      const campaign = await ownerCampaign(db, ROOT());
      const subscription = await insertSubscription(db);
      const other = await insertSubscription(db);
      const id = await insertRow(
        db,
        'newsletter_recipients',
        recipientRow(fx.campaign, subscription),
      );
      const [set, values] = change({ campaign, subscription: other });
      return resultOf(
        await db.attempt(
          `update cartlify.newsletter_recipients set ${set} where id = $1 returning id`,
          id,
          ...values,
        ),
      );
    });

    expect(result).toBe('42501');
  });

  it.each(CHANGES)('never lets %s of a recipient change, for the system', async (_what, change) => {
    const result = await inRolledBackTx(async (db) => {
      const campaign = await draftCampaignIn(db, MANAGER());
      const [set, values] = change({ campaign, subscription: fx.accountSub });
      await db.as(SYSTEM);
      return resultOf(
        await db.attempt(
          `update cartlify.newsletter_recipients set ${set} where id = $1 returning id`,
          fx.recipient,
          ...values,
        ),
      );
    });

    expect(result).toBe('42501');
  });

  it('lets the system record how the sending went', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(SYSTEM);
      return resultOf(
        await db.attempt(
          `update cartlify.newsletter_recipients set attempts = attempts + 1, status = 'rejected'
           where id = $1 returning id`,
          fx.recipient,
        ),
      );
    });

    expect(result).toBe('row');
  });

  // the status goes one way: a mail that waits becomes any other; a sent one is only reported on; a
  // refused, a skipped and a reported one keep theirs. [from, to, allowed]
  const RECIPIENT_MOVES: [string, string, boolean][] = [
    ['queued', 'sent', true],
    ['queued', 'rejected', true],
    ['queued', 'skipped', true],
    ['queued', 'bounced', true],
    ['queued', 'dropped', true],
    ['queued', 'complained', true],
    ['sent', 'bounced', true],
    ['sent', 'dropped', true],
    ['sent', 'complained', true],
    ['sent', 'queued', false],
    ['sent', 'rejected', false],
    ['sent', 'skipped', false],
    ['rejected', 'queued', false],
    ['rejected', 'sent', false],
    ['rejected', 'skipped', false],
    ['skipped', 'queued', false],
    ['skipped', 'sent', false],
    ['skipped', 'rejected', false],
    ['bounced', 'queued', false],
    ['bounced', 'sent', false],
    ['bounced', 'dropped', false],
    ['dropped', 'complained', false],
    ['complained', 'sent', false],
    ['complained', 'bounced', false],
  ];

  it.each(RECIPIENT_MOVES)('a mail %s goes to %s: allowed %s', async (from, to, allowed) => {
    const result = await inOwnerTx(async (db) => {
      const campaign = await ownerCampaign(db, ROOT());
      const subscription = await insertSubscription(db);
      const id = await recipientIn(db, campaign, subscription, from as RecipientState);

      return resultOf(
        await db.attempt(
          `update cartlify.newsletter_recipients
             set status = $2::cartlify."NewsletterRecipientStatus",
                 "sentAt" = case when $2 in ('queued', 'rejected', 'skipped') then null else coalesce("sentAt", $3::timestamp) end,
                 "providerMessageId" = case when $2 in ('queued', 'rejected', 'skipped') then null else "providerMessageId" end
             where id = $1 returning id`,
          id,
          to,
          utc(),
        ),
      );
    });

    expect(result).toBe(allowed ? 'row' : '42501');
  });

  it('lets the system leave a mail out, and then never take it back', async () => {
    const { left, back } = await inRolledBackTx(async (db) => {
      await db.as(SYSTEM);
      const left = resultOf(
        await db.attempt(
          `update cartlify.newsletter_recipients set status = 'skipped' where id = $1 returning id`,
          fx.recipient,
        ),
      );
      const back = resultOf(
        await db.attempt(
          `update cartlify.newsletter_recipients set status = 'queued' where id = $1 returning id`,
          fx.recipient,
        ),
      );
      return { left, back };
    });

    expect(left).toBe('row');
    expect(back).toBe('42501');
  });

  it('lets the id of the mail be written over a report that came first', async () => {
    // SendGrid reported on the mail before the answer to the send was written
    const result = await inOwnerTx(async (db) => {
      const campaign = await ownerCampaign(db, ROOT());
      const subscription = await insertSubscription(db);
      const id = await recipientIn(db, campaign, subscription, 'bounced');
      await db.rows(
        `update cartlify.newsletter_recipients set "providerMessageId" = null where id = $1`,
        id,
      );
      return resultOf(
        await db.attempt(
          `update cartlify.newsletter_recipients set "providerMessageId" = 'late-id'
           where id = $1 and "providerMessageId" is null returning id`,
          id,
        ),
      );
    });

    expect(result).toBe('row');
  });
});

describe('the guard of the blocklist', () => {
  it('lets the owner add an address', async () => {
    const result = await inOwnerTx(async (db) =>
      resultOf(await attemptInsert(db, 'newsletter_form_blocklist', blockRow())),
    );

    expect(result).toBe('row');
  });

  it('lets nobody change an entry: it is added or removed', async () => {
    const result = await inOwnerTx(async (db) => {
      const id = await insertRow(db, 'newsletter_form_blocklist', blockRow());
      return resultOf(
        await db.attempt(
          `update cartlify.newsletter_form_blocklist set reason = 'spam' where id = $1 returning id`,
          id,
        ),
      );
    });

    expect(result).toBe('none');
  });

  it('says it again to a role that would skip the policies', async () => {
    const outcome = await inOwnerTx(async (db) => {
      await db.rows('alter table cartlify.newsletter_form_blocklist no force row level security');
      const id = await insertRow(db, 'newsletter_form_blocklist', blockRow());
      return db.attempt(
        `update cartlify.newsletter_form_blocklist set reason = 'spam' where id = $1 returning id`,
        id,
      );
    });

    expect(outcome).toMatchObject({
      ok: false,
      code: '42501',
      message: expect.stringContaining('NEWSLETTER_FORM_BLOCK_UPDATE_FORBIDDEN'),
    });
  });

  it('lets the owner remove an entry', async () => {
    const result = await inOwnerTx(async (db) => {
      const id = await insertRow(db, 'newsletter_form_blocklist', blockRow());
      return resultOf(
        await db.attempt(
          'delete from cartlify.newsletter_form_blocklist where id = $1 returning id',
          id,
        ),
      );
    });

    expect(result).toBe('row');
  });
});

describe('the version of the privacy policy in force', () => {
  // a version of the privacy policy and one of the terms, published by root in the transaction
  const PRIVACY = `insert into cartlify.legal_documents
      (kind, title, content, "publishedById", "retentionLoginAddressesDays", "retentionGuestDataDays",
       "retentionDeletedChatsDays", "retentionReturnAddressesDays", "retentionReturnPersonalDays",
       "retentionRecipientDays", "retentionNewsletterConsentDays", "retentionNewsletterRecipientsDays")
    values ('privacy', 'The policy', 'The text.', $1, 1, 1, 1, 1, 1, 1, 1, 1) returning version`;
  const TERMS = `insert into cartlify.legal_documents (kind, title, content, "publishedById")
    values ('terms', 'The terms', 'The text.', $1) returning version`;
  const CURRENT = 'select cartlify.current_privacy_version() as version';

  it('is the newest version of the policy, whatever was published after it of the other kinds', async () => {
    const answers = await inOwnerTx(async (db) => {
      await db.as(ROOT());
      const [first] = await db.rows<{ version: number }>(PRIVACY, fx.root.id);
      const [afterFirst] = await db.rows<{ version: number }>(CURRENT);
      const [second] = await db.rows<{ version: number }>(PRIVACY, fx.root.id);
      await db.rows(TERMS, fx.root.id);
      const [afterTerms] = await db.rows<{ version: number }>(CURRENT);
      return {
        first: first!.version,
        afterFirst: afterFirst!.version,
        second: second!.version,
        afterTerms: afterTerms!.version,
      };
    });

    expect(answers.afterFirst).toBe(answers.first);
    expect(answers.second).toBe(answers.first + 1);
    expect(answers.afterTerms).toBe(answers.second);
  });

  it('is not a function the app role runs: the functions of the newsletters call it', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(ROOT());
      return db.attempt(CURRENT);
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });
});

describe('the right to run the newsletters, on the account', () => {
  const FLAG_OF = `select "canManageNewsletters" as flag, role::text as role from cartlify.users where id = $1`;

  it('goes off by itself when root takes the role of admin away', async () => {
    const { user, after } = await inRolledBackTx(async (db) => {
      await db.as(ROOT());
      const [user] = await db.rows<{ flag: boolean; role: string }>(FLAG_OF, fx.manager.id);
      await db.rows(`update cartlify.users set role = 'USER' where id = $1`, fx.manager.id);
      const [after] = await db.rows<{ flag: boolean; role: string }>(FLAG_OF, fx.manager.id);
      return { user, after };
    });

    expect(user).toEqual({ flag: true, role: 'ADMIN' });
    expect(after).toEqual({ flag: false, role: 'USER' });
  });

  it('is not given back when the role comes back: root allows an admin anew', async () => {
    const after = await inRolledBackTx(async (db) => {
      await db.as(ROOT());
      await db.rows(`update cartlify.users set role = 'USER' where id = $1`, fx.manager.id);
      await db.rows(`update cartlify.users set role = 'ADMIN' where id = $1`, fx.manager.id);
      const [row] = await db.rows<{ flag: boolean; role: string }>(FLAG_OF, fx.manager.id);
      return row;
    });

    expect(after).toEqual({ flag: false, role: 'ADMIN' });
  });

  it('is gone from a campaign page at once: the admin is no manager after the role went', async () => {
    const [row] = await inRolledBackTx(async (db) => {
      await db.as(ROOT());
      await db.rows(`update cartlify.users set role = 'USER' where id = $1`, fx.manager.id);
      await db.as(MANAGER());
      return db.rows<{ manager: boolean }>('select cartlify.newsletter_manager() as manager');
    });

    expect(row).toEqual({ manager: false });
  });

  it.each([
    ['root, in the statement of their own', ROOT, () => fx.plainAdmin.id],
    ['the admin, on their own account', PLAIN_ADMIN, () => fx.plainAdmin.id],
    ['an admin that has it, taking it off themselves', MANAGER, () => fx.manager.id],
  ] as [string, () => Actor, () => number][])(
    'is not set by %s: only the function of the database for root takes this step',
    async (_who, actor, targetId) => {
      const outcome = await inRolledBackTx(async (db) => {
        await db.as(actor());
        return db.attempt(
          `update cartlify.users set "canManageNewsletters" = not "canManageNewsletters"
           where id = $1 returning id`,
          targetId(),
        );
      });

      expect(outcome).toMatchObject({
        ok: false,
        code: '42501',
        message: expect.stringContaining('USER_UPDATE_FORBIDDEN'),
      });
    },
  );

  it('does not come with a new role: an account that becomes an admin does not get it with the role', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(ROOT());
      return db.attempt(
        `update cartlify.users set role = 'ADMIN', "canManageNewsletters" = true where id = $1 returning id`,
        fx.stranger.id,
      );
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });

  // root may insert an admin (db/03, users_insert): the right is not part of what a new account
  // brings, it is given afterwards by the function of the database for root
  const INSERT_USER = `insert into cartlify.users (email, role, "canManageNewsletters")
    values ($1, $2::cartlify."Role", $3::boolean) returning id`;

  it.each([
    ['root inserting an admin', ROOT, 'ADMIN'],
    ['root inserting a buyer', ROOT, 'USER'],
    ['the system inserting a buyer', () => SYSTEM, 'USER'],
  ] as [string, () => Actor, string][])(
    'is not part of a new account: %s with the right is refused',
    async (_who, actor, role) => {
      const outcome = await inRolledBackTx(async (db) => {
        await db.as(actor());
        return db.attempt(INSERT_USER, `new-${hex64().slice(0, 12)}@example.com`, role, true);
      });

      expect(outcome).toMatchObject({
        ok: false,
        code: '42501',
        message: expect.stringContaining('USER_INSERT_FORBIDDEN'),
      });
    },
  );

  it('is refused to the owner of the database too when a new account has it: only a superuser inserts it', async () => {
    const outcome = await inOwnerTx(async (db) => {
      await db.as(ROOT());
      return db.attempt(INSERT_USER, `new-${hex64().slice(0, 12)}@example.com`, 'ADMIN', true);
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });

  it('lets root insert an admin without it, and the account has no right then', async () => {
    const created = await inRolledBackTx(async (db) => {
      await db.as(ROOT());
      const email = `new-${hex64().slice(0, 12)}@example.com`;
      const outcome = await db.attempt<{ id: number }>(INSERT_USER, email, 'ADMIN', false);
      const defaulted = await db.attempt<{ id: number }>(
        `insert into cartlify.users (email, role) values ($1, 'ADMIN') returning id`,
        `new-${hex64().slice(0, 12)}@example.com`,
      );
      const rows = outcome.ok
        ? await db.rows<{ flag: boolean }>(
            'select "canManageNewsletters" as flag from cartlify.users where id = $1',
            outcome.rows[0]!.id,
          )
        : [];
      return { outcome: resultOf(outcome), defaulted: resultOf(defaulted), rows };
    });

    expect(created).toEqual({ outcome: 'row', defaulted: 'row', rows: [{ flag: false }] });
  });

  it('is set and taken off by the steps of root in a function of the database', async () => {
    const results = await inOwnerTx(async (db) => {
      await db.as(ROOT());
      const set = await db.attempt(
        `update cartlify.users set "canManageNewsletters" = true where id = $1 returning id`,
        fx.plainAdmin.id,
      );
      const [on] = await db.rows<{ flag: boolean }>(FLAG_OF, fx.plainAdmin.id);
      await db.as({ role: 'ADMIN', userId: fx.plainAdmin.id });
      const [manager] = await db.rows<{ manager: boolean }>(
        'select cartlify.newsletter_manager() as manager',
      );
      await db.as(ROOT());
      const unset = await db.attempt(
        `update cartlify.users set "canManageNewsletters" = false where id = $1 returning id`,
        fx.plainAdmin.id,
      );
      await db.as({ role: 'ADMIN', userId: fx.plainAdmin.id });
      const [off] = await db.rows<{ manager: boolean }>(
        'select cartlify.newsletter_manager() as manager',
      );
      return { set: resultOf(set), on: on!.flag, manager, unset: resultOf(unset), off };
    });

    expect(results).toEqual({
      set: 'row',
      on: true,
      manager: { manager: true },
      unset: 'row',
      off: { manager: false },
    });
  });

  it.each([
    ['an admin', () => ({ role: 'ADMIN', userId: fx.manager.id }) as Actor],
    ['the system', () => SYSTEM],
    ['a guest', GUEST],
  ] as [string, () => Actor][])(
    'is not set by a function that runs for %s, only for root',
    async (_who, actor) => {
      const outcome = await inOwnerTx(async (db) => {
        await db.as(actor());
        return db.attempt(
          `update cartlify.users set "canManageNewsletters" = true where id = $1 returning id`,
          fx.plainAdmin.id,
        );
      });

      expect(outcome).toMatchObject({ ok: false, code: '42501' });
    },
  );

  it('belongs to an admin only: a buyer cannot have it, whoever sets it', async () => {
    const outcome = await inOwnerTx(async (db) => {
      await db.as(ROOT());
      return db.attempt(
        `update cartlify.users set "canManageNewsletters" = true where id = $1 returning id`,
        fx.stranger.id,
      );
    });

    expect(outcome).toMatchObject({ ok: false, code: '23514' });
  });

  it('is not enough for an admin whose account was deleted', async () => {
    const [row] = await inOwnerTx(async (db) => {
      await db.as(ROOT());
      await db.rows(
        `update cartlify.users set "deletedAt" = $2::timestamp where id = $1`,
        fx.manager.id,
        utc(),
      );
      await db.as(MANAGER());
      return db.rows<{ manager: boolean }>('select cartlify.newsletter_manager() as manager');
    });

    expect(row).toEqual({ manager: false });
  });
});

describe('the language of an account, reset when root turns the language off', () => {
  let speaker: { id: number };

  beforeAll(async () => {
    speaker = await createUser({ locale: 'es' });
  });

  // the function that resets a language runs as the owner; root passes the guard anyway, so the
  // step is tried for the system, the actor a periodic task or a cache fill has
  it('is emptied by a step of the database for the system', async () => {
    const [row] = await inOwnerTx(async (db) => {
      await db.as(SYSTEM);
      const reset = await db.attempt(
        `update cartlify.users set locale = null, "updatedAt" = $2::timestamp where id = $1 returning id`,
        speaker.id,
        utc(),
      );
      expect(resultOf(reset)).toBe('row');
      return db.rows<{ locale: string | null }>(
        'select locale from cartlify.users where id = $1',
        speaker.id,
      );
    });

    expect(row).toEqual({ locale: null });
  });

  it.each([
    ['another language', `locale = 'en'`],
    ['the name with it', `locale = null, name = 'Someone'`],
    ['the role with it', `locale = null, role = 'ADMIN'`],
  ])('is not a way to set %s', async (_what, set) => {
    const outcome = await inOwnerTx(async (db) => {
      await db.as(SYSTEM);
      return db.attempt(`update cartlify.users set ${set} where id = $1 returning id`, speaker.id);
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });
});
