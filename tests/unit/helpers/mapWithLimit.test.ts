import { describe, expect, it } from '@jest/globals';

import { mapWithLimit } from '@helpers/mapWithLimit.js';

// the calls to a provider go a few at a time: all of them at once would be a burst it may refuse

const later = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('mapWithLimit', () => {
  it('gives the results in the order of the items, whatever order they finish in', async () => {
    const results = await mapWithLimit([30, 1, 15, 5], 2, async (ms, index) => {
      await later(ms);
      return `${index}:${ms}`;
    });

    expect(results).toEqual(['0:30', '1:1', '2:15', '3:5']);
  });

  it('runs no more than the limit at once, and as many as the limit when there are enough', async () => {
    let running = 0;
    let most = 0;

    await mapWithLimit(
      Array.from({ length: 10 }, (_, i) => i),
      4,
      async () => {
        running += 1;
        most = Math.max(most, running);
        await later(5);
        running -= 1;
      },
    );

    expect(most).toBe(4);
  });

  it('starts the next one as soon as one is done', async () => {
    const started: number[] = [];
    const release: Array<() => void> = [];

    const done = mapWithLimit([0, 1, 2], 2, (item) => {
      started.push(item);
      return new Promise<void>((resolve) => release.push(resolve));
    });
    await later(5);
    expect(started).toEqual([0, 1]);

    release[0]!();
    await later(5);
    expect(started).toEqual([0, 1, 2]);

    release[1]!();
    release[2]!();
    await done;
  });

  it('takes a limit higher than the number of items', async () => {
    expect(await mapWithLimit([1, 2], 10, async (n) => n * 2)).toEqual([2, 4]);
  });

  it('takes no items', async () => {
    expect(await mapWithLimit([], 3, async (n: number) => n)).toEqual([]);
  });

  it('runs one at a time for a limit below one', async () => {
    let running = 0;
    let most = 0;

    await mapWithLimit([1, 2, 3], 0, async () => {
      running += 1;
      most = Math.max(most, running);
      await later(2);
      running -= 1;
    });

    expect(most).toBe(1);
  });

  it('finishes every call before it gives the first failure, and starts none after it', async () => {
    const finished: number[] = [];
    const started: number[] = [];

    await expect(
      mapWithLimit([0, 1, 2, 3, 4], 2, async (item) => {
        started.push(item);
        await later(item === 0 ? 1 : 10);
        if (item === 0) throw new Error('boom');
        finished.push(item);
      }),
    ).rejects.toThrow('boom');

    // the call that was running beside the failing one is let finish; the ones not started stay so
    expect(finished).toContain(1);
    expect(started).not.toContain(4);
  });
});
