import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inCommittedTx, inRolledBackTx, type Actor } from '../../helpers/db.js';
import { uniqueEmail } from '../../helpers/factories.js';
import { interleave } from '../../helpers/interleave.js';
import {
  eventRow,
  hex64,
  insertRow,
  insertSubscription,
  removeNewsletterFixtures,
  removeSubscriptionRows,
  setupNewsletterFixtures,
  utc,
  type NewsletterFixtures,
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
  requestArgs,
  requestAs,
  subscriptionsOf,
  type RequestResult,
} from '../../helpers/newsletterFns.js';
import { inOwnerTx } from '../../helpers/ownerDb.js';

// two sessions at the same address at the same time, each in a transaction of its own that commits.
// The first stays open, holding what it took, until the second waits for it (the backend of the
// second is seen waiting for a lock), then the first commits and the second goes on: this is the
// order in which a step can slip past another. The rows are committed and taken away at the end

let fx: NewsletterFixtures;
const subscriptionIds: number[] = [];
const blockedHmacs: string[] = [];

beforeAll(async () => {
  fx = await setupNewsletterFixtures();
});

afterAll(async () => {
  try {
    await removeSubscriptionRows(subscriptionIds, blockedHmacs);
    if (fx) await removeNewsletterFixtures(fx);
  } finally {
    await prisma.$disconnect();
  }
});

const MANAGER = (): Actor => ({ role: 'ADMIN', userId: fx.manager.id });

const outcomeOf = (outcome: Awaited<ReturnType<typeof requestAs>>): string =>
  outcome.ok ? (outcome.rows[0] as RequestResult).outcome : `refused ${codeOf(outcome)}`;

// a request that waits for its confirmation, committed: the token's hash, the HMAC of the address,
// the confirmation mailed two days ago, so the form may mail again
async function pendingRequest(email = uniqueEmail('race')) {
  const confirmHash = hex64();
  const emailHmac = hex64();
  const id = await inOwnerTx(
    async (db) => {
      const row = await insertSubscription(db, {
        email,
        status: 'pending',
        locale: 'es',
        set: { confirmHash, emailHmac, lastConfirmMailAt: utc(-2 * DAY) },
      });
      await insertRow(db, 'newsletter_subscription_events', eventRow(row));
      return row;
    },
    { commit: true },
  );
  subscriptionIds.push(id);
  return { id, email, confirmHash, emailHmac };
}

// every row the address has, taken into the list the end of the file removes
async function rowsOf(email: string) {
  const rows = await inRolledBackTx((db) => subscriptionsOf(db, email));
  for (const row of rows) if (!subscriptionIds.includes(row.id)) subscriptionIds.push(row.id);
  return rows;
}

const blocked = (hmac: string) =>
  inRolledBackTx((db) =>
    callAs<{ byPerson: boolean; blockedById: number | null }>(
      db,
      READER,
      'select "byPerson", "blockedById" from cartlify.newsletter_form_blocklist where "emailHmac" = $1',
      hmac,
    ),
  );

describe('the confirmation against the request of the same address', () => {
  // the person asks again (the mail was lost) while a link of the first mail is being used
  it('kills the old link: a confirmation that waits for the new request does not use it', async () => {
    const waiting = await pendingRequest();
    const args = requestArgs({ email: waiting.email, emailHmac: waiting.emailHmac, locale: 'de' });

    const answers = await interleave(
      async (db) => outcomeOf(await requestAs(db, GUEST(), args)),
      (db) => callAs(db, GUEST(), SQL.confirm, waiting.confirmHash, IP, AGENT),
    );

    expect(answers.first).toBe('confirm');
    // the old link died with the new mail
    expect(answers.second).toEqual([{ outcome: 'invalid', locale: null }]);

    const [row] = await rowsOf(waiting.email);
    expect(row).toMatchObject({ status: 'pending', confirmHash: args.confirmHash, locale: 'de' });

    // the new link works
    const fresh = await inRolledBackTx((db) =>
      callAs(db, GUEST(), SQL.confirm, args.confirmHash, IP, AGENT),
    );
    expect(fresh).toEqual([{ outcome: 'confirmed', locale: 'de' }]);
  });

  it('answers a request that waits for the confirmation as for a subscription in force', async () => {
    const waiting = await pendingRequest();
    const args = requestArgs({ email: waiting.email, emailHmac: waiting.emailHmac, locale: 'de' });

    const answers = await interleave(
      (db) => callAs(db, GUEST(), SQL.confirm, waiting.confirmHash, IP, AGENT),
      async (db) => outcomeOf(await requestAs(db, GUEST(), args)),
    );

    expect(answers.first).toEqual([{ outcome: 'confirmed', locale: 'es' }]);
    // the request found the subscription the confirmation made: "already", not a new link
    expect(answers.second).toBe('already');

    const rows = await rowsOf(waiting.email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'active', confirmHash: null, locale: 'es' });
    expect(rows[0]!.lastAlreadyMailAt).not.toBeNull();
  });
});

