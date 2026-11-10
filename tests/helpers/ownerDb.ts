import pg from 'pg';

import type { Actor, Outcome } from './db.js';

// a connection to the test database as cartlify_owner, the role the functions of the database run
// as (security definer) and the owner of every table. The tests of the app connect as cartlify_app,
// which cannot take a step the database keeps for its own functions: writing a row of a table it may
// only read, or a change only the owner is let make. This session takes such a step by hand, in a
// transaction of its own. The rules of a table (rls, the guards, the checks) apply to the owner as
// to anybody: the owner is held by the policies because they are forced (db/03)

export type OwnerSession = {
  // the actor of the statements that follow, the way a function would find it
  as(actor: Actor | null): Promise<void>;
  // rows of a statement that has to work
  rows<T = Record<string, unknown>>(query: string, ...values: unknown[]): Promise<T[]>;
  // a statement the database may refuse: it runs in a savepoint, so a refusal leaves the
  // transaction usable for the next statement
  attempt<T = Record<string, unknown>>(query: string, ...values: unknown[]): Promise<Outcome<T>>;
};

// the roles of the test database whose password is their name
type SessionRole = 'cartlify_owner' | 'cartlify_readonly';

function roleClient(role: SessionRole): pg.Client {
  const url = new URL(process.env.DATABASE_URL ?? '');
  url.username = role;
  url.password = role;
  // the schema is named in every statement
  url.search = '';

  return new pg.Client({ connectionString: url.toString() });
}

let savepoints = 0;

// one transaction as the role given: rolled back at its end, or committed when the test needs rows
// that the app role finds afterwards. The statements go one after another on the one connection
export async function inRoleTx<T>(
  role: SessionRole,
  fn: (db: OwnerSession) => Promise<T>,
  opts: { commit?: boolean } = {},
): Promise<T> {
  const client = roleClient(role);
  await client.connect();

  const session: OwnerSession = {
    async as(actor) {
      await client.query(
        'select cartlify.set_current_context($1::cartlify."Role", $2::int, $3::uuid)',
        [actor?.role ?? null, actor?.userId ?? null, actor?.guestId ?? null],
      );
    },
    async rows<R>(query: string, ...values: unknown[]) {
      const result = await client.query(query, values);
      return result.rows as R[];
    },
    async attempt<R>(query: string, ...values: unknown[]) {
      const name = `attempt_${++savepoints}`;
      await client.query(`savepoint ${name}`);

      try {
        const result = await client.query(query, values);
        await client.query(`release savepoint ${name}`);
        return { ok: true as const, rows: result.rows as R[] };
      } catch (err) {
        await client.query(`rollback to savepoint ${name}`);
        const { code, message } = err as { code?: string; message?: string };
        return { ok: false as const, code: code ?? null, message: message ?? null };
      }
    },
  };

  try {
    await client.query('begin');
    const result = await fn(session);
    await client.query(opts.commit ? 'commit' : 'rollback');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

// the same as the owner of the database
export const inOwnerTx = <T>(
  fn: (db: OwnerSession) => Promise<T>,
  opts: { commit?: boolean } = {},
): Promise<T> => inRoleTx('cartlify_owner', fn, opts);

// the same as cartlify_readonly, the role for reading by hand: it has no actor, so it sets no context
export const inReadonlyTx = <T>(fn: (db: OwnerSession) => Promise<T>): Promise<T> =>
  inRoleTx('cartlify_readonly', fn);
