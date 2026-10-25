import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// the sweep of the reservations the timers of redis missed: it reads them from the database and
// releases each with cartlify.expire_order_reservation. The database is replaced here: the
// integration tests share one database, and a sweep there would release the reservations other
// files keep over on purpose (a late payment, an expired page)
const findMany = jest.fn<(args: unknown) => Promise<Array<{ id: number }>>>();
const queryRaw =
  jest.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>>();
const setAdminContext = jest.fn<(db: unknown) => Promise<void>>();
const db = { order: { findMany }, $queryRaw: queryRaw };

jest.unstable_mockModule('@db/client.js', () => ({
  prisma: { $transaction: (fn: (tx: typeof db) => Promise<unknown>) => fn(db) },
}));
jest.unstable_mockModule('@db/dbContext.service.js', () => ({ setAdminContext }));
jest.unstable_mockModule('@redis/client.js', () => ({ getRedis: jest.fn() }));
jest.unstable_mockModule('@routes/api/payments/providers/index.js', () => ({
  getPaymentProvider: jest.fn(),
}));

const { processMissedOrderReservationExpiries } =
  await import('@routes/api/orders/services/helpers/orderTimeoutQueue.helper.js');

const NOW = new Date('2026-10-24T12:00:00.000Z');

const workerLog = () => ({
  info: jest.fn<(obj: unknown, msg?: string) => void>(),
  warn: jest.fn<(obj: unknown, msg?: string) => void>(),
  error: jest.fn<(obj: unknown, msg?: string) => void>(),
});

// the order a call of the database function released, and its answer
const releasing = (answers: Record<number, boolean | Error>) =>
  queryRaw.mockImplementation(async (_strings, orderId) => {
    const answer = answers[orderId as number];
    if (answer instanceof Error) throw answer;
    return [{ expired: answer }];
  });

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  findMany.mockReset();
  queryRaw.mockReset();
  setAdminContext.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('processMissedOrderReservationExpiries', () => {
  it('reads the confirmed waiting orders whose reservation ended over 5 minutes ago, the oldest first', async () => {
    findMany.mockResolvedValue([]);

    await processMissedOrderReservationExpiries(workerLog(), 25);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        confirmed: true,
        status: 'waiting',
        reservationExpiresAt: { lt: new Date(NOW.getTime() - 300_000) },
      },
      select: { id: true },
      orderBy: { reservationExpiresAt: 'asc' },
      take: 25,
    });
  });

  it('releases each and counts the ones the database released', async () => {
    findMany.mockResolvedValue([{ id: 11 }, { id: 12 }, { id: 13 }]);
    // 12 changed meanwhile: paid, or released by its timer
    releasing({ 11: true, 12: false, 13: true });
    const log = workerLog();

    expect(await processMissedOrderReservationExpiries(log, 100)).toBe(2);

    expect(queryRaw.mock.calls.map((call) => call[1])).toEqual([11, 12, 13]);
    expect(log.error).not.toHaveBeenCalled();
  });

  // the database functions of the reservations take the system only
  it('reads and releases as the system', async () => {
    findMany.mockResolvedValue([{ id: 21 }, { id: 22 }]);
    releasing({ 21: true, 22: true });

    await processMissedOrderReservationExpiries(workerLog(), 100);

    expect(setAdminContext).toHaveBeenCalledTimes(3);
  });

  it('goes on after an order that fails, with an error of its own in the log', async () => {
    findMany.mockResolvedValue([{ id: 31 }, { id: 32 }, { id: 33 }]);
    releasing({
      31: true,
      32: Object.assign(new Error('lock timeout'), { code: 'P2010' }),
      33: true,
    });
    const log = workerLog();

    expect(await processMissedOrderReservationExpiries(log, 100)).toBe(2);

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 32 }),
      'missed order reservation expiry failed',
    );
  });

  // the log gets the kind and the code of a failure, not its text: an error of a connection quotes
  // the address of the database
  it('writes no text of the failure to the log', async () => {
    findMany.mockResolvedValue([{ id: 41 }]);
    releasing({ 41: new Error('connect ECONNREFUSED 10.0.0.5:5432') });
    const log = workerLog();

    await processMissedOrderReservationExpiries(log, 100);

    expect(JSON.stringify(log.error.mock.calls)).not.toContain('10.0.0.5');
  });

  it('releases nothing when nothing is overdue', async () => {
    findMany.mockResolvedValue([]);

    expect(await processMissedOrderReservationExpiries(workerLog(), 100)).toBe(0);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
