import { describe, expect, it } from '@jest/globals';

import { shopDayBounds, shopToday } from '@helpers/shopDay.js';

// the day of the shop is the day of its time zone (SHOP_TIME_ZONE, Europe/Madrid unless set):
// a batch is over once its last good day is behind the day of the shop

describe('shopToday', () => {
  it('gives the day of the shop, yyyy-mm-dd', () => {
    expect(shopToday(Date.parse('2026-10-22T10:00:00.000Z'))).toBe('2026-10-22');
  });

  // Madrid is an hour ahead of utc in winter, two in summer
  it.each([
    ['2026-10-31T23:30:00.000Z', '2026-11-01'],
    ['2026-07-31T22:30:00.000Z', '2026-08-01'],
    ['2026-07-31T21:30:00.000Z', '2026-07-31'],
  ])('is already the next day in Madrid at %s', (at, day) => {
    expect(shopToday(Date.parse(at))).toBe(day);
  });

  it('takes the time zone it is given', () => {
    const at = Date.parse('2026-10-31T23:30:00.000Z');

    expect(shopToday(at, 'UTC')).toBe('2026-10-31');
    expect(shopToday(at, 'America/New_York')).toBe('2026-10-31');
    expect(shopToday(at, 'Pacific/Kiritimati')).toBe('2026-11-01');
  });
});

// the day of the shop as the two moments it begins and ends: the daily limit of the newsletters counts
// the mails sent between them
describe('shopDayBounds', () => {
  const iso = (bounds: { start: Date; end: Date }) => [
    bounds.start.toISOString(),
    bounds.end.toISOString(),
  ];

  it('is the day of the zone, from its midnight to the next one', () => {
    // Madrid is two hours ahead of utc in the summer, one in the winter
    expect(iso(shopDayBounds(new Date('2026-07-10T12:00:00.000Z'), 'Europe/Madrid'))).toEqual([
      '2026-07-09T22:00:00.000Z',
      '2026-07-10T22:00:00.000Z',
    ]);
    expect(iso(shopDayBounds(new Date('2026-12-10T12:00:00.000Z'), 'Europe/Madrid'))).toEqual([
      '2026-12-09T23:00:00.000Z',
      '2026-12-10T23:00:00.000Z',
    ]);
  });

  it('puts a moment after the midnight of the zone in the next day, though not in utc', () => {
    const late = new Date('2026-07-10T22:30:00.000Z');

    expect(iso(shopDayBounds(late, 'Europe/Madrid'))[0]).toBe('2026-07-10T22:00:00.000Z');
    expect(iso(shopDayBounds(late, 'UTC'))[0]).toBe('2026-07-10T00:00:00.000Z');
  });

  it('holds the moment it is asked about, the start included and the end not', () => {
    const now = new Date('2026-03-15T08:00:00.000Z');
    const { start, end } = shopDayBounds(now, 'Europe/Madrid');

    expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(end.getTime()).toBeGreaterThan(now.getTime());
    // the end is the start of the next day
    expect(shopDayBounds(end, 'Europe/Madrid').start.getTime()).toBe(end.getTime());
    expect(shopDayBounds(new Date(end.getTime() - 1), 'Europe/Madrid').start.getTime()).toBe(
      start.getTime(),
    );
  });

  it('is 23 hours long the day the clock goes forward, 25 the day it goes back (Madrid)', () => {
    const hours = (at: string) => {
      const { start, end } = shopDayBounds(new Date(at), 'Europe/Madrid');
      return (end.getTime() - start.getTime()) / 3_600_000;
    };

    expect(hours('2026-03-29T12:00:00.000Z')).toBe(23);
    expect(hours('2026-10-25T12:00:00.000Z')).toBe(25);
    expect(hours('2026-06-01T12:00:00.000Z')).toBe(24);
  });

  it('goes by the zone of the shop (SHOP_TIME_ZONE) when none is given', () => {
    const now = new Date('2026-07-10T12:00:00.000Z');

    // the zone of the tests is Madrid, like the one the other cases of this file rely on
    expect(iso(shopDayBounds(now))).toEqual(iso(shopDayBounds(now, 'Europe/Madrid')));
  });
});
