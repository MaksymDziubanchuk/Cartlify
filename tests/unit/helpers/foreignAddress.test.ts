import { describe, expect, it } from '@jest/globals';

import {
  foreignAddressOf,
  foreignAddressOfMarkup,
  foreignAddressesOf,
} from '@helpers/foreignAddress.js';

// The addresses of other sites in a text of a newsletter: `http(s)://...` (any scheme with `//`),
// `www....`, a domain with a path (`domain.tld/path`) and a name with no path or with a `?` or `#`
// after it (`example.com`, `example.com?x=1`) when its last label is a real top-level domain. A host
// passes when it is one of the domains given or a subdomain of one of them. The domains are lowercase,
// in the ASCII form

const DOMAINS = ['shop.example', 'blog.partner.test'];

const found = (text: string, domains: readonly string[] = DOMAINS) =>
  foreignAddressesOf(text, domains);

describe('foreignAddressesOf: what passes', () => {
  it.each([
    ['an empty text', ''],
    ['a text with no address', 'Spring sale, up to 30% off. Come and see!'],
    ['a plain domain without a path', 'Visit shop.example today'],
    ['an address of the shop', 'https://shop.example/sale'],
    ['an address of the shop with the scheme in capitals', 'HTTPS://SHOP.EXAMPLE/Sale'],
    ['an address of the shop without a path', 'http://shop.example'],
    ['an address of the shop with a port', 'https://shop.example:8443/x'],
    ['an address of a subdomain of the shop', 'https://api.shop.example/x'],
    ['an address with www', 'www.shop.example/sale'],
    ['an address with www and no path', 'www.shop.example'],
    ['a domain with a path', 'shop.example/sale'],
    ['a domain with a path in capitals', 'Shop.Example/Sale'],
    ['a domain of a subdomain with a path', 'cdn.shop.example/x'],
    ['a domain with a dot at the end', 'https://shop.example./x'],
    ['a bare domain with a dot at the end and a path', 'shop.example./x'],
    ['an address of the second domain', 'https://blog.partner.test/post'],
    ['a path of the shop', 'see /sale or /new/arrivals'],
    ['a path with a file name', 'the picture is at /files/photo.jpg/more'],
    ['an email address', 'write to help@shop.example or help@other.test'],
    ['an email address with a path after it', 'a@other.test/more'],
    ['a mailto', 'mailto:help@other.test'],
    ['a short word with a dot and a slash', 'e.g./i.e. and/or U.S./world'],
    ['numbers', 'open 9.00/10.00, version 3.5/4, 1.5/2'],
    ['a word the scheme does not make', 'https is secure, www is a word'],
    ['a scheme with nothing after it', 'the text https:// ends here'],
  ])('%s', (_name, text) => {
    expect(found(text)).toEqual([]);
  });

  it('lets a link of the markup to the shop pass', () => {
    expect(found('Look at [the sale](https://shop.example/sale) and [new](/new)')).toEqual([]);
    expect(found('**bold** *italic* [x](/sale)')).toEqual([]);
  });

  it.each([
    ['round brackets', '(https://shop.example/sale)'],
    ['quotes', '"https://shop.example/sale" and \'shop.example/sale\''],
    ['angle brackets', '<https://shop.example/sale>'],
    ['a full stop', 'Go to https://shop.example/sale.'],
    ['a comma', 'Go to https://shop.example/sale, then home'],
    ['an exclamation mark', 'Go to https://shop.example/sale!'],
    ['markup marks', '**https://shop.example/sale**'],
    ['a closing bracket of the markup', '[https://shop.example/sale](/sale)'],
    ['ideographic punctuation', 'https://shop.example/sale。'],
  ])('lets an address of the shop pass with %s around it', (_name, text) => {
    expect(found(text)).toEqual([]);
  });

  it('reads the punycode form of a domain', () => {
    const domains = ['xn--80ak6aa92e.com', 'xn--mnchen-3ya.example'];

    expect(found('https://xn--80ak6aa92e.com/x', domains)).toEqual([]);
    expect(found('xn--80ak6aa92e.com/x', domains)).toEqual([]);
    expect(found('www.xn--80ak6aa92e.com/x', domains)).toEqual([]);
    expect(found('https://münchen.example/x', domains)).toEqual([]);
    expect(found('münchen.example/x', domains)).toEqual([]);
  });
});

