import type { Prisma } from '@prisma/client';

import { getPgCode, getPgMessage, prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';

// test data the app itself would not let a test make: users, products and tokens are
// admin-only under rls, so a test creates and inspects its own rows as admin
export const asAdmin = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
  prisma.$transaction(async (tx) => {
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
        maxWait: 10_000,
        timeout: 30_000,
        ...(opts.isolationLevel ? { isolationLevel: opts.isolationLevel } : {}),
      },
    );
  } catch (err) {
    if (!(err instanceof RolledBack)) throw err;
  }

  return result;
}
