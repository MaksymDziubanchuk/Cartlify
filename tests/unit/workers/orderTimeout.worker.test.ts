import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// the steps of the queue are replaced, the worker itself is real: its timers, its stop and pulse.
// The steps themselves are checked against redis and the database in
// tests/integration/worker/orderTimeout.test.ts
const base = jest.fn<(log: unknown, batch: number) => Promise<number>>();
const grace = jest.fn<(log: unknown, batch: number) => Promise<number>>();
const missed = jest.fn<(log: unknown, batch: number) => Promise<number>>();
const queued = jest.fn<() => Promise<number>>();

jest.unstable_mockModule('../../../src/routes/api/orders/services/helpers/index.js', () => ({
  processClaimedOrderReservationBase: base,
  processClaimedOrderReservationExpiries: grace,
  processMissedOrderReservationExpiries: missed,
  countQueuedOrderReservationJobs: queued,
}));
jest.unstable_mockModule('@redis/client.js', () => ({ isRedisReady: () => true }));

const worker = await import('../../../src/workers/orderTimeout.worker.js');

const log = () => ({
  info: jest.fn<(obj: unknown, msg?: string) => void>(),
  warn: jest.fn<(obj: unknown, msg?: string) => void>(),
  error: jest.fn<(obj: unknown, msg?: string) => void>(),
});

// a step of the queue that ends when the test lets it
function heldStep() {
  let release: () => void = () => {};
  const done = new Promise<number>((resolve) => (release = () => resolve(0)));
  return { done, release };
}

beforeEach(() => {
  jest.useFakeTimers();
  base.mockReset().mockResolvedValue(0);
  grace.mockReset().mockResolvedValue(0);
  missed.mockReset().mockResolvedValue(0);
  queued.mockReset().mockResolvedValue(0);
});

afterEach(async () => {
  await worker.stopOrderTimeoutWorker();
  jest.useRealTimers();
});

describe('the order timeout worker', () => {
  it('has no pulse before it runs', async () => {
    expect(await worker.orderTimeoutWorkerPulse()).toEqual({ lastRunAt: null, queued: 0 });
  });

  // the pulse goes to /health: a worker that stopped quietly shows an old time
  it('tells when it last ran and how many jobs wait', async () => {
    queued.mockResolvedValue(7);
    worker.startOrderTimeoutWorker(log());

    await jest.advanceTimersByTimeAsync(3_000);

    const pulse = await worker.orderTimeoutWorkerPulse();
    expect(pulse.queued).toBe(7);
    expect(pulse.lastRunAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(pulse.lastRunAt!))).toBe(false);
  });

  // the server closes redis and the database after the stop: a step in the middle would fail
  it('stops only after the step that is running ends', async () => {
    const step = heldStep();
    base.mockReturnValueOnce(step.done);
    worker.startOrderTimeoutWorker(log());
    await jest.advanceTimersByTimeAsync(3_000);
    expect(base).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stop = worker.stopOrderTimeoutWorker().then(() => (stopped = true));
    await jest.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    step.release();
    await stop;
    expect(stopped).toBe(true);
  });

  it('runs no step after the stop', async () => {
    worker.startOrderTimeoutWorker(log());
    await worker.stopOrderTimeoutWorker();

    await jest.advanceTimersByTimeAsync(120_000);

    expect(base).not.toHaveBeenCalled();
    expect(missed).not.toHaveBeenCalled();
  });

  it('logs a failed run once and goes on with the next one', async () => {
    const logger = log();
    base.mockRejectedValueOnce(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }));
    worker.startOrderTimeoutWorker(logger);

    await jest.advanceTimersByTimeAsync(6_000);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      { type: 'Error', code: 'ECONNRESET' },
      'order timeout worker failed',
    );
    expect(base).toHaveBeenCalledTimes(2);
  });
});
