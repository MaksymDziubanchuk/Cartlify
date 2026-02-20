import { Prisma, PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

type TxOptions = {
  maxRetries?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
  maxWait?: number;
  timeout?: number;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function getPgCode(err: unknown): string | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null;

  const meta = err.meta as Record<string, unknown> | undefined;

  const code =
    (typeof meta?.code === 'string' && meta.code) ||
    (typeof meta?.database_error_code === 'string' && meta.database_error_code) ||
    (typeof meta?.error_code === 'string' && meta.error_code) ||
    null;

  return code;
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
      if (!isRetryableTxError(err) || attempt >= maxRetries) throw err;

      const backoff = 25 * 2 ** attempt + Math.floor(Math.random() * 25);
      await sleep(backoff);
      attempt += 1;
    }
  }
}
