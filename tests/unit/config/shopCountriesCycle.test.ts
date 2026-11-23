import { describe, expect, it } from '@jest/globals';

import { thresholdCycleOf, thresholdHeldOf, type ShopCountry } from '@config/shopCountries.js';

// The cycle of a threshold of the tax (docs/taxes.md): a year from the 1st of its month at midnight
// in the time zone of the shop, or the last 12 months; and whether the tax of the recipient holds
// from before: the year before passed it and root did not start this one with the first rule, or the
// last 12 months passed it since root last went back to the first rule

const threshold = (set: Partial<NonNullable<ShopCountry['threshold']>> = {}) => ({
  amount: 10000,
  withVat: false,
  group: null,
  period: 'year' as const,
  startMonth: 1,
  initialFrom: null,
  heldAt: null,
  ...set,
});

describe('thresholdCycleOf', () => {
  it('starts a year on the 1st of January at midnight in the time zone of the shop', () => {
    const cycle = thresholdCycleOf(threshold(), new Date('2026-11-22T10:00:00Z'), 'Europe/Madrid');

    expect(cycle.from.toISOString()).toBe('2025-12-31T23:00:00.000Z');
    expect(cycle.previousFrom!.toISOString()).toBe('2024-12-31T23:00:00.000Z');
    expect(cycle.nextFrom!.toISOString()).toBe('2026-12-31T23:00:00.000Z');
  });

  it('starts a year of another month in the year before until that month comes', () => {
    const before = thresholdCycleOf(
      threshold({ startMonth: 7 }),
      new Date('2026-05-10T10:00:00Z'),
      'UTC',
    );
    const after = thresholdCycleOf(
      threshold({ startMonth: 7 }),
      new Date('2026-07-01T00:00:00Z'),
      'UTC',
    );

    expect(before.from.toISOString()).toBe('2025-07-01T00:00:00.000Z');
    expect(after.from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('counts the last 12 months back from the moment, with no cycle before or after', () => {
    const cycle = thresholdCycleOf(
      threshold({ period: 'rolling_12', startMonth: null }),
      new Date('2026-11-22T10:00:00Z'),
    );

    expect(cycle).toEqual({
      from: new Date('2025-11-22T10:00:00Z'),
      previousFrom: null,
      nextFrom: null,
    });
  });
});

describe('thresholdHeldOf', () => {
  const from = new Date('2026-01-01T00:00:00Z');

  it('holds a year whose year before passed the threshold, unless root started it with the first rule', () => {
    expect(thresholdHeldOf(threshold(), { from }, 10000.01)).toBe(true);
    expect(thresholdHeldOf(threshold(), { from }, 10000)).toBe(false);
    expect(thresholdHeldOf(threshold({ initialFrom: from }), { from }, 20000)).toBe(false);
  });

  it('holds the last 12 months from the moment they passed it until root goes back to the first rule', () => {
    const rolling = { period: 'rolling_12' as const, startMonth: null };
    const passed = new Date('2026-03-01T00:00:00Z');

    expect(thresholdHeldOf(threshold({ ...rolling }), { from }, null)).toBe(false);
    expect(thresholdHeldOf(threshold({ ...rolling, heldAt: passed }), { from }, null)).toBe(true);
    expect(
      thresholdHeldOf(
        threshold({ ...rolling, heldAt: passed, initialFrom: new Date('2026-04-01T00:00:00Z') }),
        { from },
        null,
      ),
    ).toBe(false);
  });
});