describe('foreignAddressesOf: what is refused', () => {
  it.each([
    ['https', 'https://evil.test/x', 'https://evil.test/x'],
    ['http', 'http://evil.test', 'http://evil.test'],
    ['a scheme in capitals', 'HTTP://EVIL.TEST/Sale', 'HTTP://EVIL.TEST/Sale'],
    ['an address of another scheme', 'ftp://evil.test/file', 'ftp://evil.test/file'],
    ['a scheme with other letters in front', 'xhttps://evil.test/x', 'xhttps://evil.test/x'],
    ['www', 'www.evil.test', 'www.evil.test'],
    ['www with a path', 'www.evil.test/x', 'www.evil.test/x'],
    ['www in capitals', 'WWW.EVIL.TEST/x', 'WWW.EVIL.TEST/x'],
    ['a domain with a path', 'evil.test/x', 'evil.test/x'],
    ['a domain with a path in capitals', 'EVIL.TEST/x', 'EVIL.TEST/x'],
    ['a domain with a subdomain and a path', 'a.b.evil.test/x', 'a.b.evil.test/x'],
    ['a domain with a port and a path', 'evil.test:8080/x', 'evil.test:8080/x'],
    ['a domain with a dot at the end and a path', 'evil.test./x', 'evil.test./x'],
    ['an address with a dot at the end', 'https://evil.test./x', 'https://evil.test./x'],
    ['an address with an ip', 'http://192.168.0.1/x', 'http://192.168.0.1/x'],
    ['an address with an ip as a number', 'http://3232235777/x', 'http://3232235777/x'],
    ['an address with an ip of version 6', 'http://[::1]/x', 'http://[::1]/x'],
    ['an address with a login', 'http://user:pass@evil.test/x', 'http://user:pass@evil.test/x'],
  ])('%s', (_name, text, address) => {
    expect(found(text)).toEqual([address]);
  });

  it.each([
    ['the domain of the shop in front: the name of another', 'https://shop.example.evil.test/x'],
    ['the domain of the shop at the end with no dot', 'https://evilshop.example/x'],
    ['the domain of the shop as a login', 'https://shop.example@evil.test/x'],
    ['the domain of the shop as a login and a password', 'https://shop.example:pass@evil.test/x'],
    ['the domain of the shop in the query', 'https://evil.test/?u=https://shop.example'],
    ['the domain of the shop in the path', 'https://evil.test/shop.example/x'],
    ['the domain of the shop in the fragment', 'https://evil.test#shop.example'],
    ['a bare domain, the shop in front', 'shop.example.evil.test/x'],
    ['a bare domain, the shop at the end with no dot', 'evilshop.example/x'],
    ['the parent of an allowed domain', 'https://partner.test/x'],
    ['a sibling of an allowed domain', 'https://news.partner.test/x'],
    ['a look-alike of a letter (another alphabet)', 'https://shоp.example/x'],
    ['a look-alike with www', 'www.shоp.example'],
  ])('refuses a trick: %s', (_name, text) => {
    expect(found(text)).toHaveLength(1);
    expect(foreignAddressOf(text, DOMAINS)).not.toBeNull();
  });

  it('refuses the unicode and the punycode form of another domain', () => {
    expect(found('https://пример.рф/x')).toHaveLength(1);
    expect(found('пример.рф/x')).toHaveLength(1);
    expect(found('xn--e1afmkfd.xn--p1ai/x')).toHaveLength(1);
    expect(found('https://xn--e1afmkfd.xn--p1ai/x')).toHaveLength(1);
    expect(found('www.xn--e1afmkfd.xn--p1ai')).toHaveLength(1);
  });

  it('reads the full stop of another alphabet as a dot', () => {
    expect(found('http://evil。test/x')).toHaveLength(1);
    expect(found('http://shop。example/x')).toEqual([]);
  });

  it('refuses an address the parser cannot read', () => {
    expect(found('https://exa%mple.test/x')).toEqual(['https://exa%mple.test/x']);
  });

  it('refuses everything when there are no domains', () => {
    expect(found('https://shop.example/x', [])).toEqual(['https://shop.example/x']);
    expect(found('shop.example/x', [])).toEqual(['shop.example/x']);
    expect(found('www.shop.example', [])).toEqual(['www.shop.example']);
  });

  it('gives the address without the signs a sentence puts after it', () => {
    expect(found('See https://evil.test/x.')).toEqual(['https://evil.test/x']);
    expect(found('See https://evil.test/x, or')).toEqual(['https://evil.test/x']);
    expect(found('See https://evil.test/x!?')).toEqual(['https://evil.test/x']);
    expect(found('See (https://evil.test/x)')).toEqual(['https://evil.test/x']);
    expect(found('See "https://evil.test/x"')).toEqual(['https://evil.test/x']);
    expect(found('See <https://evil.test/x>')).toEqual(['https://evil.test/x']);
    expect(found('See **https://evil.test/x**')).toEqual(['https://evil.test/x']);
    expect(found('See (evil.test/x).')).toEqual(['evil.test/x']);
    expect(found('See www.evil.test.')).toEqual(['www.evil.test']);
    expect(found('See https://evil.test/x。')).toEqual(['https://evil.test/x']);
  });

  it('finds an address inside the markup of a link', () => {
    expect(found('[the sale](https://evil.test/sale)')).toEqual(['https://evil.test/sale']);
    // the label says one thing and the link another: the label is an address of another site
    expect(found('[evil.test/x](/sale)')).toEqual(['evil.test/x']);
    expect(found('[https://evil.test](/sale)')).toEqual(['https://evil.test']);
    expect(found('**[x](https://evil.test)**')).toEqual(['https://evil.test']);
    expect(found('- one\n- [two](www.evil.test)')).toEqual(['www.evil.test']);
  });

  it('finds an address after a line break or a tab', () => {
    expect(found('Hello\nhttps://evil.test/x')).toEqual(['https://evil.test/x']);
    expect(found('Hello\r\nwww.evil.test')).toEqual(['www.evil.test']);
    expect(found('Hello\tevil.test/x')).toEqual(['evil.test/x']);
  });

  it('gives every address of another site, in the order they are written', () => {
    expect(
      found(
        'a https://shop.example/ok b evil.test/one c www.other.test d https://x.test/two https://shop.example/ok2',
      ),
    ).toEqual(['evil.test/one', 'www.other.test', 'https://x.test/two']);
  });

  it('gives an address once however many ways it can be read', () => {
    // www and a domain with a path are both true of it
    expect(found('www.evil.test/x')).toEqual(['www.evil.test/x']);
    // the scheme and the domain with a path
    expect(found('https://evil.test/x')).toEqual(['https://evil.test/x']);
    // a login and a host
    expect(found('https://user@evil.test/x')).toEqual(['https://user@evil.test/x']);
  });

  it('does not read the inside of an address twice', () => {
    // the signs in the query belong to the address they are in; where it leads is told by its host
    expect(found('https://evil.test/go?next=evil2.test/x%20y')).toEqual([
      'https://evil.test/go?next=evil2.test/x%20y',
    ]);
    expect(found('https://shop.example/go?next=evil.test/x')).toEqual([]);
  });

  it('stops at the first address for foreignAddressOf', () => {
    expect(foreignAddressOf('a evil.test/one b www.other.test', DOMAINS)).toBe('evil.test/one');
    expect(foreignAddressOf('nothing here', DOMAINS)).toBeNull();
    expect(foreignAddressOf('', DOMAINS)).toBeNull();
    expect(foreignAddressOf('https://shop.example/x', DOMAINS)).toBeNull();
  });
});

