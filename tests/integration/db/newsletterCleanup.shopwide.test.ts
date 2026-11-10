import { afterAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inCommittedTx, inRolledBackTx, type DbSession } from '../../helpers/db.js';
import { deferred, waitsForLock } from '../../helpers/interleave.js';
import {
  eventRow,
  hex64,
  insertRow,
  insertSubscription,
  removeSubscriptionRows,
} from '../../helpers/newsletterDb.js';
import {
  AGENT,
  IP,
  GUEST,
  READER,
  SQL,
  SYSTEM,
  attemptAs,
  callAs,
  codeOf,
  journalOf,
  subscriptionById,
} from '../../helpers/newsletterFns.js';
import { inOwnerTx } from '../../helpers/ownerDb.js';

// the cleanup of the requests that were not confirmed in time works on the whole table, so a case that
// commits it takes away the expired requests of the other files: this file is shop-wide, it runs
// alone, after the others (tests/setup/integration.shopState.ts)

const subscriptionIds: number[] = [];

afterAll(async () => {
  try {
    await removeSubscriptionRows(subscriptionIds);
  } finally {
    await prisma.$disconnect();
  }
});

describe('the cleanup of the requests against the confirmation of one', () => {
  // the deadline of the request passes between the moment the transaction of the confirmation
  // began (the clock a transaction keeps) and the moment it reads the row: the confirmation sees a
  // request that is in time, the cleanup one that is not. Each of them ends it, none ends it twice
  async function expiringRequest() {
    const confirmHash = hex64();
    const id = await inOwnerTx(
      async (db) => {
        const [soon] = await db.rows<{ at: string }>(
          `select ((now() at time zone 'utc') + interval '2 seconds')::text as at`,
        );
        const row = await insertSubscription(db, {
          status: 'pending',
          locale: 'es',
          set: { confirmHash, confirmExpiresAt: soon!.at },
        });
        await insertRow(db, 'newsletter_subscription_events', eventRow(row));
        return row;
      },
      { commit: true },
    );
    subscriptionIds.push(id);
    return { id, confirmHash };
  }

  // waits, in a session of its own, until the deadline of the request has gone by
  const pastDeadline = (id: number) =>
    inRolledBackTx((db) =>
      callAs(
        db,
        READER,
        `select 1 as ok from pg_sleep(greatest(0, extract(epoch from (
           (select "confirmExpiresAt" from cartlify.newsletter_subscriptions where id = $1)
           - (clock_timestamp() at time zone 'utc')
         )) + 0.3))`,
        id,
      ),
    );

  const cleanup = async (db: DbSession) => {
    const outcome = await attemptAs<{ removed: number }>(
      db,
      SYSTEM,
      'select cartlify.cleanup_newsletter_pending() as removed',
    );
    return outcome.ok ? Number(outcome.rows[0]!.removed) : codeOf(outcome);
  };

  it('ends the request once when the cleanup comes first: the confirmation that waited finds none', async () => {
    const request = await expiringRequest();
    const opened = deferred<number>();
    const proceed = deferred();

    // the confirmation begins its transaction while the request is in time, and waits
    const confirming = inCommittedTx(async (db) => {
      const [row] = await db.rows<{ pid: number }>('select pg_backend_pid() as pid, now()');
      opened.resolve(row!.pid);
      await proceed.promise;
      return callAs(db, GUEST(), SQL.confirm, request.confirmHash, IP, AGENT);
    });
    confirming.catch(() => undefined);
    const confirmingPid = await opened.promise;
    await pastDeadline(request.id);

    // the cleanup holds the request (ended, not yet removed for good) while the confirmation asks
    const held = deferred();
    const release = deferred();
    const cleaning = inCommittedTx(async (db) => {
      const removed = await cleanup(db);
      held.resolve();
      await release.promise;
      return removed;
    });
    cleaning.catch(() => undefined);
    await held.promise;
    proceed.resolve();

    try {
      await waitsForLock(confirmingPid);
    } finally {
      release.resolve();
    }

    const [removed, confirmed] = [await cleaning, await confirming];
    expect(Number(removed)).toBeGreaterThanOrEqual(1);
    expect(confirmed).toEqual([{ outcome: 'invalid', locale: null }]);
    expect(await inRolledBackTx((db) => subscriptionById(db, request.id))).toBeNull();
  });

  it('keeps the subscription the confirmation made when it comes first: the cleanup that waited skips it', async () => {
    const request = await expiringRequest();
    const opened = deferred();
    const proceed = deferred();
    const held = deferred();
    const release = deferred();

    const confirming = inCommittedTx(async (db) => {
      await db.rows('select now() as began');
      opened.resolve();
      await proceed.promise;
      const answer = await callAs(db, GUEST(), SQL.confirm, request.confirmHash, IP, AGENT);
      held.resolve();
      await release.promise;
      return answer;
    });
    confirming.catch(() => undefined);
    await opened.promise;
    await pastDeadline(request.id);

    // the confirmation reads the request with the clock of its start and takes it
    proceed.resolve();
    await held.promise;

    // the cleanup, begun after the deadline, waits for the row the confirmation holds
    const pid = deferred<number>();
    const cleaning = inCommittedTx(async (db) => {
      const [row] = await db.rows<{ pid: number }>('select pg_backend_pid() as pid');
      pid.resolve(row!.pid);
      return cleanup(db);
    });
    cleaning.catch(() => undefined);

    try {
      await waitsForLock(await pid.promise);
    } finally {
      release.resolve();
    }

    const confirmed = await confirming;
    await cleaning;
    expect(confirmed).toEqual([{ outcome: 'confirmed', locale: 'es' }]);

    const state = await inRolledBackTx(async (db) => {
      const [row] = await callAs<{ status: string }>(
        db,
        READER,
        'select status::text as status from cartlify.newsletter_subscriptions where id = $1',
        request.id,
      );
      return { row, lines: (await journalOf(db, request.id)).map((line) => line.event) };
    });
    expect(state.row).toEqual({ status: 'active' });
    expect(state.lines).toEqual(['requested', 'confirmed']);
  });
});
