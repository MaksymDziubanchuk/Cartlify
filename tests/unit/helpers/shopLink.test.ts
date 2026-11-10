import { describe, expect, it } from '@jest/globals';

import { isLinkAllowed, markedLink, shopLinkOf, trustedLinkOf } from '@helpers/shopLink.js';

const ORIGIN = 'https://shop.example.com';

// A link of a newsletter may point to the shop and nowhere else: an absolute address of the origin of
// the frontend, or a path of it. This is the one place that decides, for the text of an admin, the
// buttons and every link a mail is built with, so a stolen account of an admin cannot send a
// phishing link to the subscribers
describe('shopLinkOf', () => {
  it.each([
    ['a path', '/sale', 'https://shop.example.com/sale'],
    ['the root path', '/', 'https://shop.example.com/'],
    [
      'a path with a query and a fragment',
      '/p?a=1&b=2#top',
      'https://shop.example.com/p?a=1&b=2#top',
    ],
    ['an absolute address of the shop', 'https://shop.example.com/x', 'https://shop.example.com/x'],
    ['the shop without a path', 'https://shop.example.com', 'https://shop.example.com/'],
    ['the scheme in capitals', 'HTTPS://shop.example.com/x', 'https://shop.example.com/x'],
    [
      'the default port written out',
      'https://shop.example.com:443/x',
      'https://shop.example.com/x',
    ],
    ['a path with percent signs', '/c/a%20b', 'https://shop.example.com/c/a%20b'],
    ['a path with a unicode letter', '/c/ü', 'https://shop.example.com/c/%C3%BC'],
    ['a path with dots', '/a/../b', 'https://shop.example.com/b'],
  ])('lets in %s', (_name, url, expected) => {
    expect(shopLinkOf(url, ORIGIN)).toBe(expected);
  });

  it.each([
    ['another site', 'https://evil.example.org/x'],
    ['a site whose name starts with the shop', 'https://shop.example.com.evil.example.org/x'],
    ['a site that has the shop as a user name', 'https://shop.example.com@evil.example.org/'],
    ['the shop with a user name', 'https://user@shop.example.com/x'],
    ['the shop with a user name and a password', 'https://user:pass@shop.example.com/x'],
    ['the shop on another port', 'https://shop.example.com:8443/x'],
    ['the shop over http', 'http://shop.example.com/x'],
    ['a protocol-relative address', '//evil.example.org/x'],
    ['a protocol-relative address of the shop', '//shop.example.com/x'],
    ['a path with a backslash in front', '/\\evil.example.org'],
    ['a path with a backslash inside', '/a\\b'],
    ['two backslashes', '\\\\evil.example.org'],
    ['a javascript address', 'javascript:alert(1)'],
    ['a javascript address in capitals', 'JAVASCRIPT:alert(1)'],
    ['a javascript address with a tab inside', 'java\tscript:alert(1)'],
    ['a javascript address with a new line inside', 'java\nscript:alert(1)'],
    ['a javascript address with a zero width sign', 'java\u200bscript:alert(1)'],
    ['a data address', 'data:text/html;base64,PHNjcmlwdD4='],
    ['a mail address', 'mailto:someone@example.com'],
    ['a telephone address', 'tel:+123456789'],
    ['a file address', 'file:///etc/passwd'],
    ['an address with no host', 'https://'],
    ['an address with a broken host', 'https://[abc'],
    ['a relative path', 'sale'],
    ['a relative path up', '../sale'],
    ['a query only', '?a=1'],
    ['a fragment only', '#top'],
    ['an empty text', ''],
    ['spaces only', '   '],
    ['a path with a space', '/a b'],
    ['a path with a tab', '/a\tb'],
    ['a path with a new line', '/a\nb'],
    ['a path with a carriage return', '/a\rb'],
    ['a path with a control sign', '/a\u0007b'],
    ['a path with a no-break space', '/a\u00a0b'],
    ['a path with a zero width space', '/a\u200bb'],
    ['a path with a left-to-right override', '/a\u202eb'],
    ['a path with a line separator', '/a\u2028b'],
    ['a path with spaces around', ' /sale '],
    ['an address with a space in front', ' https://shop.example.com/x'],
  ])('refuses %s', (_name, url) => {
    expect(shopLinkOf(url, ORIGIN)).toBeNull();
  });

  it('refuses everything when the shop has no address', () => {
    expect(shopLinkOf('/sale', null)).toBeNull();
    expect(shopLinkOf('https://shop.example.com/x', null)).toBeNull();
  });

  it('keeps the port of an origin that has one', () => {
    expect(shopLinkOf('/x', 'http://localhost:3000')).toBe('http://localhost:3000/x');
    expect(shopLinkOf('http://localhost:3000/x', 'http://localhost:3000')).toBe(
      'http://localhost:3000/x',
    );
    expect(shopLinkOf('http://localhost:3001/x', 'http://localhost:3000')).toBeNull();
  });

  it('refuses a text that is not a text', () => {
    expect(shopLinkOf(undefined as unknown as string, ORIGIN)).toBeNull();
    expect(shopLinkOf(null as unknown as string, ORIGIN)).toBeNull();
    expect(shopLinkOf(5 as unknown as string, ORIGIN)).toBeNull();
  });

  it('refuses an address longer than any page needs', () => {
    expect(shopLinkOf(`/${'a'.repeat(1999)}`, ORIGIN)).not.toBeNull();
    expect(shopLinkOf(`/${'a'.repeat(2000)}`, ORIGIN)).toBeNull();
  });
});

