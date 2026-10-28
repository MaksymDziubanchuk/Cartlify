import type { Prisma } from '@prisma/client';

import { getPgCode, getPgMessage, prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';

// the time a transaction of the tests may take. The 5 s prisma gives by default run out on a busy
// machine, and prisma then runs the rest of a nested write outside the transaction, with no
// context: the test fails with a refusal of rls instead of a timeout
export const TEST_TX = { maxWait: 10_000, timeout: 30_000 } as const;

export const testTx = <T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts: {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
  } = {},
): Promise<T> => prisma.$transaction(fn, { ...TEST_TX, ...opts });

// test data the app itself would not let a test make: users, products and tokens are
// admin-only under rls, so a test creates and inspects its own rows as admin
export const asAdmin = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
  testTx(async (tx) => {
    await setAdminContext(tx);
    return fn(tx);
  });

// the actor a statement runs for, the way the app sets it with cartlify.set_current_context
export type Actor =
  | { role: 'GUEST'; guestId?: string | null; userId?: number | null }
  | { role: 'USER' | 'ADMIN' | 'ROOT'; userId?: number | null; guestId?: string | null };

// what a statement gave: its rows, or the postgres error it stopped with
export type Outcome<T = Record<string, unknown>> =
  { ok: true; rows: T[] } | { ok: false; code: string | null; message: string | null };

export type DbSession = {
  // the actor of the statements that follow; null sets the context to none
  as(actor: Actor | null): Promise<void>;
  // rows of a statement that has to work; $1, $2 take the values. Prisma cannot read a column of
  // type void: a function that returns nothing is called as select 1 from cartlify.fn(...)
  rows<T = Record<string, unknown>>(query: string, ...values: unknown[]): Promise<T[]>;
  // a statement the database may refuse: it runs in a savepoint, so a refusal leaves the
  // transaction usable for the next statement
  attempt<T = Record<string, unknown>>(query: string, ...values: unknown[]): Promise<Outcome<T>>;
};

class RolledBack extends Error {}

let savepoints = 0;

function sessionOf(tx: Prisma.TransactionClient): DbSession {
  return {
    async as(actor) {
      await tx.$executeRawUnsafe(
        'select cartlify.set_current_context($1::cartlify."Role", $2::int, $3::uuid)',
        actor?.role ?? null,
        actor?.userId ?? null,
        actor?.guestId ?? null,
      );
    },
    rows: (query, ...values) => tx.$queryRawUnsafe(query, ...values),
    async attempt(query, ...values) {
      const name = `attempt_${++savepoints}`;
      await tx.$executeRawUnsafe(`savepoint ${name}`);

      try {
        const rows = await tx.$queryRawUnsafe<never[]>(query, ...values);
        await tx.$executeRawUnsafe(`release savepoint ${name}`);
        return { ok: true, rows };
      } catch (err) {
        await tx.$executeRawUnsafe(`rollback to savepoint ${name}`);
        return { ok: false, code: getPgCode(err), message: getPgMessage(err) };
      }
    },
  };
}

// the same statements in a transaction that commits: rows a later transaction has to find made
// before it, at an earlier time of the database (a cart created before it is paid)
export const inCommittedTx = <T>(fn: (db: DbSession) => Promise<T>): Promise<T> =>
  testTx((tx) => fn(sessionOf(tx)));

// the rules of the database checked straight under cartlify_app, the role the app connects as:
// everything runs in one transaction that is always rolled back, nothing the test does stays.
// A test that compares what several statements see of shared tables takes repeatable read: the
// other test files commit and delete their rows meanwhile, one snapshot keeps the counts fair
export async function inRolledBackTx<T>(
  fn: (db: DbSession) => Promise<T>,
  opts: { isolationLevel?: Prisma.TransactionIsolationLevel } = {},
): Promise<T> {
  let result!: T;

  try {
    await prisma.$transaction(
      async (tx) => {
        result = await fn(sessionOf(tx));
        throw new RolledBack();
      },
      {
        ...TEST_TX,
        ...(opts.isolationLevel ? { isolationLevel: opts.isolationLevel } : {}),
      },
    );
  } catch (err) {
    if (!(err instanceof RolledBack)) throw err;
  }

  return result;
}