// A name with no path is a word as much as an address, so it is read only when its last label is a real
// top-level domain (the list of the package `tlds`): `example.com` is an address, `photo.jpg` is not.
// A name with a path is read whatever its zone is (above)
describe('foreignAddressesOf: a name with no path', () => {
  it.each([
    ['a plain name', 'Visit evil.com today', 'evil.com'],
    ['a name at the start of the text', 'evil.com is great', 'evil.com'],
    ['a name alone', 'evil.com', 'evil.com'],
    ['capitals', 'Visit EVIL.COM today', 'EVIL.COM'],
    ['a subdomain', 'Visit shop.evil.com today', 'shop.evil.com'],
    ['a zone of two parts', 'Visit evil.co.uk today', 'evil.co.uk'],
    ['a new generic zone', 'Visit evil.shop today', 'evil.shop'],
    ['a dot at the end of the sentence', 'Visit evil.com.', 'evil.com'],
    ['a comma', 'Visit evil.com, then home', 'evil.com'],
    ['a question mark', 'Do you know evil.com?', 'evil.com'],
    ['an exclamation mark', 'Go to evil.com!', 'evil.com'],
    ['round brackets', 'See (evil.com)', 'evil.com'],
    ['quotes', 'See "evil.com"', 'evil.com'],
    ['markup marks', 'See **evil.com**', 'evil.com'],
    ['a port', 'See evil.com:8080 now', 'evil.com:8080'],
    ['a colon after it', 'Visit evil.com: it is great', 'evil.com'],
    ['a name in letters of another alphabet', 'Visit пример.рф today', 'пример.рф'],
    [
      'the punycode form of that name',
      'Visit xn--e1afmkfd.xn--p1ai today',
      'xn--e1afmkfd.xn--p1ai',
    ],
    ['a name on a line of its own', 'Hello\nevil.com\nbye', 'evil.com'],
  ])('refuses %s', (_name, text, address) => {
    expect(found(text)).toEqual([address]);
  });

  it.each([
    ['a ? with a query', 'Visit evil.com?utm=1 today', 'evil.com?utm=1'],
    ['a ? with a query to the end', 'evil.com?a=b&c=d', 'evil.com?a=b&c=d'],
    ['a # with a fragment', 'Visit evil.com#top today', 'evil.com#top'],
    ['a port and a ?', 'evil.com:8080?x=1', 'evil.com:8080?x=1'],
    ['a query and then a dot of the sentence', 'Go to evil.com?x=1.', 'evil.com?x=1'],
    ['a subdomain and a #', 'a.b.evil.com#x', 'a.b.evil.com#x'],
    ['a name in letters of another alphabet and a ?', 'пример.рф?x=1', 'пример.рф?x=1'],
  ])('refuses a name followed by %s', (_name, text, address) => {
    expect(found(text)).toEqual([address]);
  });

  // not an address of the web, but a name that ends with a real zone: it is read as one, and the text
  // is changed by the person who writes it (the rule decides by the list of zones and nothing else)
  it.each([
    ['a file of an archive (.zip is the zone of Google)', 'Download file.zip now', 'file.zip'],
    ['a file of notes (.md is the zone of Moldova)', 'Read readme.md first', 'readme.md'],
    ['a script (.sh is the zone of Saint Helena)', 'Run install.sh first', 'install.sh'],
    ['a script (.py is the zone of Paraguay)', 'Run main.py first', 'main.py'],
    ['an end of a sentence with no space (.next is a zone)', 'It is done.Next we go', 'done.Next'],
    ['an end of a sentence with no space (.now is a zone)', 'Hurry up.Now is the time', 'up.Now'],
  ])('refuses what only looks like a file or a sentence: %s', (_name, text, address) => {
    expect(found(text)).toEqual([address]);
  });

  // a word with a dot that does not end with a real zone is a word
  it.each([
    ['an abbreviation', 'Take e.g. a coat, i.e. a jacket'],
    ['an abbreviation with capitals', 'Made in the U.S.A. and sold at U.K.'],
    ['a title and a name', 'Mr.Smith came, and Mrs.Jones'],
    ['a version', 'Version v1.2 and 2.0.1 are out'],
    ['a picture', 'See photo.jpg and logo.png'],
    ['a page', 'Open index.html and style.css'],
    ['a text file', 'Read notes.txt and data.json'],
    ['numbers', 'It costs 3.5 or 9.99 eur, and 1.5kg'],
    ['a price with a currency', 'Only 9.99usd today'],
    ['an end of a sentence with no space', 'Thanks.Nothing else'],
    ['digits in the zone', 'Open evil.xyz123 now'],
    ['a zone with a dash', 'Open evil.com-offer now'],
    ['a longer word after the zone', 'Open evil.comx now'],
    ['an underscore after the zone', 'Open evil.com_offer now'],
    ['a label of a name that is not the last', 'Open evil.com.invalid now'],
    ['a reserved zone of tests', 'Open evil.test now'],
    ['an ellipsis', 'Wait... then go'],
  ])('lets pass %s', (_name, text) => {
    expect(found(text)).toEqual([]);
  });

  it.each([
    ['an email address', 'Write to help@evil.com please'],
    ['an email address with a dot in the name', 'Write to first.last@evil.com please'],
    [
      'an email address with a name that ends with a zone',
      'Write to john.name@evil.com or anna.red@evil.com',
    ],
    ['an email address in capitals', 'Write to HELP@EVIL.COM'],
    ['an email address at the end of a sentence', 'Write to help@evil.com.'],
    ['an email address with a subdomain', 'Write to help@mail.evil.com'],
    ['a mailto', 'mailto:help@evil.com'],
  ])('does not read %s as an address of the web', (_name, text) => {
    expect(found(text)).toEqual([]);
  });

  it('lets in the domains it is given, and their subdomains', () => {
    const domains = ['evil.com'];

    expect(found('Visit evil.com today', domains)).toEqual([]);
    expect(found('Visit EVIL.com today', domains)).toEqual([]);
    expect(found('Visit shop.evil.com today', domains)).toEqual([]);
    expect(found('Visit evil.com?x=1 today', domains)).toEqual([]);
    expect(found('Visit evil.com#top today', domains)).toEqual([]);
    expect(found('Visit evil.com. Bye', domains)).toEqual([]);
    expect(found('Visit evil.com:8080', domains)).toEqual([]);
    // the name of another site that only looks like it
    expect(found('Visit notevil.com today', domains)).toEqual(['notevil.com']);
    expect(found('Visit evil.com.au today', domains)).toEqual(['evil.com.au']);
    expect(found('Visit evil.com.evil.io today', domains)).toEqual(['evil.com.evil.io']);
  });

  it('refuses everything with a real zone when there are no domains', () => {
    expect(found('Visit evil.com today', [])).toEqual(['evil.com']);
  });

  it('gives the names with no path with the other addresses, once each, in the order of the text', () => {
    expect(
      found('a evil.com b https://x.test/two c www.other.test d one.io?x=1 e shop.example/ok'),
    ).toEqual(['evil.com', 'https://x.test/two', 'www.other.test', 'one.io?x=1']);
    // a name that has a path is one address, not two
    expect(found('evil.com/x and evil.com')).toEqual(['evil.com/x', 'evil.com']);
    expect(found('www.evil.com and https://evil.com')).toEqual([
      'www.evil.com',
      'https://evil.com',
    ]);
  });

  it('does not read the inside of an address twice', () => {
    expect(found('https://evil.test/go?next=evil2.com&b=c.io')).toEqual([
      'https://evil.test/go?next=evil2.com&b=c.io',
    ]);
    expect(found('evil.com?next=evil2.com')).toEqual(['evil.com?next=evil2.com']);
  });

  it('finds the name that the rendered text of the markup spells', () => {
    expect(foreignAddressOf('ev**il**.com', DOMAINS)).toBeNull();
    expect(foreignAddressOfMarkup('ev**il**.com', DOMAINS)).toBe('evil.com');
    expect(foreignAddressOfMarkup('ev**il**.com?x=1', DOMAINS)).toBe('evil.com?x=1');
    expect(foreignAddressOfMarkup('[evil.com](/sale)', DOMAINS)).toBe('evil.com');
    expect(foreignAddressOfMarkup('[the sale](/sale) of evil.com', ['evil.com'])).toBeNull();
  });
});

