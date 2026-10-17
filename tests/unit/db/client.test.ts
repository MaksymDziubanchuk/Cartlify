import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import { getPgCode, getPgMessage, isRetryableTxError, parseDatabaseUrl } from '@db/client.js';

import { thrownBy } from '../../helpers/errors.js';

const base = 'postgresql://app:secret-pass@db.example.test:5432/shop';

// a prisma error the way the pg adapter of prisma 7 builds it for a failed raw query
const adapterError = (code: string, message: string, prismaCode = 'P2010') =>
  new Prisma.PrismaClientKnownRequestError(`Raw query failed. Code: \`${code}\``, {
    code: prismaCode,
    clientVersion: '7.10.1',
    meta: {
      driverAdapterError: {
        cause: { originalCode: code, originalMessage: message, kind: 'postgres' },
      },
    },
  });

// the same error the way prisma 6 put it
const legacyError = (code: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError('Raw query failed', {
    code: 'P2010',
    clientVersion: '6.19.3',
    meta: { code, message },
  });

describe('parseDatabaseUrl', () => {
  it('takes the prisma schema parameter off the url and gives it to the adapter', () => {
    const { pool, schema } = parseDatabaseUrl(`${base}?schema=cartlify`);

    expect(schema).toBe('cartlify');
    expect(pool.connectionString).toBe(base);
  });

  it('turns connection_limit and pool_timeout into pool settings', () => {
    const { pool } = parseDatabaseUrl(`${base}?schema=cartlify&connection_limit=7&pool_timeout=20`);

    expect(pool).toMatchObject({ max: 7, connectionTimeoutMillis: 20_000 });
    expect(pool.connectionString).toBe(base);
  });

  // prisma 6 waited 5 seconds for a connection, pg alone would wait forever
  it('waits 5 seconds for a connection when the url sets no timeout', () => {
    const { pool } = parseDatabaseUrl(base);

    expect(pool.connectionTimeoutMillis).toBe(5000);
    expect(pool).not.toHaveProperty('max');
  });

  it.each(['require', 'prefer'])(
    'keeps sslmode=%s meaning "encrypt without checking the certificate", as in prisma 6',
    (sslmode) => {
      const { pool } = parseDatabaseUrl(`${base}?sslmode=${sslmode}`);

      expect(pool.ssl).toEqual({ rejectUnauthorized: false });
      expect(pool.connectionString).toBe(base);
    },
  );

  it.each(['disable', 'verify-full'])('leaves sslmode=%s to pg as it is', (sslmode) => {
    const { pool } = parseDatabaseUrl(`${base}?sslmode=${sslmode}`);

    expect(pool).not.toHaveProperty('ssl');
    expect(pool.connectionString).toBe(`${base}?sslmode=${sslmode}`);
  });

  it('keeps the parameters pg knows', () => {
    expect(parseDatabaseUrl(`${base}?application_name=cartlify`).pool.connectionString).toBe(
      `${base}?application_name=cartlify`,
    );
  });

  // the url holds the password, an error must not quote it
  it('rejects a url that is not a url without quoting it', () => {
    const err = thrownBy(() => parseDatabaseUrl('postgres//app:secret-pass@db'));

    expect((err as Error).message).toBe('DATABASE_URL is not a valid url');
    expect(String((err as Error).message)).not.toContain('secret-pass');
  });
});

describe('getPgCode and getPgMessage', () => {
  it('read the postgres code and text from a prisma 7 adapter error', () => {
    const err = adapterError('P0001', 'ORDER_NOT_FOUND');

    expect(getPgCode(err)).toBe('P0001');
    expect(getPgMessage(err)).toBe('ORDER_NOT_FOUND');
  });

  it('read a unique violation of a raw insert, as register needs it', () => {
    expect(getPgCode(adapterError('23505', 'duplicate key value'))).toBe('23505');
  });

  it('read the prisma 6 shape too', () => {
    const err = legacyError('23505', 'duplicate key value');

    expect(getPgCode(err)).toBe('23505');
    expect(getPgMessage(err)).toBe('duplicate key value');
  });

  it('give null for an error that is not a prisma request error', () => {
    expect(getPgCode(new Error('x'))).toBeNull();
    expect(getPgMessage(new Error('x'))).toBeNull();
  });

  it('give null when the prisma error has no postgres cause', () => {
    const err = new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: '7.10.1',
      meta: { modelName: 'Category' },
    });

    expect(getPgCode(err)).toBeNull();
  });
});

describe('isRetryableTxError', () => {
  it.each([
    ['a lock timeout', '55P03'],
    ['a statement timeout', '57014'],
    ['a deadlock', '40P01'],
    ['a serialization failure', '40001'],
  ])('retries %s reported by the pg adapter', (_case, code) => {
    expect(isRetryableTxError(adapterError(code, 'busy'))).toBe(true);
  });

  it('retries a prisma write conflict', () => {
    const err = new Prisma.PrismaClientKnownRequestError('Write conflict', {
      code: 'P2034',
      clientVersion: '7.10.1',
    });

    expect(isRetryableTxError(err)).toBe(true);
  });

  it.each([
    ['a unique violation', '23505'],
    ['an error a db function raised', 'P0001'],
  ])('does not retry %s', (_case, code) => {
    expect(isRetryableTxError(adapterError(code, 'no'))).toBe(false);
  });
});
