import { describe, expect, it } from '@jest/globals';

import { formatExpiresIn } from '@helpers/formatExpiresIn.js';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const left = (ms: number, locale = 'en') => formatExpiresIn(new Date(NOW + ms), locale, NOW);

describe('formatExpiresIn', () => {
  it.each([
    ['1 minute', MINUTE],
    ['15 minutes', 15 * MINUTE],
    ['1 hour', HOUR],
    ['2 hours', 2 * HOUR],
    ['24 hours', DAY],
    ['47 hours', 47 * HOUR],
    ['2 days', 2 * DAY],
    ['7 days', 7 * DAY],
  ])('says %s', (text, ms) => {
    expect(left(ms)).toBe(text);
  });

  // a bigger unit only when the time divides by it, so the mail never promises more
  it.each([
    ['61 minutes', 61 * MINUTE],
    ['90 minutes', 90 * MINUTE],
    ['25 hours', 25 * HOUR],
    ['49 hours', 49 * HOUR],
    ['1441 minutes', DAY + MINUTE],
  ])('keeps the smaller unit for %s', (text, ms) => {
    expect(left(ms)).toBe(text);
  });

  // the mail goes out a moment after the token got its expiry
  it('rounds the moment between the expiry and the mail away', () => {
    expect(left(HOUR - 40)).toBe('1 hour');
    expect(left(DAY - 2 * SECOND)).toBe('24 hours');
  });

  it.each([
    ['has passed', -MINUTE],
    ['is now', 0],
    ['is under half a minute away', 20 * SECOND],
  ])('says 0 minutes when the expiry %s', (_case, ms) => {
    expect(left(ms)).toBe('0 minutes');
  });

  // the words of the language of the mail, each count in its own form: Ukrainian puts the count
  // after "протягом" in the genitive
  it.each([
    ['uk', MINUTE, '1 хвилини'],
    ['uk', 15 * MINUTE, '15 хвилин'],
    ['uk', 21 * MINUTE, '21 хвилини'],
    ['uk', HOUR, '1 години'],
    ['uk', 2 * HOUR, '2 годин'],
    ['uk', DAY, '24 годин'],
    ['uk', 2 * DAY, '2 днів'],
    ['uk', 0, '0 хвилин'],
    ['es', MINUTE, '1 minuto'],
    ['es', 15 * MINUTE, '15 minutos'],
    ['es', HOUR, '1 hora'],
    ['es', DAY, '24 horas'],
    ['es', 2 * DAY, '2 días'],
  ])('says it in %s: %i ms as %s', (locale, ms, text) => {
    expect(left(ms, locale)).toBe(text);
  });

  it('counts from the current time by default', () => {
    expect(formatExpiresIn(new Date(Date.now() + 15 * MINUTE))).toBe('15 minutes');
  });
});
