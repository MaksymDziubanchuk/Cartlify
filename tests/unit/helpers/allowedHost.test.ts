import { describe, expect, it } from '@jest/globals';

import { isAllowedHost, withoutEndDots } from '@helpers/allowedHost.js';

// The rule for the host of an address of a newsletter: one of the domains of a list or a subdomain of
// one. The domains are lowercase, in the ASCII form

const DOMAINS = ['shop.example', 'blog.partner.test'];

describe('isAllowedHost', () => {
  it.each([
    ['the domain itself', 'shop.example', true],
    ['a subdomain', 'cdn.shop.example', true],
    ['a subdomain of a subdomain', 'a.b.shop.example', true],
    ['capitals', 'SHOP.Example', true],
    ['a dot at the end', 'shop.example.', true],
    ['two dots at the end', 'shop.example..', true],
    ['the domain of the second entry', 'blog.partner.test', true],
    ['a subdomain of the second entry', 'www.blog.partner.test', true],
    ['the parent of an entry', 'partner.test', false],
    ['a sibling of an entry', 'news.partner.test', false],
    ['a longer name that ends the same (no dot between)', 'evilshop.example', false],
    ['the domain as the start of a longer one', 'shop.example.evil.test', false],
    ['another zone', 'shop.test', false],
    ['an empty host', '', false],
    ['an address with an ip', '192.168.0.1', false],
    ['an address of ip version 6', '[::1]', false],
    ['an unicode name of another site', 'пример.рф', false],
  ])('%s', (_name, host, expected) => {
    expect(isAllowedHost(host, DOMAINS)).toBe(expected);
  });

  it('reads an unicode name as its punycode form', () => {
    expect(isAllowedHost('münchen.example', ['xn--mnchen-3ya.example'])).toBe(true);
    expect(isAllowedHost('www.münchen.example', ['xn--mnchen-3ya.example'])).toBe(true);
    expect(isAllowedHost('xn--mnchen-3ya.example', ['xn--mnchen-3ya.example'])).toBe(true);
    expect(isAllowedHost('muenchen.example', ['xn--mnchen-3ya.example'])).toBe(false);
  });

  it('lets nothing in when there are no domains', () => {
    expect(isAllowedHost('shop.example', [])).toBe(false);
  });
});

describe('withoutEndDots', () => {
  it.each([
    ['example.com', 'example.com'],
    ['example.com.', 'example.com'],
    ['example.com...', 'example.com'],
    ['...', ''],
    ['', ''],
  ])('cuts the dots at the end of %p', (host, expected) => {
    expect(withoutEndDots(host)).toBe(expected);
  });
});
