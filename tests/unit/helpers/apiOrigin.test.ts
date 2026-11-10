import { describe, expect, it } from '@jest/globals';

import { importWithEnv } from '../../helpers/freshImport.js';

type ApiOrigin = typeof import('@helpers/apiOrigin.js');

const load = (values: Record<string, string>) =>
  importWithEnv<ApiOrigin>('@helpers/apiOrigin.js', values);

// the address the API is reached on from outside, which the one-click unsubscribe of a newsletter
// mail names in its header (List-Unsubscribe): a mail client posts there from the outside
describe('apiOrigin', () => {
  it('is API_ORIGIN in the form a browser writes an origin', async () => {
    const { apiOrigin } = await load({
      NODE_ENV: 'production',
      API_ORIGIN: ' https://API.Shop.example.com/some/path?x=1 ',
    });

    expect(apiOrigin).toBe('https://api.shop.example.com');
  });

  // the dev server is a copy of production: the setting is required in both (src/config/env.ts)
  it.each(['development', 'production'])(
    'stops the start in %s when API_ORIGIN is not set',
    async (mode) => {
      await expect(load({ NODE_ENV: mode, API_ORIGIN: ' ' })).rejects.toThrow(
        'Missing required env variable: API_ORIGIN',
      );
    },
  );

  it('falls back to a local address in the tests, and prefers the setting there', async () => {
    expect((await load({ NODE_ENV: 'test', API_ORIGIN: '' })).apiOrigin).toBe(
      'http://localhost:4000',
    );
    expect(
      (await load({ NODE_ENV: 'test', API_ORIGIN: 'https://api.shop.example.com' })).apiOrigin,
    ).toBe('https://api.shop.example.com');
  });

  it.each([
    'api.shop.example.com',
    'localhost:4000',
    'ftp://api.shop.example.com',
    '//api.example.com',
  ])('stops the start when API_ORIGIN is %s', async (value) => {
    await expect(load({ NODE_ENV: 'production', API_ORIGIN: value })).rejects.toThrow(
      'Invalid env variable: API_ORIGIN must be an http or https address',
    );
  });

  // RFC 8058 wants an https address in List-Unsubscribe: a mail client does not post to another
  it('stops the start in production when API_ORIGIN is not https', async () => {
    await expect(
      load({ NODE_ENV: 'production', API_ORIGIN: 'http://api.shop.example.com' }),
    ).rejects.toThrow('Invalid env variable: API_ORIGIN must be an https address in production');
  });

  it.each(['development', 'test'])('takes an http address in %s', async (mode) => {
    const { apiOrigin } = await load({ NODE_ENV: mode, API_ORIGIN: 'http://localhost:3000' });

    expect(apiOrigin).toBe('http://localhost:3000');
  });

  it('keeps the value out of the error message', async () => {
    const err = await load({ NODE_ENV: 'production', API_ORIGIN: 'secret-looking-value' }).catch(
      (e: Error) => e,
    );

    expect(String((err as Error).message)).not.toContain('secret-looking-value');
  });
});

describe('apiUrl', () => {
  it('builds an address on the API', async () => {
    const { apiUrl } = await load({
      NODE_ENV: 'production',
      API_ORIGIN: 'https://api.shop.example.com',
    });

    expect(apiUrl('/api/newsletters/unsubscribe/abc')).toBe(
      'https://api.shop.example.com/api/newsletters/unsubscribe/abc',
    );
    expect(apiUrl('/x', { c: '41' })).toBe('https://api.shop.example.com/x?c=41');
  });

  it('stays on the API whatever path it is given', async () => {
    const { apiUrl } = await load({
      NODE_ENV: 'production',
      API_ORIGIN: 'https://api.shop.example.com',
    });

    expect(new URL(apiUrl('//evil.example/x')).origin).toBe('https://api.shop.example.com');
  });

  it('builds on the address of the tests when the tests set none', async () => {
    const { apiUrl } = await load({ NODE_ENV: 'test', API_ORIGIN: '' });

    expect(apiUrl('/x')).toBe('http://localhost:4000/x');
  });
});