// A link may lead to a site root trusts as well (the domains of the setting newsletterTrustedDomains,
// the subdomains too): an absolute address of http or https and nothing else. A path never leads
// there: a path is the shop's
describe('trustedLinkOf', () => {
  const TRUSTED = ['partner.test', 'blog.other.test'];

  it.each([
    ['a trusted site', 'https://partner.test/x', 'https://partner.test/x'],
    ['a trusted site without a path', 'https://partner.test', 'https://partner.test/'],
    ['a subdomain of a trusted site', 'https://www.partner.test/x', 'https://www.partner.test/x'],
    ['a subdomain of a subdomain', 'https://a.b.partner.test/x', 'https://a.b.partner.test/x'],
    ['the second site', 'https://blog.other.test/x', 'https://blog.other.test/x'],
    ['http', 'http://partner.test/x', 'http://partner.test/x'],
    [
      'the scheme and the host in capitals',
      'HTTPS://Partner.TEST/Path',
      'https://partner.test/Path',
    ],
    [
      'a query and a fragment',
      'https://partner.test/p?a=1&b=2#top',
      'https://partner.test/p?a=1&b=2#top',
    ],
    ['a port', 'https://partner.test:8443/x', 'https://partner.test:8443/x'],
    ['a dot at the end of the host', 'https://partner.test./x', 'https://partner.test./x'],
  ])('lets in %s', (_name, url, expected) => {
    expect(trustedLinkOf(url, TRUSTED)).toBe(expected);
  });

  it('reads a name of another alphabet by its punycode form', () => {
    expect(trustedLinkOf('https://münchen.example/x', ['xn--mnchen-3ya.example'])).toBe(
      'https://xn--mnchen-3ya.example/x',
    );
  });

  it.each([
    ['another site', 'https://evil.test/x'],
    ['the parent of a trusted subdomain', 'https://other.test/x'],
    ['a site whose name starts with a trusted one', 'https://partner.test.evil.test/x'],
    ['a site whose name ends like a trusted one', 'https://evilpartner.test/x'],
    ['a trusted site as a user name', 'https://partner.test@evil.test/x'],
    ['a trusted site with a user name', 'https://user@partner.test/x'],
    ['a trusted site with a user name and a password', 'https://user:pass@partner.test/x'],
    ['a trusted site in the path', 'https://evil.test/partner.test'],
    ['a trusted site in the query', 'https://evil.test/?u=https://partner.test'],
    ['a path', '/sale'],
    ['an address without a scheme', 'partner.test/x'],
    ['a protocol-relative address', '//partner.test/x'],
    ['another scheme', 'ftp://partner.test/x'],
    ['a javascript address', 'javascript:alert(1)'],
    ['a mailto', 'mailto:help@partner.test'],
    ['a backslash', 'https://partner.test\\@evil.test/'],
    ['a space', 'https://partner.test/a b'],
    ['a new line', 'https://partner.test/a\nb'],
    ['a zero width sign', 'https://partner.test/\u200bx'],
    ['an ip address', 'https://192.168.0.1/x'],
    ['an ip address of version 6', 'https://[::1]/x'],
    ['a scheme with nothing after it', 'https://'],
    ['an empty text', ''],
  ])('refuses %s', (_name, url) => {
    expect(trustedLinkOf(url, TRUSTED)).toBeNull();
  });

  it('refuses everything when no site is trusted', () => {
    expect(trustedLinkOf('https://partner.test/x', [])).toBeNull();
  });

  it('refuses what is not a text, and an address longer than any page needs', () => {
    expect(trustedLinkOf(null as unknown as string, TRUSTED)).toBeNull();
    expect(trustedLinkOf(5 as unknown as string, TRUSTED)).toBeNull();
    expect(trustedLinkOf(`https://partner.test/${'a'.repeat(1979)}`, TRUSTED)).not.toBeNull();
    expect(trustedLinkOf(`https://partner.test/${'a'.repeat(1980)}`, TRUSTED)).toBeNull();
  });
});

describe('isLinkAllowed', () => {
  it.each([
    ['a path of the shop', '/sale', true],
    ['an address of the shop', 'https://shop.example.com/x', true],
    ['a trusted site', 'https://partner.test/x', true],
    ['a subdomain of a trusted site', 'https://www.partner.test/x', true],
    [
      'a subdomain of the shop (not the origin of it, not trusted)',
      'https://cdn.shop.example.com/x',
      false,
    ],
    ['another site', 'https://evil.test/x', false],
    ['a javascript address', 'javascript:alert(1)', false],
    ['a protocol-relative address', '//partner.test/x', false],
  ])('%s', (_name, url, expected) => {
    expect(isLinkAllowed(url, ORIGIN, ['partner.test'])).toBe(expected);
  });

  it('lets in a trusted site even when the shop has no address, and no path', () => {
    expect(isLinkAllowed('https://partner.test/x', null, ['partner.test'])).toBe(true);
    expect(isLinkAllowed('/sale', null, ['partner.test'])).toBe(false);
  });
});

describe('markedLink', () => {
  it('adds the marks of the newsletter to an address', () => {
    expect(markedLink('https://shop.example.com/sale', 7)).toBe(
      'https://shop.example.com/sale?utm_source=newsletter&utm_campaign=7',
    );
  });

  it('keeps the query and the fragment it finds', () => {
    expect(markedLink('https://shop.example.com/p?a=1&b=2#top', 12)).toBe(
      'https://shop.example.com/p?a=1&b=2&utm_source=newsletter&utm_campaign=12#top',
    );
  });

  it('replaces marks that are there already instead of doubling them', () => {
    expect(markedLink('https://shop.example.com/p?utm_source=spring&utm_campaign=1&x=1', 5)).toBe(
      'https://shop.example.com/p?utm_source=newsletter&utm_campaign=5&x=1',
    );
  });
});
