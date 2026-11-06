import { describe, expect, it } from '@jest/globals';

import { isPickupHours, pickupHoursText } from '@helpers/pickupHours.js';

// the hours of a pickup at the shop: root writes them in one format (docs/shop-settings.md), the
// server checks it, a mail shows the days in the language of its reader

describe('isPickupHours', () => {
  it.each([
    'Mon-Fri 09:00-18:00',
    'Mon-Fri 09:00-18:00; Sat 10:00-14:00',
    'Mon,Wed,Fri 09:00-13:00,14:00-18:00',
    'Mon-Wed,Fri 08:30-17:30; Sat-Sun 10:00-14:00',
    'Sun 00:00-24:00',
    'Mon 09:00-13:00,13:00-18:00',
  ])('takes %p', (text) => {
    expect(isPickupHours(text)).toBe(true);
  });

  it.each([
    ['an empty text', ''],
    ['a day of another language', 'Пн-Пт 09:00-18:00'],
    ['a day in lower case', 'mon-fri 09:00-18:00'],
    ['hours without minutes', 'Mon-Fri 9-18'],
    ['an hour of one digit', 'Mon-Fri 9:00-18:00'],
    ['an hour past the day', 'Mon 09:00-25:00'],
    ['an end before the start', 'Mon 18:00-09:00'],
    ['an end at the start', 'Mon 09:00-09:00'],
    ['hours that overlap', 'Mon 09:00-14:00,13:00-18:00'],
    ['a range of days the wrong way', 'Fri-Mon 09:00-18:00'],
    ['a day twice', 'Mon-Fri 09:00-18:00; Fri 10:00-14:00'],
    ['parts without a space after ";"', 'Mon 09:00-18:00;Sat 10:00-14:00'],
    ['no hours', 'Mon-Fri'],
    ['words around it', 'Mon-Fri 09:00-18:00, closed on holidays'],
    ['spaces around it', ' Mon-Fri 09:00-18:00 '],
  ])('refuses %s', (_case, text) => {
    expect(isPickupHours(text)).toBe(false);
  });
});

describe('pickupHoursText', () => {
  const HOURS = 'Mon-Fri 09:00-18:00; Sat 10:00-14:00';

  it.each([
    ['en', 'Mon-Fri 09:00-18:00; Sat 10:00-14:00'],
    ['uk', 'пн-пт 09:00-18:00; сб 10:00-14:00'],
    ['es', 'lun-vie 09:00-18:00; sáb 10:00-14:00'],
  ])('names the days in %s', (locale, text) => {
    expect(pickupHoursText(HOURS, locale)).toBe(text);
  });

  it('names every day of a list', () => {
    expect(pickupHoursText('Mon,Wed,Sun 10:00-14:00', 'uk')).toBe('пн,ср,нд 10:00-14:00');
  });

  // a text written before the server checked the format: nothing in it is a day to rename
  it('leaves a text not in the format as it is', () => {
    expect(pickupHoursText('Mon to Fri, 9 till 6', 'uk')).toBe('Mon to Fri, 9 till 6');
    expect(pickupHoursText('', 'es')).toBe('');
  });
});
