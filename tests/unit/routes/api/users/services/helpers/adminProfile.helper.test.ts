import { describe, expect, it } from '@jest/globals';

import {
  PROFILE_LISTS,
  PROFILE_PERIOD_DEFAULT_DAYS,
  PROFILE_PERIOD_MAX_DAYS,
  parseProfileLists,
  resolveProfilePeriod,
} from '@routes/api/users/services/helpers/adminProfile.helper.js';

// what an admin asks for on the profile of a user (GET /api/users/:userId): the lists of the
// checkboxes and the period they cover

const DAY = 86_400_000;
const NOW = new Date('2026-10-20T12:00:00.000Z');
const daysBefore = (date: Date, days: number) => new Date(date.getTime() - days * DAY);

// what the refusal of a period says
const refusalOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    const { statusCode, errorCode, details } = err as Record<string, unknown>;
    return { statusCode, errorCode, details };
  }
  throw new Error('the period was not refused');
};

describe('resolveProfilePeriod', () => {
  it('takes the last 30 days when no date comes', () => {
    expect(PROFILE_PERIOD_DEFAULT_DAYS).toBe(30);
    expect(resolveProfilePeriod({}, NOW)).toEqual({ from: daysBefore(NOW, 30), to: NOW });
  });

  it('takes 30 days before "to" when only "to" comes', () => {
    const to = new Date('2025-03-10T00:00:00.000Z');

    expect(resolveProfilePeriod({ to: to.toISOString() }, NOW)).toEqual({
      from: daysBefore(to, 30),
      to,
    });
  });

  it('takes the time up to now when only "from" comes', () => {
    const from = daysBefore(NOW, 45);

    expect(resolveProfilePeriod({ from: from.toISOString() }, NOW)).toEqual({ from, to: NOW });
  });

  it('takes both dates as they come, also dates long ago', () => {
    const from = new Date('2024-01-01T00:00:00.000Z');
    const to = new Date('2024-02-15T08:30:00.000Z');

    expect(resolveProfilePeriod({ from: from.toISOString(), to: to.toISOString() }, NOW)).toEqual({
      from,
      to,
    });
  });

  it('reads a date with an offset as the same moment', () => {
    const period = resolveProfilePeriod(
      { from: '2026-10-01T02:00:00+02:00', to: '2026-10-10T00:00:00Z' },
      NOW,
    );

    expect(period.from.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('takes a period of exactly 60 days', () => {
    expect(PROFILE_PERIOD_MAX_DAYS).toBe(60);
    const to = new Date('2026-06-01T00:00:00.000Z');
    const from = daysBefore(to, 60);

    expect(resolveProfilePeriod({ from: from.toISOString(), to: to.toISOString() }, NOW)).toEqual({
      from,
      to,
    });
  });

  it('takes a period of no length, from and to the same moment', () => {
    const at = '2026-06-01T00:00:00.000Z';

    expect(resolveProfilePeriod({ from: at, to: at }, NOW)).toEqual({
      from: new Date(at),
      to: new Date(at),
    });
  });

  it('refuses a period longer than 60 days', () => {
    const to = new Date('2026-06-01T00:00:00.000Z');
    const from = new Date(daysBefore(to, 60).getTime() - 1);

    expect(
      refusalOf(() =>
        resolveProfilePeriod({ from: from.toISOString(), to: to.toISOString() }, NOW),
      ),
    ).toEqual({ statusCode: 400, errorCode: 'PROFILE_PERIOD_TOO_LONG', details: { maxDays: 60 } });
  });

  it('refuses a "from" alone that is more than 60 days ago', () => {
    expect(
      refusalOf(() => resolveProfilePeriod({ from: daysBefore(NOW, 61).toISOString() }, NOW)),
    ).toMatchObject({ statusCode: 400, errorCode: 'PROFILE_PERIOD_TOO_LONG' });
  });

  it('refuses a period that ends before it starts', () => {
    expect(
      refusalOf(() =>
        resolveProfilePeriod({ from: '2026-06-02T00:00:00Z', to: '2026-06-01T00:00:00Z' }, NOW),
      ),
    ).toMatchObject({ statusCode: 400, errorCode: 'PROFILE_PERIOD_INVALID' });
  });

  it('refuses a date that is not a date', () => {
    expect(refusalOf(() => resolveProfilePeriod({ from: 'yesterday' }, NOW))).toMatchObject({
      statusCode: 400,
      errorCode: 'PROFILE_PERIOD_INVALID',
    });
  });
});

describe('parseProfileLists', () => {
  it('knows the six lists of the profile', () => {
    expect([...PROFILE_LISTS].sort()).toEqual(
      ['consents', 'favorites', 'loginLogs', 'orders', 'reviews', 'votes'].sort(),
    );
  });

  it('gives no list when nothing is checked', () => {
    expect(parseProfileLists(undefined)).toEqual([]);
    expect(parseProfileLists('')).toEqual([]);
  });

  it('gives the checked lists once each, in the order they come', () => {
    expect(parseProfileLists('loginLogs,orders,loginLogs')).toEqual(['loginLogs', 'orders']);
  });

  it('leaves out a name that is no list', () => {
    expect(parseProfileLists('orders,secrets')).toEqual(['orders']);
  });
});
