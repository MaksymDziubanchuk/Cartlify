import { describe, expect, it } from '@jest/globals';

import { importWithEnv } from '../../helpers/freshImport.js';

type SiteDomain = typeof import('@helpers/siteDomain.js');

const load = (values: Record<string, string>) =>
  importWithEnv<SiteDomain>('@helpers/siteDomain.js', values);

describe('siteDomain', () => {
  it.each([
    ['shop.example.com', 'shop.example.com'],
    ['cartlify.shop', 'cartlify.shop'],
    ['api-dev.cartlify.shop', 'api-dev.cartlify.shop'],
    ['  Shop.Example.COM  ', 'shop.example.com'],
  ])('takes %j as %s', async (value, expected) => {
    const { siteDomain } = await load({ NODE_ENV: 'production', SITE_DOMAIN: value });

    expect(siteDomain).toBe(expected);
  });

  // a value the address of a deleted account cannot be built on stops the start, not a deletion later
  it.each([
    'https://shop.example.com',
    'shop.example.com/',
    'shop.example.com:443',
    'shop',
    'localhost',
    '-shop.example.com',
    'shop..example.com',
    'shop example.com',
    'user@shop.example.com',
    'shop.example.123',
  ])('refuses %j at import', async (value) => {
    await expect(load({ NODE_ENV: 'production', SITE_DOMAIN: value })).rejects.toThrow(
      'Invalid env variable: SITE_DOMAIN',
    );
  });

  it('is null in production when SITE_DOMAIN is not set', async () => {
    const { siteDomain } = await load({ NODE_ENV: 'production', SITE_DOMAIN: ' ' });

    expect(siteDomain).toBeNull();
  });

  // example.com is reserved: a made-up address on it never reaches anybody
  it('falls back to example.com outside production', async () => {
    const { siteDomain } = await load({ NODE_ENV: 'development', SITE_DOMAIN: '' });

    expect(siteDomain).toBe('example.com');
  });
});

describe('requireSiteDomain', () => {
  it('gives the domain of the site', async () => {
    const { requireSiteDomain } = await load({
      NODE_ENV: 'production',
      SITE_DOMAIN: 'cartlify.shop',
    });

    expect(requireSiteDomain()).toBe('cartlify.shop');
  });

  it('throws SITE_DOMAIN_REQUIRED in production without the domain', async () => {
    const { requireSiteDomain } = await load({ NODE_ENV: 'production', SITE_DOMAIN: '' });

    expect(() => requireSiteDomain()).toThrow(
      expect.objectContaining({ statusCode: 500, details: { reason: 'SITE_DOMAIN_REQUIRED' } }),
    );
  });
});
