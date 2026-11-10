import { describe, expect, it } from '@jest/globals';

import { importWithEnv } from '../../helpers/freshImport.js';

type Module = typeof import('@helpers/newsletterDomains.js');

// The sites a text of a newsletter may name: the shop's own (SITE_DOMAIN, and the host of WEB_ORIGIN,
// the frontend every link of a mail leads to) and the ones root trusts (newsletterTrustedDomains of
// the data of the shop). A domain lets in its subdomains (helpers/foreignAddress.ts)

const load = (values: Record<string, string>, trusted: string[] = []) =>
  importWithEnv<Module>('@helpers/newsletterDomains.js', values, {
    shopSettings: { newsletterTrustedDomains: trusted },
  });

describe('newsletterAllowedDomains', () => {
  it('gives the domain of the site, the host of the frontend and the trusted domains', async () => {
    const { newsletterAllowedDomains } = await load(
      {
        NODE_ENV: 'production',
        SITE_DOMAIN: 'cartlify.example',
        WEB_ORIGIN: 'https://shop.cartlify.example',
      },
      ['blog.partner.test', 'news.example.org'],
    );

    expect(newsletterAllowedDomains()).toEqual([
      'cartlify.example',
      'shop.cartlify.example',
      'blog.partner.test',
      'news.example.org',
    ]);
  });

  it('names a domain once, however many places give it', async () => {
    const { newsletterAllowedDomains } = await load(
      {
        NODE_ENV: 'production',
        SITE_DOMAIN: 'cartlify.example',
        WEB_ORIGIN: 'https://cartlify.example',
      },
      ['cartlify.example', 'blog.partner.test'],
    );

    expect(newsletterAllowedDomains()).toEqual(['cartlify.example', 'blog.partner.test']);
  });

  it('takes the host of the frontend without the scheme, the port and the path', async () => {
    const { newsletterAllowedDomains } = await load({
      NODE_ENV: 'production',
      SITE_DOMAIN: '',
      WEB_ORIGIN: 'https://Shop.Cartlify.Example:8443',
    });

    expect(newsletterAllowedDomains()).toEqual(['shop.cartlify.example']);
  });

  it('gives only the trusted domains when the site has neither a domain nor a frontend', async () => {
    const { newsletterAllowedDomains } = await load(
      { NODE_ENV: 'production', SITE_DOMAIN: '', WEB_ORIGIN: '' },
      ['blog.partner.test'],
    );

    expect(newsletterAllowedDomains()).toEqual(['blog.partner.test']);
  });

  it('gives nothing when there is nothing at all, so no address passes', async () => {
    const { newsletterAllowedDomains } = await load({
      NODE_ENV: 'production',
      SITE_DOMAIN: '',
      WEB_ORIGIN: '',
    });

    expect(newsletterAllowedDomains()).toEqual([]);
  });

  it('keeps the domain of the tests when the site has none set', async () => {
    const { newsletterAllowedDomains } = await load({
      NODE_ENV: 'test',
      SITE_DOMAIN: '',
      WEB_ORIGIN: '',
    });

    expect(newsletterAllowedDomains()).toEqual(['example.com', 'localhost']);
  });

  it('reads the trusted domains every time: root changes them while the server runs', async () => {
    const { newsletterAllowedDomains } = await load(
      { NODE_ENV: 'production', SITE_DOMAIN: 'cartlify.example', WEB_ORIGIN: '' },
      [],
    );
    const { setShopSettingsForTest } = await import('@config/shopSettings.js');

    expect(newsletterAllowedDomains()).toEqual(['cartlify.example']);

    setShopSettingsForTest({ newsletterTrustedDomains: ['blog.partner.test'] });
    expect(newsletterAllowedDomains()).toEqual(['cartlify.example', 'blog.partner.test']);
  });
});

// The sites root trusts and nothing else: the shop's own domains are judged by the origin of the shop
// when a link is checked, so they are not in this list
describe('newsletterTrustedDomains', () => {
  it('gives the trusted domains only, not those of the shop', async () => {
    const { newsletterTrustedDomains } = await load(
      {
        NODE_ENV: 'production',
        SITE_DOMAIN: 'cartlify.example',
        WEB_ORIGIN: 'https://shop.cartlify.example',
      },
      ['blog.partner.test', 'news.example.org'],
    );

    expect(newsletterTrustedDomains()).toEqual(['blog.partner.test', 'news.example.org']);
  });

  it('is empty when root trusts none', async () => {
    const { newsletterTrustedDomains } = await load({
      NODE_ENV: 'production',
      SITE_DOMAIN: 'cartlify.example',
    });

    expect(newsletterTrustedDomains()).toEqual([]);
  });

  it('reads the trusted domains every time: root changes them while the server runs', async () => {
    const { newsletterTrustedDomains } = await load({ NODE_ENV: 'production' }, []);
    const { setShopSettingsForTest } = await import('@config/shopSettings.js');

    expect(newsletterTrustedDomains()).toEqual([]);

    setShopSettingsForTest({ newsletterTrustedDomains: ['blog.partner.test'] });
    expect(newsletterTrustedDomains()).toEqual(['blog.partner.test']);
  });
});
