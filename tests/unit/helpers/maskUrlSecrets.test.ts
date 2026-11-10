import { describe, expect, it } from '@jest/globals';

import { maskUrlSecrets } from '@helpers/maskUrlSecrets.js';

describe('maskUrlSecrets', () => {
  it('leaves a url without a query as it is', () => {
    expect(maskUrlSecrets('/api/products/7')).toBe('/api/products/7');
  });

  it('leaves the search and filter parameters as they were sent', () => {
    const url = '/api/products?search=red%20phone&categoryIds=1,2&minPrice=10&sort=price';

    expect(maskUrlSecrets(url)).toBe(url);
  });

  it.each([
    [
      'an email or password token',
      '/api/auth/verify-email?token=abc123',
      '/api/auth/verify-email?token=[hidden]',
    ],
    [
      'an oauth code and state',
      '/api/auth/github/callback?code=c0de&state=st.ate',
      '/api/auth/github/callback?code=[hidden]&state=[hidden]',
    ],
  ])('hides %s', (_case, url, masked) => {
    expect(maskUrlSecrets(url)).toBe(masked);
  });

  it('hides only the secret values and keeps the order of the other parameters', () => {
    expect(maskUrlSecrets('/cb?scope=email&code=c0de&prompt=consent')).toBe(
      '/cb?scope=email&code=[hidden]&prompt=consent',
    );
  });

  it('hides every copy of a repeated secret parameter', () => {
    expect(maskUrlSecrets('/x?token=a&token=b')).toBe('/x?token=[hidden]&token=[hidden]');
  });

  // the query parser decodes keys, so these still reach the route as token
  it.each([
    ['an encoded key', '/x?%74oken=abc'],
    ['a key in another case', '/x?Token=abc'],
  ])('hides a secret parameter written as %s', (_case, url) => {
    expect(maskUrlSecrets(url)).not.toContain('abc');
  });

  it('keeps a key with a broken encoding as it is when it is not a secret', () => {
    expect(maskUrlSecrets('/x?%E0%A4%A=1')).toBe('/x?%E0%A4%A=1');
  });

  it('keeps a parameter without a value, it has nothing to hide', () => {
    expect(maskUrlSecrets('/x?token&limit=5')).toBe('/x?token&limit=5');
  });

  it('does not take a parameter that only contains a secret name for a secret one', () => {
    expect(maskUrlSecrets('/x?tokenType=bearer&zipcode=01001')).toBe(
      '/x?tokenType=bearer&zipcode=01001',
    );
  });

  describe('a secret in the path', () => {
    // the one-click unsubscribe of a newsletter mail: the token is the last segment of the address
    it.each([
      [
        'a plain link',
        '/api/newsletters/unsubscribe/abc123',
        '/api/newsletters/unsubscribe/[hidden]',
      ],
      [
        'a link with the campaign',
        '/api/newsletters/unsubscribe/abc123?c=5',
        '/api/newsletters/unsubscribe/[hidden]?c=5',
      ],
      [
        'a link with a secret query as well',
        '/api/newsletters/unsubscribe/abc123?c=5&token=zzz',
        '/api/newsletters/unsubscribe/[hidden]?c=5&token=[hidden]',
      ],
      [
        'a path that goes on past the token',
        '/api/newsletters/unsubscribe/abc123/extra',
        '/api/newsletters/unsubscribe/[hidden]/extra',
      ],
      [
        'the prefix in another case',
        '/API/Newsletters/UNSUBSCRIBE/abc123',
        '/API/Newsletters/UNSUBSCRIBE/[hidden]',
      ],
      [
        'a prefix with a letter encoded, which the router reads as the letter',
        '/api/newsletters/%75nsubscribe/abc123',
        '/api/newsletters/unsubscribe/[hidden]',
      ],
      [
        'a prefix with doubled slashes',
        '//api//newsletters//unsubscribe//abc123',
        '//api//newsletters//unsubscribe//[hidden]',
      ],
    ])('hides the token of %s', (_case, url, masked) => {
      expect(maskUrlSecrets(url)).toBe(masked);
    });

    it('leaves the token out of the line however it is written', () => {
      const token = 'Zq9_-aB3';

      for (const url of [
        `/api/newsletters/unsubscribe/${token}`,
        `/api/newsletters/unsubscribe/${token}?c=1`,
        `/api/newsletters/%75nsubscribe/${token}`,
        `/api/newsletters/unsubscribe/${token}/`,
      ]) {
        expect(maskUrlSecrets(url)).not.toContain(token);
      }
    });

    it.each([
      '/api/newsletters/unsubscribe',
      '/api/newsletters/unsubscribe/',
      '/api/newsletters/manage',
      '/api/newsletters/subscriptions/confirm',
      '/api/newsletters/me',
      '/api/products/unsubscribe/7',
      '/newsletters/unsubscribe/abc123',
    ])('leaves %s as it is', (url) => {
      expect(maskUrlSecrets(url)).toBe(url);
    });

    it('keeps a path that does not decode as it is when it is not a secret one', () => {
      expect(maskUrlSecrets('/api/products/%E0%A4%A')).toBe('/api/products/%E0%A4%A');
    });
  });
});
