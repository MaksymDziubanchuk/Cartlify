import { describe, expect, it } from '@jest/globals';

import { importWithEnv } from '../../helpers/freshImport.js';

type Links = typeof import('@helpers/newsletterLinks.js');

const SPECIFIER = '@helpers/newsletterLinks.js';

const SITE = { WEB_ORIGIN: 'https://shop.example.com' };

// The links in the newsletter mails open pages of the frontend with the token of the mail after the
// # of the address (#token=...), never in the query: the browser does not send a fragment to any
// server, so no log of a host or of a mail scanner and no referrer ever holds a token (WEB_PAGE_*,
// src/config/env.ts)
describe('the links of the newsletter mails', () => {
  it('builds them on the frontend with the default pages', async () => {
    const links = await importWithEnv<Links>(SPECIFIER, {
      ...SITE,
      WEB_PAGE_NEWSLETTER_CONFIRM: '',
      WEB_PAGE_NEWSLETTER_DECLINE: '',
      WEB_PAGE_NEWSLETTER_MANAGE: '',
    });

    expect(links.newsletterConfirmUrl('tok_en-1')).toBe(
      'https://shop.example.com/newsletter/confirm#token=tok_en-1',
    );
    expect(links.newsletterDeclineUrl('tok_en-1')).toBe(
      'https://shop.example.com/newsletter/decline#token=tok_en-1',
    );
    expect(links.newsletterManageUrl('tok_en-2')).toBe(
      'https://shop.example.com/newsletter/manage#token=tok_en-2',
    );
  });

  it('follows the pages the settings name, each its own', async () => {
    const links = await importWithEnv<Links>(SPECIFIER, {
      ...SITE,
      WEB_PAGE_NEWSLETTER_CONFIRM: '/news/yes',
      WEB_PAGE_NEWSLETTER_DECLINE: '/news/no',
      WEB_PAGE_NEWSLETTER_MANAGE: '/account/news',
    });

    expect(links.newsletterConfirmUrl('t')).toBe('https://shop.example.com/news/yes#token=t');
    expect(links.newsletterDeclineUrl('t')).toBe('https://shop.example.com/news/no#token=t');
    expect(links.newsletterManageUrl('t')).toBe('https://shop.example.com/account/news#token=t');
  });

  it('keeps a query the page already has and puts the token after it, in the fragment', async () => {
    const links = await importWithEnv<Links>(SPECIFIER, {
      ...SITE,
      WEB_PAGE_NEWSLETTER_MANAGE: '/account/news?tab=manage',
    });

    expect(links.newsletterManageUrl('t')).toBe(
      'https://shop.example.com/account/news?tab=manage#token=t',
    );
  });

  // a token is base64url, but whatever the caller gives must not break out of the fragment
  it('encodes a token that is not url-safe', async () => {
    const links = await importWithEnv<Links>(SPECIFIER, SITE);

    expect(links.newsletterConfirmUrl('a&b=c#d e')).toBe(
      'https://shop.example.com/newsletter/confirm#token=a%26b%3Dc%23d+e',
    );
  });

  it('never puts a token in the query', async () => {
    const links = await importWithEnv<Links>(SPECIFIER, SITE);

    for (const url of [
      links.newsletterConfirmUrl('t'),
      links.newsletterDeclineUrl('t'),
      links.newsletterManageUrl('t'),
      links.newsletterUnsubscribePageUrl('t'),
    ]) {
      expect(new URL(url).search).toBe('');
      expect(url).not.toContain('?token=');
    }
  });

  it('is always a link to the frontend, never to another site', async () => {
    const links = await importWithEnv<Links>(SPECIFIER, SITE);

    for (const url of [
      links.newsletterConfirmUrl('t'),
      links.newsletterDeclineUrl('t'),
      links.newsletterManageUrl('t'),
      links.newsletterUnsubscribePageUrl('t'),
    ]) {
      expect(new URL(url).origin).toBe('https://shop.example.com');
    }
  });
});

// the unsubscribe button of a mail is opened with a GET by the person (and by scanners): the API
// sends the browser to the page "Manage the subscription" with the unsubscribe token after the #, and
// the page asks the person before anything is done
describe('the page the unsubscribe button leads to', () => {
  it('is the page of management with #unsubscribe=<token>', async () => {
    const links = await importWithEnv<Links>(SPECIFIER, {
      ...SITE,
      WEB_PAGE_NEWSLETTER_MANAGE: '',
    });

    expect(links.newsletterUnsubscribePageUrl('tok_en-3')).toBe(
      'https://shop.example.com/newsletter/manage#unsubscribe=tok_en-3',
    );
  });

  it('follows the page the setting names', async () => {
    const links = await importWithEnv<Links>(SPECIFIER, {
      ...SITE,
      WEB_PAGE_NEWSLETTER_MANAGE: '/account/news?tab=manage',
    });

    expect(links.newsletterUnsubscribePageUrl('t')).toBe(
      'https://shop.example.com/account/news?tab=manage#unsubscribe=t',
    );
  });
});

// the cards of a newsletter mail link to the pages of a product and of a category (WEB_PAGE_PRODUCT,
// WEB_PAGE_CATEGORY), the home of the shop stands for a link that must lead nowhere in particular
describe('the links of the cards and the home of the shop', () => {
  it('names the page of a product and of a category by the id, with the defaults', async () => {
    const links = await importWithEnv<Links>(SPECIFIER, {
      ...SITE,
      WEB_PAGE_PRODUCT: '',
      WEB_PAGE_CATEGORY: '',
    });

    expect(links.productPagePath(41)).toBe('/products/41');
    expect(links.categoryPagePath(3)).toBe('/categories/3');
  });

  it('follows the pages the settings name', async () => {
    const links = await importWithEnv<Links>(SPECIFIER, {
      ...SITE,
      WEB_PAGE_PRODUCT: '/shop/item/{id}?tab=info',
      WEB_PAGE_CATEGORY: '/shop/c/{id}',
    });

    expect(links.productPagePath(7)).toBe('/shop/item/7?tab=info');
    expect(links.categoryPagePath(9)).toBe('/shop/c/9');
  });

  it('gives the home of the shop on the frontend', async () => {
    const links = await importWithEnv<Links>(SPECIFIER, SITE);

    expect(links.shopHomeUrl()).toBe('https://shop.example.com/');
  });
});

// "Unsubscribe" of the mail program posts to the API: the address is on the API, not on the
// frontend, with the token of the subscription in the path and the campaign in ?c=
describe('the address of the one-click unsubscribe', () => {
  const ENV = { ...SITE, API_ORIGIN: 'https://api.shop.example.com' };

  it('is on the API, with the token in the path and the campaign in the query', async () => {
    const links = await importWithEnv<Links>(SPECIFIER, ENV);

    expect(links.newsletterUnsubscribeUrl('tok_en-9', 41)).toBe(
      'https://api.shop.example.com/api/newsletters/unsubscribe/tok_en-9?c=41',
    );
  });

  it('keeps a token that is not url-safe in its segment of the path', async () => {
    const links = await importWithEnv<Links>(SPECIFIER, ENV);
    const url = new URL(links.newsletterUnsubscribeUrl('a/b?c#d', 5));

    expect(url.origin).toBe('https://api.shop.example.com');
    expect(url.pathname).toBe('/api/newsletters/unsubscribe/a%2Fb%3Fc%23d');
    expect(url.search).toBe('?c=5');
  });
});
