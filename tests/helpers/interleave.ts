import { inCommittedTx, inRolledBackTx, type DbSession } from './db.js';

// two sessions of the app role at the same time, each in a transaction of its own that commits, to
// try the order in which a step can slip past another (tests of the database that need a lock)

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// the backend of a session is waiting for a lock another session holds
export async function waitsForLock(pid: number, ms = 4000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 50) {
    const rows = await inRolledBackTx((db) =>
      db.rows(
        `select 1 as waiting from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`,
        pid,
      ),
    );
    if (rows.length > 0) return;
    await sleep(50);
  }
  throw new Error('the second session did not wait for the first');
}

// `first` runs in a transaction that stays open; `second` starts in another and has to wait for
// something the first holds; when it does, the first commits. Both answers come back
export async function interleave<A, B>(
  first: (db: DbSession) => Promise<A>,
  second: (db: DbSession) => Promise<B>,
): Promise<{ first: A; second: B }> {
  const held = deferred();
  const release = deferred();
  const pid = deferred<number>();

  const one = inCommittedTx(async (db) => {
    try {
      const answer = await first(db);
      held.resolve();
      await release.promise;
      return answer;
    } catch (err) {
      held.reject(err);
      throw err;
    }
  });
  one.catch(() => undefined);
  await held.promise;

  const two = inCommittedTx(async (db) => {
    const [row] = await db.rows<{ pid: number }>('select pg_backend_pid() as pid');
    pid.resolve(row!.pid);
    return second(db);
  });
  two.catch(() => undefined);

  try {
    await waitsForLock(await pid.promise);
  } finally {
    release.resolve();
  }

  return { first: await one, second: await two };
}