describe('an address blocked against a request of the same address', () => {
  it('answers nothing to a request that comes while the block is being made', async () => {
    const email = uniqueEmail('race');
    const args = requestArgs({ email });
    blockedHmacs.push(args.emailHmac);

    const answers = await interleave(
      (db) => attemptAs(db, MANAGER(), SQL.blockAdd, args.emailHmac, 'asked by the person'),
      async (db) => outcomeOf(await requestAs(db, GUEST(), args)),
    );

    expect(answers.first).toEqual({ ok: true, rows: [{ added: true }] });
    expect(answers.second).toBe('nothing');
    expect(await rowsOf(email)).toEqual([]);
    expect(await blocked(args.emailHmac)).toHaveLength(1);
  });

  it('removes the request that was made while the block waited for it', async () => {
    const email = uniqueEmail('race');
    const args = requestArgs({ email });
    blockedHmacs.push(args.emailHmac);

    const answers = await interleave(
      async (db) => outcomeOf(await requestAs(db, GUEST(), args)),
      (db) => attemptAs(db, MANAGER(), SQL.blockAdd, args.emailHmac, 'asked by the person'),
    );

    expect(answers.first).toBe('confirm');
    expect(answers.second).toEqual({ ok: true, rows: [{ added: true }] });
    // the request that was made first is not left beside the entry that blocks the address
    expect(await rowsOf(email)).toEqual([]);
    expect(await blocked(args.emailHmac)).toHaveLength(1);
  });

  it('answers nothing to a request that comes while "this was not me" is being pressed', async () => {
    const waiting = await pendingRequest();
    blockedHmacs.push(waiting.emailHmac);
    const args = requestArgs({ email: waiting.email, emailHmac: waiting.emailHmac });

    const answers = await interleave(
      (db) => callAs(db, GUEST(), SQL.notMe, waiting.confirmHash, IP, AGENT),
      async (db) => outcomeOf(await requestAs(db, GUEST(), args)),
    );

    expect(answers.first).toEqual([{ done: true }]);
    expect(answers.second).toBe('nothing');
    expect(await rowsOf(waiting.email)).toEqual([]);
    expect(await blocked(waiting.emailHmac)).toEqual([{ byPerson: true, blockedById: null }]);
  });

  // whatever the order, the end is the same: the address is blocked and no request of it waits
  it('ends with the address blocked and no request that waits, the steps in any order', async () => {
    for (let round = 0; round < 4; round += 1) {
      const addresses = [0, 1].map(() => {
        const email = uniqueEmail('race');
        return { email, args: requestArgs({ email }) };
      });
      for (const { args } of addresses) blockedHmacs.push(args.emailHmac);

      const answers = await Promise.all(
        addresses.flatMap(({ args }) => [
          inCommittedTx(async (db) => outcomeOf(await requestAs(db, GUEST(), args))),
          inCommittedTx(async (db) =>
            outcomeOf(await requestAs(db, GUEST(), { ...args, confirmHash: hex64() })),
          ),
          inCommittedTx(
            async (db) =>
              codeOf(await attemptAs(db, MANAGER(), SQL.blockAdd, args.emailHmac, 'asked')) ??
              'done',
          ),
        ]),
      );

      // no step was refused, and none lost a lock to another (a deadlock is 40P01)
      expect(answers.filter((answer) => answer.startsWith('refused'))).toEqual([]);

      for (const { email, args } of addresses) {
        expect(await rowsOf(email)).toEqual([]);
        expect(await blocked(args.emailHmac)).toHaveLength(1);
      }
    }
  });
});