// An address is read wherever it stands, also right after a colon (a label, a "see:", a time written
// with a colon and a name behind it): the colon is no cover for it, in any of the forms
describe('foreignAddressesOf: an address right after a colon', () => {
  it.each([
    ['a name with no path', 'site:evil.com', 'evil.com'],
    ['a name with no path after a word and a space', 'Our site:evil.com is great', 'evil.com'],
    ['a name with a path', 'see:evil.com/path', 'evil.com/path'],
    ['a name with a query', 'x:evil.com?a', 'evil.com?a'],
    ['a name with a query to the end of the run', 'x:evil.com?a=b&c=d', 'evil.com?a=b&c=d'],
    ['a name with a fragment', 'Note:evil.com#top', 'evil.com#top'],
    ['a name with a port', 'Open:evil.com:8080', 'evil.com:8080'],
    ['a name with a port and a path', 'Open:evil.test:8080/x', 'evil.test:8080/x'],
    ['www with no path', 'Visit:www.evil.test', 'www.evil.test'],
    ['www with a path', 'Visit:www.evil.test/x', 'www.evil.test/x'],
    ['an address with a scheme', 'site:https://evil.test/x', 'https://evil.test/x'],
    ['a name in capitals', 'SITE:EVIL.COM', 'EVIL.COM'],
    ['a name in letters of another alphabet', 'Сайт:пример.рф', 'пример.рф'],
    ['a name in punycode with a path', 'site:xn--80ak6aa92e.com/x', 'xn--80ak6aa92e.com/x'],
    ['a name after two colons', 'a:b:evil.com', 'evil.com'],
    ['a name between a colon and a comma', 'Sale:evil.com, today', 'evil.com'],
    ['a name in round brackets', '(site:evil.com)', 'evil.com'],
    ['a name with a dot after it', 'Go to site:evil.com.', 'evil.com'],
    ['a name on a line of its own after a label', 'Link:\nevil.com', 'evil.com'],
    ['a file name with a real zone', 'File:readme.md', 'readme.md'],
  ])('reads %s', (_name, text, address) => {
    expect(found(text)).toEqual([address]);
  });

  it('reads the name after a colon and the name before it', () => {
    expect(found('evil.com:evil2.com')).toEqual(['evil.com', 'evil2.com']);
    expect(found('first.io/x:second.io')).toEqual(['first.io/x:second.io']);
  });

  it('reads the name an address of the shop leaves behind after a colon', () => {
    expect(found('shop.example:evil.com')).toEqual(['evil.com']);
  });

  it.each([
    ['a time', 'Open at 10:30 and close at 18:45'],
    ['a ratio', 'The ratio is 3:2'],
    ['a decimal after a colon', 'The ratio is 3:2.5 or 10:30.5'],
    ['a word with no dot after a colon', 'Note:see below'],
    ['a word with no dot and no space', 'Note:see'],
    ['a label and a word', 'Sale: now'],
    ['a version after a colon', 'Version:v1.2 is out'],
    ['an abbreviation after a colon', 'Note:e.g. a coat'],
    ['a file with no zone after a colon', 'Open:photo.jpg and File:index.html'],
    ['a date after a colon', 'Date:12.11.2026'],
    ['a time with a dot after a colon', 'Time:9.30'],
    ['a name that is not a zone after a colon', 'Note:evil.test'],
    ['a title after a colon', 'Dear:Mr.Smith'],
    ['an email address after a colon', 'Mail:help@evil.com'],
    ['a mailto', 'mailto:help@evil.com'],
    ['the shop after a colon', 'Visit:shop.example today'],
    ['a link of the shop after a colon', 'Link:https://shop.example/sale'],
    ['a name of the shop with a path after a colon', 'Link:shop.example/sale'],
    ['www of the shop after a colon', 'Link:www.shop.example'],
    ['a subdomain of the shop with a query after a colon', 'Link:cdn.shop.example?x=1'],
    ['a trusted domain after a colon', 'Blog:blog.partner.test/post'],
    ['colons alone', '::: ::: a:b:c:d'],
  ])('leaves %s alone', (_name, text) => {
    expect(found(text)).toEqual([]);
  });

  it('finds the name after a colon in the text of the markup as the reader gets it', () => {
    expect(foreignAddressOf('site:ev**il**.com', DOMAINS)).toBeNull();
    expect(foreignAddressOfMarkup('site:ev**il**.com', DOMAINS)).toBe('evil.com');
    expect(foreignAddressOfMarkup('[site:evil.com](/sale)', DOMAINS)).toBe('evil.com');
    expect(foreignAddressOfMarkup('Visit:shop.example', DOMAINS)).toBeNull();
  });
});

