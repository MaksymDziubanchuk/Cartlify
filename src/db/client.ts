import { Prisma, PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

type TxOptions = {
  maxRetries?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
  maxWait?: number;
  timeout?: number;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryableTxError(err: unknown): boolean {
  // Prisma: write conflict / deadlock → “retry the transaction”
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';
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
