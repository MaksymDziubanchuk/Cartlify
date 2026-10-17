import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import env from '@config/env.js';
import { ResourceBusyError } from '@utils/errors.js';

import type { PoolConfig } from 'pg';

// prisma 7 talks to postgres through the pg driver. DATABASE_URL keeps the parameters prisma 6
// read itself; pg does not know them, so they are taken off the url and passed as options:
// schema goes to the adapter (it qualifies the tables of model queries, raw sql relies on the
// role search_path from db/schema/01), connection_limit and pool_timeout go to the pool.
// sslmode=require/prefer meant "encrypt, do not verify the certificate" in prisma 6, newer pg
// reads it as "verify", so it becomes the same explicit setting
export function parseDatabaseUrl(databaseUrl: string): { pool: PoolConfig; schema?: string } {
  let url: URL;

  try {
    url = new URL(databaseUrl);
  } catch {
    // never the url itself: it holds the password
    throw new Error('DATABASE_URL is not a valid url');
  }

  const params = url.searchParams;
  const schema = params.get('schema') ?? undefined;
  const connectionLimit = Number(params.get('connection_limit'));
  const poolTimeoutSec = Number(params.get('pool_timeout'));
  const sslmode = params.get('sslmode');

  for (const key of ['schema', 'connection_limit', 'pool_timeout']) params.delete(key);
  if (sslmode === 'require' || sslmode === 'prefer') params.delete('sslmode');

  const pool: PoolConfig = {
    connectionString: url.toString(),
    // prisma 6 waited 5 seconds for a connection by default, pg waits forever
    connectionTimeoutMillis: poolTimeoutSec > 0 ? poolTimeoutSec * 1000 : 5000,
    ...(connectionLimit > 0 ? { max: connectionLimit } : {}),
    ...(sslmode === 'require' || sslmode === 'prefer'
      ? { ssl: { rejectUnauthorized: false } }
      : {}),
  };

  return schema ? { pool, schema } : { pool };
}

function buildAdapter(databaseUrl: string): PrismaPg {
  const { pool, schema } = parseDatabaseUrl(databaseUrl);

  return new PrismaPg(pool, schema ? { schema } : undefined);
}

export const prisma = new PrismaClient({ adapter: buildAdapter(env.DATABASE_URL) });

type TxOptions = {
  maxRetries?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
  maxWait?: number;
  timeout?: number;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// the postgres error behind a prisma error. With the pg adapter (prisma 7) it is in
// meta.driverAdapterError.cause as originalCode and originalMessage; meta.code and
// meta.message were the prisma 6 places, kept so both shapes read the same
function getPgCause(err: unknown): Record<string, unknown> | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null;

  const meta = (err.meta ?? {}) as Record<string, unknown>;
  const adapterError = meta.driverAdapterError as { cause?: Record<string, unknown> } | undefined;

  return { ...meta, ...(adapterError?.cause ?? {}) };
}

// postgres error code, like 23505 for a unique violation or 55P03 for a lock timeout
export function getPgCode(err: unknown): string | null {
  const cause = getPgCause(err);
  if (!cause) return null;

  const code = [cause.originalCode, cause.code, cause.database_error_code, cause.error_code].find(
    (value) => typeof value === 'string' && value.length > 0,
  );

  return (code as string | undefined) ?? null;
}

// postgres error text, like the message a db function raises (ORDER_NOT_FOUND)
export function getPgMessage(err: unknown): string | null {
  const cause = getPgCause(err);
  if (!cause) return null;

  const message = [cause.originalMessage, cause.message].find(
    (value) => typeof value === 'string' && value.length > 0,
  );

  return (message as string | undefined) ?? null;
}

export function isRetryableTxError(err: unknown): boolean {
  // Prisma write conflict / deadlock
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') return true;

  // Postgres concurrency/lock signals (often via P2010 from $queryRaw)
  const pg = getPgCode(err);
  if (!pg) return false;

  return pg === '55P03' || pg === '57014' || pg === '40P01' || pg === '40001';
}

function buildTxOptions(opts: TxOptions): TxOptions | undefined {
  const txOpts: TxOptions = {};

  if (opts.isolationLevel !== undefined) txOpts.isolationLevel = opts.isolationLevel;
  if (opts.maxWait !== undefined) txOpts.maxWait = opts.maxWait;
  if (opts.timeout !== undefined) txOpts.timeout = opts.timeout;

  return Object.keys(txOpts).length ? txOpts : undefined;
}

export async function tx<T>(
  fn: (db: Prisma.TransactionClient) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  const { maxRetries = 3 } = opts;
  const txOpts = buildTxOptions(opts);

  let attempt = 0;

  while (true) {
    try {
      return txOpts ? await prisma.$transaction(fn, txOpts) : await prisma.$transaction(fn);
    } catch (err) {
      if (!isRetryableTxError(err)) throw err;

      if (attempt >= maxRetries) {
        throw new ResourceBusyError(
          {
            attempts: attempt + 1,
            maxRetries,
            pgCode: getPgCode(err),
            prismaCode: err instanceof Prisma.PrismaClientKnownRequestError ? err.code : undefined,
          },
          err,
        );
      }

      const backoff = 25 * 2 ** attempt + Math.floor(Math.random() * 25);
      await sleep(backoff);
      attempt += 1;
    }
  }
}
