import { describe, expect, it } from '@jest/globals';

import {
  SUPPORTED_DELIVERY_COUNTRIES,
  isSupportedDeliveryCountry,
  normalizePostalCode,
} from '@config/deliveryCountries.js';

// the countries a shop may deliver to: the ones whose address the app can take whole, a postal code
// of a form it knows and no region or state to ask for

describe('the countries of the delivery', () => {
  it('are the member states of the EU, the United Kingdom, Switzerland, Norway, Iceland, Liechtenstein and Ukraine', () => {
    const eu = [
      'AT',
      'BE',
      'BG',
      'HR',
      'CY',
      'CZ',
      'DK',
      'EE',
      'FI',
      'FR',
      'DE',
      'GR',
      'HU',
      'IE',
      'IT',
      'LV',
      'LT',
      'LU',
      'MT',
      'NL',
      'PL',
      'PT',
      'RO',
      'SK',
      'SI',
      'ES',
      'SE',
    ];

    expect([...SUPPORTED_DELIVERY_COUNTRIES].sort()).toEqual(
      [...eu, 'GB', 'CH', 'NO', 'IS', 'LI', 'UA'].sort(),
    );
  });

  it.each(['UA', 'PL', 'GB', 'DE'])('knows %s', (code) => {
    expect(isSupportedDeliveryCountry(code)).toBe(true);
  });

  it.each(['US', 'CA', 'ua', 'UKR', '', 'RU', 'XX'])('does not know %p', (code) => {
    expect(isSupportedDeliveryCountry(code)).toBe(false);
  });
});

describe('a postal code by its country', () => {
  const valid: Array<[country: string, input: string, normalized: string]> = [
    ['UA', '01001', '01001'],
    ['UA', ' 01001 ', '01001'],
    ['PL', '00-950', '00-950'],
    ['PL', '00950', '00-950'],
    ['PT', '1000-001', '1000-001'],
    ['PT', '1000001', '1000-001'],
    ['CZ', '110 00', '110 00'],
    ['CZ', '11000', '110 00'],
    ['SK', '81101', '811 01'],
    ['SE', '114 18', '114 18'],
    ['GR', '10431', '104 31'],
    ['NL', '1012 AB', '1012 AB'],
    ['NL', '1012ab', '1012 AB'],
    ['GB', 'SW1A 1AA', 'SW1A 1AA'],
    ['GB', 'sw1a1aa', 'SW1A 1AA'],
    ['GB', 'M1 1AE', 'M1 1AE'],
    ['GB', 'EC1A 1BB', 'EC1A 1BB'],
    ['IE', 'D02 X285', 'D02 X285'],
    ['IE', 'd02x285', 'D02 X285'],
    ['LV', 'LV-1010', 'LV-1010'],
    ['LV', '1010', 'LV-1010'],
    ['LT', 'LT-01100', 'LT-01100'],
    ['LT', '01100', 'LT-01100'],
    ['MT', 'VLT 1117', 'VLT 1117'],
    ['MT', 'vlt1117', 'VLT 1117'],
    ['DE', '10115', '10115'],
    ['FR', '75001', '75001'],
    ['ES', '28001', '28001'],
    ['IT', '00100', '00100'],
    ['AT', '1010', '1010'],
    ['BE', '1000', '1000'],
    ['CH', '8001', '8001'],
    ['NO', '0150', '0150'],
    ['IS', '101', '101'],
    ['RO', '010011', '010011'],
    ['HR', '10000', '10000'],
    ['LU', '1111', '1111'],
    ['LI', '9490', '9490'],
  ];

  it.each(valid)('takes %s %p as %p', (country, input, normalized) => {
    expect(normalizePostalCode(country, input)).toBe(normalized);
  });

  const invalid: Array<[country: string, input: string]> = [
    ['UA', '1001'],
    ['UA', '010011'],
    ['UA', 'abcde'],
    ['UA', ''],
    ['UA', '01 001'],
    ['PL', '0-950'],
    ['PL', '00-95'],
    ['NL', '1012'],
    ['NL', '1012 A'],
    ['GB', '12345'],
    ['GB', 'SW1A'],
    ['IE', '12345'],
    ['DE', '1011'],
    ['DE', '101155'],
    ['IS', '1010'],
    ['RO', '01001'],
    ['LV', 'LV-101'],
  ];

  it.each(invalid)('refuses %s %p', (country, input) => {
    expect(normalizePostalCode(country, input)).toBeNull();
  });

  it('refuses any code of a country it does not know', () => {
    expect(normalizePostalCode('US', '10001')).toBeNull();
  });
});
