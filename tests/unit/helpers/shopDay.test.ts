import { describe, expect, it } from '@jest/globals';

import { shopToday } from '@helpers/shopDay.js';

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
