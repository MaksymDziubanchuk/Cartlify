import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { createShutdown } from '@helpers/shutdown.js';

const log = () => ({
  info: jest.fn<(obj: unknown, msg?: string) => void>(),
  error: jest.fn<(obj: unknown, msg?: string) => void>(),
});

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('createShutdown', () => {
  it('runs the steps in their order and exits with 0', async () => {
    const order: string[] = [];
    const exit = jest.fn<(code: number) => void>();

    const shutdown = createShutdown({
      steps: [() => void order.push('worker'), async () => void order.push('app')],
      deadlineMs: 10_000,
      log: log(),
      exit,
    });

    await shutdown('SIGTERM');

    expect(order).toEqual(['worker', 'app']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits with 1 when a step fails, without running the next ones', async () => {
    const exit = jest.fn<(code: number) => void>();
    const later = jest.fn<() => void>();
    const logger = log();

    const shutdown = createShutdown({
      steps: [
        async () => {
          throw new Error('redis would not close');
        },
        later,
      ],
      deadlineMs: 10_000,
      log: logger,
      exit,
    });

    await shutdown('SIGINT');

    expect(later).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), 'shutdown failed');
  });

  // a request or a worker step that never ends must not keep the old process alive on deploy
  it('exits with 1 when the steps take longer than the deadline', async () => {
    const exit = jest.fn<(code: number) => void>();
    const logger = log();

    const shutdown = createShutdown({
      steps: [() => new Promise<void>(() => {})],
      deadlineMs: 10_000,
      log: logger,
      exit,
    });

    void shutdown('SIGTERM');

    await jest.advanceTimersByTimeAsync(9_999);
    expect(exit).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      { deadlineMs: 10_000 },
      'shutdown took longer than its deadline, exiting',
    );
  });

  it('does not exit twice when the steps end after the deadline', async () => {
    const exit = jest.fn<(code: number) => void>();
    let finish: () => void = () => {};

    const shutdown = createShutdown({
      steps: [() => new Promise<void>((resolve) => (finish = resolve))],
      deadlineMs: 1_000,
      log: log(),
      exit,
    });

    const done = shutdown('SIGTERM');
    await jest.advanceTimersByTimeAsync(1_000);
    finish();
    await done;

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  // the first signal runs the steps; a second one (ctrl+c again) means stop now
  it('exits at once with 1 on a second signal', async () => {
    const exit = jest.fn<(code: number) => void>();
    const step = jest.fn(() => new Promise<void>(() => {}));

    const shutdown = createShutdown({ steps: [step], deadlineMs: 10_000, log: log(), exit });

    void shutdown('SIGINT');
    await shutdown('SIGINT');

    expect(step).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
