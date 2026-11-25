import { describe, expect, it } from '@jest/globals';

import { deviceLabel } from '@helpers/twoFactor/deviceLabel.js';

describe('deviceLabel', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Chrome, Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
      'Edge, Windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
      'Safari, macOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      'Safari, iOS',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0', 'Firefox, Linux'],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      'Chrome, Android',
    ],
  ])('names the browser and the system of %s', (userAgent, label) => {
    expect(deviceLabel(userAgent)).toBe(label);
  });

  it('names what it can tell, and an unknown browser otherwise', () => {
    expect(deviceLabel('curl/8.5.0')).toBe('Unknown browser');
    expect(deviceLabel(undefined)).toBe('Unknown browser');
    expect(deviceLabel('Something (Windows NT 10.0)')).toBe('Windows');
  });
});
