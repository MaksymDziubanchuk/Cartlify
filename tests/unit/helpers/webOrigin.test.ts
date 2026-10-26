import { describe, expect, it } from '@jest/globals';

import { importWithEnv } from '../../helpers/freshImport.js';

type WebOrigin = typeof import('@helpers/webOrigin.js');

const load = (values: Record<string, string>) =>
  importWithEnv<WebOrigin>('@helpers/webOrigin.js', values);

describe('toOrigin', () => {
  it.each([
    ['https://shop.example.com', 'https://shop.example.com'],
    ['https://shop.example.com/', 'https://shop.example.com'],
    ['https://shop.example.com/app/index.html?x=1#top', 'https://shop.example.com'],
    ['https://shop.example.com:443', 'https://shop.example.com'],
    ['http://shop.example.com:80', 'http://shop.example.com'],
    ['  https://shop.example.com  ', 'https://shop.example.com'],
    ['HTTPS://Shop.Example.Com', 'https://shop.example.com'],
    ['http://localhost:5173', 'http://localhost:5173'],
  ])('turns %s into %s', async (value, expected) => {
    const { toOrigin } = await load({ NODE_ENV: 'production', WEB_ORIGIN: '' });

    expect(toOrigin(value)).toBe(expected);
  });

  it.each([
    'shop.example.com',
    'localhost:3000',
    '//shop.example.com',
    'ftp://shop.example.com',
    'javascript:alert(1)',
    'null',
    '',
    '   ',
  ])('rejects %j', async (value) => {
    const { toOrigin } = await load({ NODE_ENV: 'production', WEB_ORIGIN: '' });

    expect(toOrigin(value)).toBeNull();
  });
});

describe('allowedWebOrigins', () => {
  it('holds WEB_ORIGIN in the form a browser sends it', async () => {
    const { allowedWebOrigins } = await load({
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://shop.example.com/',
    });

    expect(allowedWebOrigins).toEqual(['https://shop.example.com']);
  });

  it('lets nobody in in production when WEB_ORIGIN is not set', async () => {
    const { allowedWebOrigins, isAllowedWebOrigin } = await load({
      NODE_ENV: 'production',
      WEB_ORIGIN: ' ',
    });

    expect(allowedWebOrigins).toEqual([]);
    expect(isAllowedWebOrigin('http://localhost:3000')).toBe(false);
  });

  it.each(['development', 'test'])(
    'falls back to localhost in %s when WEB_ORIGIN is not set',
    async (nodeEnv) => {
      const { allowedWebOrigins } = await load({ NODE_ENV: nodeEnv, WEB_ORIGIN: '' });

      expect(allowedWebOrigins).toEqual(['http://localhost:3000']);
    },
  );

  it('prefers WEB_ORIGIN over the localhost fallback outside production', async () => {
    const { allowedWebOrigins } = await load({
      NODE_ENV: 'development',
      WEB_ORIGIN: 'http://localhost:5173',
    });

    expect(allowedWebOrigins).toEqual(['http://localhost:5173']);
  });

  it.each(['shop.example.com', 'localhost:3000', 'ftp://shop.example.com'])(
    'stops the start when WEB_ORIGIN is %s',
    async (value) => {
      await expect(load({ NODE_ENV: 'production', WEB_ORIGIN: value })).rejects.toThrow(
        'Invalid env variable: WEB_ORIGIN must be an http or https address',
      );
    },
  );

  it('keeps the value out of the error message', async () => {
    const err = await load({ NODE_ENV: 'production', WEB_ORIGIN: 'secret-looking-value' }).catch(
      (e: Error) => e,
    );

    expect(String((err as Error).message)).not.toContain('secret-looking-value');
  });
});

describe('isAllowedWebOrigin', () => {
  const origins = { NODE_ENV: 'production', WEB_ORIGIN: 'https://shop.example.com' };

  it('accepts the frontend origin', async () => {
    const { isAllowedWebOrigin } = await load(origins);

    expect(isAllowedWebOrigin('https://shop.example.com')).toBe(true);
  });

  it.each([
    'https://evil.test',
    'https://shop.example.com.evil.test',
    'https://evil.test/https://shop.example.com',
    'http://shop.example.com',
    'https://shop.example.com:8443',
    'https://api.shop.example.com',
    'https://shop.example.com/',
    'HTTPS://SHOP.EXAMPLE.COM',
    'null',
    '',
  ])('refuses %j', async (origin) => {
    const { isAllowedWebOrigin } = await load(origins);

    expect(isAllowedWebOrigin(origin)).toBe(false);
  });
});

describe('webUrl', () => {
  it('builds a frontend page address with its query', async () => {
    const { webUrl } = await load({
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://shop.example.com/',
    });

    expect(webUrl('/auth/callback')).toBe('https://shop.example.com/auth/callback');
    expect(webUrl('/auth/callback', { error: 'OAUTH_ACCESS_DENIED' })).toBe(
      'https://shop.example.com/auth/callback?error=OAUTH_ACCESS_DENIED',
    );
  });

  it('encodes the query values', async () => {
    const { webUrl } = await load({
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://shop.example.com',
    });

    expect(webUrl('/web/login', { token: 'a+b/c=&d' })).toBe(
      'https://shop.example.com/web/login?token=a%2Bb%2Fc%3D%26d',
    );
  });

  it('stays on the frontend whatever path it is given', async () => {
    const { webUrl } = await load({
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://shop.example.com',
    });

    expect(new URL(webUrl('auth/callback')).origin).toBe('https://shop.example.com');
  });

  it('builds localhost addresses outside production when WEB_ORIGIN is not set', async () => {
    const { webUrl, webOrigin } = await load({ NODE_ENV: 'development', WEB_ORIGIN: '' });

    expect(webOrigin).toBe('http://localhost:3000');
    expect(webUrl('/auth/callback')).toBe('http://localhost:3000/auth/callback');
  });

  it('refuses to build an address in production without WEB_ORIGIN', async () => {
    const { webUrl, webOrigin } = await load({ NODE_ENV: 'production', WEB_ORIGIN: '' });

    expect(webOrigin).toBeNull();
    expect(() => webUrl('/auth/callback')).toThrow(
      expect.objectContaining({ statusCode: 500, details: { reason: 'WEB_ORIGIN_REQUIRED' } }),
    );
  });
});

// a page of the frontend a WEB_PAGE_* setting names: the id of the order or the product in place
// of {id}, the query before the fragment of the page
describe('webPageUrl', () => {
  const site = { NODE_ENV: 'production', WEB_ORIGIN: 'https://shop.example.com' };

  it('puts the id in place of {id}', async () => {
    const { webPageUrl } = await load(site);

    expect(webPageUrl('/orders/{id}', { id: 7 })).toBe('https://shop.example.com/orders/7');
    expect(webPageUrl('/products/{id}#reviews', { id: 3 })).toBe(
      'https://shop.example.com/products/3#reviews',
    );
  });

  it('keeps the query of the page and adds its own before the fragment', async () => {
    const { webPageUrl } = await load(site);

    expect(webPageUrl('/account?tab=orders#top', { query: { token: 'a+b' } })).toBe(
      'https://shop.example.com/account?tab=orders&token=a%2Bb#top',
    );
    expect(webPageUrl('/p/{id}?tab=reviews#rate', { id: 5 })).toBe(
      'https://shop.example.com/p/5?tab=reviews#rate',
    );
  });

  it('gives a page without {id} as it is', async () => {
    const { webPageUrl } = await load(site);

    expect(webPageUrl('/web/login', { query: { token: 't' } })).toBe(
      'https://shop.example.com/web/login?token=t',
    );
  });
});
