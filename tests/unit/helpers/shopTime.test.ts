import { describe, expect, it } from '@jest/globals';

import { parseShopTime } from '@helpers/shopTime.js';

// A time a person types for the shop, ISO 8601: with an offset (Z or +hh:mm) it is that exact instant;
// without one it is the wall clock of the shop, read in the time zone of the shop (SHOP_TIME_ZONE).
// Anything else, or a day or an hour the calendar has not got, is null.

const iso = (text: string, zone = 'Europe/Madrid') => parseShopTime(text, zone)?.toISOString();

describe('parseShopTime: a time with an offset is that instant', () => {
  it.each([
    ['2095-07-01T10:00:00Z', '2095-07-01T10:00:00.000Z'],
    ['2095-07-01T12:00:00+02:00', '2095-07-01T10:00:00.000Z'],
    ['2095-07-01T05:00:00-05:00', '2095-07-01T10:00:00.000Z'],
    ['2095-07-01T15:30:00+05:30', '2095-07-01T10:00:00.000Z'],
    ['2095-07-01T10:00Z', '2095-07-01T10:00:00.000Z'],
    ['2095-07-01T10:00:00.250Z', '2095-07-01T10:00:00.250Z'],
    ['2095-07-01T10:00:00.123456789Z', '2095-07-01T10:00:00.123Z'],
    ['2095-07-01T23:59:59Z', '2095-07-01T23:59:59.000Z'],
    ['2095-07-01T00:30:00+01:00', '2095-06-30T23:30:00.000Z'],
  ])('reads %s', (text, expected) => {
    expect(iso(text)).toBe(expected);
  });

  it('does not look at the zone of the shop', () => {
    for (const zone of ['Europe/Madrid', 'America/New_York', 'Asia/Tokyo', 'UTC']) {
      expect(iso('2095-07-01T12:00:00+02:00', zone)).toBe('2095-07-01T10:00:00.000Z');
    }
  });
});

describe('parseShopTime: a time with no offset is read in the zone of the shop', () => {
  it('reads summer time and winter time of Madrid with their own offsets', () => {
    expect(iso('2095-07-01T12:00:00')).toBe('2095-07-01T10:00:00.000Z');
    expect(iso('2095-01-15T12:00:00')).toBe('2095-01-15T11:00:00.000Z');
  });

  it('reads the same wall time differently in other zones', () => {
    expect(iso('2095-07-01T12:00:00', 'UTC')).toBe('2095-07-01T12:00:00.000Z');
    expect(iso('2095-07-01T12:00:00', 'America/New_York')).toBe('2095-07-01T16:00:00.000Z');
    expect(iso('2095-01-15T12:00:00', 'America/New_York')).toBe('2095-01-15T17:00:00.000Z');
    expect(iso('2095-07-01T12:00:00', 'Asia/Kolkata')).toBe('2095-07-01T06:30:00.000Z');
    expect(iso('2095-07-01T12:00:00', 'Asia/Tokyo')).toBe('2095-07-01T03:00:00.000Z');
    expect(iso('2095-07-01T12:00:00', 'Pacific/Auckland')).toBe('2095-07-01T00:00:00.000Z');
  });

  it('keeps seconds and milliseconds', () => {
    expect(iso('2095-07-01T12:00:30.500')).toBe('2095-07-01T10:00:30.500Z');
    expect(iso('2095-07-01T12:00')).toBe('2095-07-01T10:00:00.000Z');
  });

  it('crosses midnight the right way', () => {
    expect(iso('2095-07-01T00:30:00')).toBe('2095-06-30T22:30:00.000Z');
    expect(iso('2095-07-01T23:30:00', 'America/New_York')).toBe('2095-07-02T03:30:00.000Z');
  });

  it('takes the first of the two hours the clock repeats when it goes back', () => {
    // Madrid goes back on the last Sunday of October at 03:00 summer time to 02:00: 02:30 happens
    // twice, 00:30Z (summer, +02:00) and 01:30Z (winter, +01:00); the earlier one is taken
    expect(iso('2095-10-30T02:30:00')).toBe('2095-10-30T00:30:00.000Z');
    // the hour before and the hour after are not doubled
    expect(iso('2095-10-30T01:30:00')).toBe('2095-10-29T23:30:00.000Z');
    expect(iso('2095-10-30T03:30:00')).toBe('2095-10-30T02:30:00.000Z');
  });

  it('moves a time the clock skips when it goes forward to the same wall time after the gap', () => {
    // Madrid goes forward on the last Sunday of March at 02:00 winter time to 03:00: 02:30 does not
    // exist; it is read with the offset before the gap, so it comes out as 03:30 summer time
    expect(iso('2095-03-27T02:30:00')).toBe('2095-03-27T01:30:00.000Z');
    expect(iso('2095-03-27T01:30:00')).toBe('2095-03-27T00:30:00.000Z');
    expect(iso('2095-03-27T03:30:00')).toBe('2095-03-27T01:30:00.000Z');
  });
});

describe('parseShopTime: what is no time', () => {
  it.each([
    ['empty text', ''],
    ['words', 'tomorrow'],
    ['a date with no time', '2095-07-01'],
    ['a time with no date', '10:00:00'],
    ['a space instead of the T', '2095-07-01 10:00:00'],
    ['a lower case t', '2095-07-01t10:00:00Z'],
    ['hours with no minutes', '2095-07-01T10Z'],
    ['a month 13', '2095-13-01T10:00:00Z'],
    ['a month 0', '2095-00-10T10:00:00Z'],
    ['a day 0', '2095-07-00T10:00:00Z'],
    ['a day 32', '2095-07-32T10:00:00Z'],
    ['the 31st of a month with 30 days', '2095-06-31T10:00:00Z'],
    ['the 30th of February', '2096-02-30T10:00:00Z'],
    ['the 29th of February of a year that is not a leap one', '2095-02-29T10:00:00Z'],
    ['the 29th of February of 2100 (not a leap year)', '2100-02-29T10:00:00Z'],
    ['hour 24', '2095-07-01T24:00:00Z'],
    ['minute 60', '2095-07-01T10:60:00Z'],
    ['second 60', '2095-07-01T10:00:60Z'],
    ['an offset of hour 24', '2095-07-01T10:00:00+24:00'],
    ['an offset of minute 60', '2095-07-01T10:00:00+01:60'],
    ['an offset with no colon', '2095-07-01T10:00:00+0200'],
    ['an offset of hours only', '2095-07-01T10:00:00+02'],
    ['a trailing text', '2095-07-01T10:00:00Z now'],
    ['a leading space', ' 2095-07-01T10:00:00Z'],
    ['a year of five digits', '12095-07-01T10:00:00Z'],
    ['a year of three digits', '295-07-01T10:00:00Z'],
    ['a fraction with no digits', '2095-07-01T10:00:00.Z'],
    ['a fraction of ten digits', '2095-07-01T10:00:00.1234567890Z'],
    ['a sign of minus before the year', '-2095-07-01T10:00:00Z'],
  ])('refuses %s', (_case, text) => {
    expect(parseShopTime(text, 'Europe/Madrid')).toBeNull();
  });

  it('takes the 29th of February of a leap year', () => {
    expect(iso('2096-02-29T10:00:00Z')).toBe('2096-02-29T10:00:00.000Z');
  });

  it('is fast on a long text', () => {
    const started = Date.now();
    expect(parseShopTime('2'.repeat(100_000), 'Europe/Madrid')).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });
});