describe('foreignAddressesOf: the worst input', () => {
  it.each([
    ['one long word', 'a'.repeat(200_000)],
    ['dots all the way', 'a.'.repeat(100_000)],
    ['labels with dashes', 'a-'.repeat(100_000)],
    ['dotted words with no slash', 'ab.cd '.repeat(30_000)],
    ['names that end with a real zone', 'evil.com '.repeat(30_000)],
    ['names that end with a real zone and then a dash', 'ab.'.repeat(50_000) + 'cd-'],
    ['names that end with a real zone and then a letter', 'ab.'.repeat(50_000) + 'comx'],
    ['queries after a name', 'evil.com?'.repeat(30_000)],
    [
      'names in the query of an address with a scheme',
      'https://evil.test/?' + 'evil.com&'.repeat(30_000),
    ],
    ['fragments after a name', 'evil.com#'.repeat(30_000)],
    ['schemes with no address', 'http:// '.repeat(30_000)],
    ['colons and slashes', ':/'.repeat(100_000)],
    ['names after a colon', 'x:evil.com '.repeat(30_000)],
    ['dotted words after a colon', 'a:b.cd '.repeat(30_000)],
    ['colons between labels', 'ab:'.repeat(100_000) + 'cd.com'],
    ['colons and dots', ':a.'.repeat(100_000)],
    ['names after a colon and then a dash', 'ab:ab.'.repeat(50_000) + 'cd-'],
    ['many www', 'www.'.repeat(50_000)],
    ['many brackets', '[('.repeat(100_000)],
    ['an address with a long tail', `https://shop.example/${'x'.repeat(200_000)}`],
    ['signs after an address and then a letter', `https://shop.example/${'.'.repeat(100_000)}x`],
    ['signs after a domain with a path and then a letter', `evil.test/${'!?'.repeat(100_000)}x`],
    ['a host that is too long', `https://${'a'.repeat(100_000)}.test/x`],
    ['a host with many labels', `www.${'ab.'.repeat(50_000)}test`],
  ])('reads %s in linear time', (_name, text) => {
    const started = Date.now();
    found(text);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

// A text of the markup is read as typed and as the reader gets it (the plain text of the mail)
describe('foreignAddressOfMarkup', () => {
  it('finds what the pattern finds in the text as typed', () => {
    expect(foreignAddressOfMarkup('See https://evil.test/p and www.other.test', DOMAINS)).toBe(
      'https://evil.test/p',
    );
  });

  it.each([
    ['bold inside the name', 'ev**il**.com/deal', 'evil.com/deal'],
    ['italic inside the zone', 'evil.*com*/deal', 'evil.com/deal'],
    ['bold inside www', 'ww**w**.evil.test', 'www.evil.test'],
    ['a scheme split by bold', 'ht**tps**://evil.test/p', 'https://evil.test/p'],
    ['a control sign inside the name', 'evil\u0000.com/deal', 'evil.com/deal'],
    ['a heading', '# ev**il**.com/deal', 'evil.com/deal'],
    ['an item of a list', '- one\n- ev**il**.com/deal', 'evil.com/deal'],
  ])('finds the address that only the rendered text spells: %s', (_name, markup, address) => {
    // not an address as it is typed
    expect(foreignAddressOf(markup, DOMAINS)).toBeNull();
    expect(foreignAddressOfMarkup(markup, DOMAINS)).toBe(address);
  });

  it('finds the address a label spells', () => {
    expect(foreignAddressOfMarkup('[evil.test/p](/sale)', DOMAINS)).toBe('evil.test/p');
  });

  it('lets in the domains it is given, in any rendering', () => {
    expect(
      foreignAddressOfMarkup('**shop**.example/sale and blog.partner.test/p', DOMAINS),
    ).toBeNull();
    expect(foreignAddressOfMarkup('ev**il**.com/deal', ['evil.com'])).toBeNull();
  });

  it('refuses a text over the size of a markup', () => {
    expect(() => foreignAddressOfMarkup('a'.repeat(6000), DOMAINS)).toThrow();
  });
});
