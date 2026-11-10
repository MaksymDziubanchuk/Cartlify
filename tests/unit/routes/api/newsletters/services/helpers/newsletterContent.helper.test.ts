import { describe, expect, it } from '@jest/globals';

import {
  BESTSELLERS_DEFAULT_PERIOD_DAYS,
  RULE_BLOCK_DEFAULT_LIMIT,
  checkNewsletterContent,
  disabledLocalesOf,
  emptyNewsletterContent,
  languagesOfContent,
  localesForContent,
  missingInContent,
  type NewsletterContentContext,
} from '@routes/api/newsletters/services/helpers/newsletterContent.helper.js';
import type { NewsletterContentDto, NewsletterContentInputDto } from 'types/dto/newsletters.dto.js';

const ORIGIN = 'https://shop.example.com';
const TRUSTED = ['blog.partner.test'];
const DOMAINS = ['shop.example.com', ...TRUSTED];
const CONTEXT: NewsletterContentContext = {
  locales: ['en', 'uk', 'es'],
  origin: ORIGIN,
  domains: DOMAINS,
  trusted: TRUSTED,
};

const check = (content: unknown, context = CONTEXT) =>
  checkNewsletterContent(content as NewsletterContentInputDto, context);

const base = (over: Record<string, unknown> = {}) => ({
  subject: { en: 'Subject' },
  blocks: [],
  ...over,
});
const withText = (text: Record<string, string>) => base({ blocks: [{ type: 'text', text }] });

// what the service says of a content that was sent: the languages must be those of the shop, no
// text may belong to a language that has no subject, and every link must lead to the shop
function refusal(content: unknown, context = CONTEXT) {
  try {
    check(content, context);
  } catch (err) {
    return err as { errorCode: string; statusCode: number; details: Record<string, string> };
  }
  throw new Error('the content was accepted');
}

describe('checkNewsletterContent', () => {
  it('hands back a content that is whole as it was', () => {
    const content = {
      subject: { en: 'Spring', uk: 'Spring uk' },
      preview: { en: 'Up to 30%' },
      blocks: [
        { type: 'text', text: { en: 'Hello **you**', uk: 'Hello uk' } },
        { type: 'products', title: { en: 'Picks' }, source: 'manual', productIds: [1, 2] },
        { type: 'products', source: 'rule', rule: 'bestsellers', limit: 4, periodDays: 7 },
        { type: 'category', categoryId: 3, title: { uk: 'Shoes' } },
        { type: 'button', kind: 'shop', url: '/' },
      ],
    };

    expect(check(content)).toEqual(content);
  });

  it('makes a preview of nothing when there is none', () => {
    expect(check(base())).toEqual({ subject: { en: 'Subject' }, preview: {}, blocks: [] });
  });

  it('does not change the content it was given', () => {
    const content = base({ subject: { en: '  Subject  ' } });
    const before = JSON.stringify(content);

    check(content);

    expect(JSON.stringify(content)).toBe(before);
  });

  it('cuts the spaces around the texts of one line', () => {
    const out = check(
      base({
        subject: { en: '  Subject  ' },
        preview: { en: '  Preview  ' },
        blocks: [
          { type: 'products', title: { en: ' Picks ' }, source: 'manual', productIds: [1] },
          { type: 'category', categoryId: 1, title: { en: ' Shoes ' } },
          { type: 'text', text: { en: '  keep my spaces  ' } },
        ],
      }),
    );

    expect(out.subject).toEqual({ en: 'Subject' });
    expect(out.preview).toEqual({ en: 'Preview' });
    expect(out.blocks[0]).toMatchObject({ title: { en: 'Picks' } });
    expect(out.blocks[1]).toMatchObject({ title: { en: 'Shoes' } });
    // the text of a block is written as it was typed
    expect(out.blocks[2]).toMatchObject({ text: { en: '  keep my spaces  ' } });
  });

  it('takes a draft that is not finished', () => {
    expect(check({ subject: {}, blocks: [] })).toEqual({ subject: {}, preview: {}, blocks: [] });
    expect(check(withText({}))).toMatchObject({ blocks: [{ type: 'text', text: {} }] });
    expect(check(base({ subject: { uk: 'Only uk' } })).subject).toEqual({ uk: 'Only uk' });
  });

  it('takes every language of the shop', () => {
    const subject = { en: 'a', uk: 'b', es: 'c' };

    expect(check(base({ subject })).subject).toEqual(subject);
  });

  it('keeps raw html as the plain text it is: the markup has no html to refuse', () => {
    const html = '<script>alert(1)</script> <img src=x onerror=1>';
    const out = check(withText({ en: html }));

    expect(out.blocks[0]).toMatchObject({ text: { en: html } });
  });

  describe('the languages', () => {
    it.each([
      ['a language the shop does not have', { xx: 'S' }, 'xx'],
      ['a language in capitals', { EN: 'S' }, 'EN'],
      ['a language with a region', { 'en-US': 'S' }, 'en-US'],
      ['a language written out', { english: 'S' }, 'english'],
      ['an empty key', { '': 'S' }, ''],
      ['a key with spaces', { ' en': 'S' }, ' en'],
      ['a key of a prototype', JSON.parse('{"__proto__": "S"}'), '__proto__'],
      ['a key of a constructor', { constructor: 'S' }, 'constructor'],
    ])('refuses %s as a subject', (_name, subject, key) => {
      const err = refusal(base({ subject }));

      expect(err.statusCode).toBe(400);
      expect(err.errorCode).toBe('LOCALE_INVALID');
      expect(err.details).toEqual({ field: `content.subject.${key}`, locale: key });
    });

    it('repeats only the start of a key that is very long', () => {
      const key = 'x'.repeat(100_000);
      const err = refusal(base({ subject: { [key]: 'S' } }));

      expect(err.errorCode).toBe('LOCALE_INVALID');
      expect(err.details.locale).toBe('x'.repeat(40));
      expect(err.details.field).toBe(`content.subject.${'x'.repeat(40)}`);
    });

    it('refuses a language the shop turned off, though a dictionary of it may exist', () => {
      const err = refusal(base({ subject: { uk: 'S' } }), { ...CONTEXT, locales: ['en'] });

      expect(err.errorCode).toBe('LOCALE_INVALID');
      expect(err.details.locale).toBe('uk');
    });

    it('names the place and the language where the first fault is', () => {
      expect(refusal(base({ preview: { xx: 'P' } })).details).toEqual({
        field: 'content.preview.xx',
        locale: 'xx',
      });
      expect(refusal(withText({ en: 'a', xx: 'b' })).details).toEqual({
        field: 'content.blocks[0].text.xx',
        locale: 'xx',
      });
      expect(
        refusal(
          base({
            blocks: [
              { type: 'text', text: { en: 'a' } },
              { type: 'products', title: { zz: 'T' }, source: 'manual', productIds: [1] },
            ],
          }),
        ).details,
      ).toEqual({ field: 'content.blocks[1].title.zz', locale: 'zz' });
      expect(
        refusal(base({ blocks: [{ type: 'category', categoryId: 1, title: { yy: 'T' } }] }))
          .details,
      ).toEqual({ field: 'content.blocks[0].title.yy', locale: 'yy' });
    });

    it('refuses a text, a preview or a title of a language that has no subject', () => {
      const cases: [unknown, string][] = [
        [base({ preview: { uk: 'P' } }), 'content.preview.uk'],
        [withText({ en: 'a', uk: 'b' }), 'content.blocks[0].text.uk'],
        [
          base({
            blocks: [{ type: 'products', title: { uk: 'T' }, source: 'manual', productIds: [1] }],
          }),
          'content.blocks[0].title.uk',
        ],
        [
          base({ blocks: [{ type: 'category', categoryId: 1, title: { es: 'T' } }] }),
          'content.blocks[0].title.es',
        ],
      ];

      for (const [content, field] of cases) {
        const err = refusal(content);

        expect(err.statusCode).toBe(400);
        expect(err.errorCode).toBe('NEWSLETTER_LOCALE_WITHOUT_SUBJECT');
        expect(err.details.field).toBe(field);
      }
    });

    it('says a language is not one of the shop before it says it has no subject', () => {
      expect(refusal(base({ preview: { xx: 'P' } })).errorCode).toBe('LOCALE_INVALID');
    });

    it('judges the languages in the order of the content', () => {
      const err = refusal(
        base({
          subject: { en: 'S' },
          preview: { uk: 'no subject', xx: 'not a language' },
        }),
      );

      expect(err.details.field).toBe('content.preview.uk');
    });
  });

  describe('the links', () => {
    it.each([
      ['a path', '[Sale](/sale)'],
      ['an address of the shop', '[Sale](https://shop.example.com/sale)'],
      ['a path with a query', '[Sale](/sale?a=1&b=2#top)'],
      ['no link at all', 'plain **text** and a - dash'],
      ['a link inside bold', '**[Sale](/sale)**'],
      ['a link in a heading', '# [Sale](/sale)'],
      ['a link in a list', '- [Sale](/sale)\n- [More](/more)'],
      ['a call that is not a link', '[x](javascript:alert(1))'],
      ['brackets that are not a link', '[x] (see below)'],
    ])('lets in %s in a text', (_name, markup) => {
      expect(() => check(withText({ en: markup }))).not.toThrow();
    });

    it.each([
      ['another site', '[x](https://evil.example.org/p)'],
      ['a site whose name starts with the shop', '[x](https://shop.example.com.evil.example.org/)'],
      ['a protocol-relative address', '[x](//evil.example.org)'],
      ['a javascript address', '[x](javascript:alert)'],
      ['a javascript address in capitals', '[x](JAVASCRIPT:alert)'],
      ['a data address', '[x](data:text/html;base64,PHNjcmlwdD4=)'],
      ['a mail address', '[x](mailto:a@example.com)'],
      ['a file address', '[x](file:///etc/passwd)'],
      ['a relative path', '[x](sale)'],
      ['a fragment', '[x](#top)'],
      ['an address with a user name', '[x](https://user@shop.example.com/)'],
      ['the shop over http', '[x](http://shop.example.com/)'],
      ['a link in bold', '**[x](https://evil.example.org)**'],
      ['a link in a heading', '# [x](https://evil.example.org)'],
      ['a link in a list', '- [ok](/ok)\n- [x](https://evil.example.org)'],
    ])('refuses %s in a text', (_name, markup) => {
      const err = refusal(withText({ en: markup }));

      expect(err.statusCode).toBe(400);
      expect(err.errorCode).toBe('NEWSLETTER_LINK_NOT_ALLOWED');
      expect(err.details.field).toBe('content.blocks[0].text.en');
    });

    it('names the language, the block and the address of the first link that is not allowed', () => {
      const err = refusal(
        base({
          subject: { en: 'S', uk: 'S' },
          blocks: [
            { type: 'text', text: { en: '[ok](/a)', uk: '[ok](/b)' } },
            { type: 'text', text: { en: '[ok](/a)', uk: '[bad](https://evil.example.org/x)' } },
          ],
        }),
      );

      expect(err.details).toEqual({
        field: 'content.blocks[1].text.uk',
        url: 'https://evil.example.org/x',
      });
    });

    it.each([
      ['a path', '/sale'],
      ['an address of the shop', 'https://shop.example.com/sale'],
    ])('lets in %s for a button', (_name, url) => {
      expect(() => check(base({ blocks: [{ type: 'button', kind: 'sale', url }] }))).not.toThrow();
    });

    it.each([
      ['another site', 'https://evil.example.org/'],
      ['a protocol-relative address', '//evil.example.org'],
      ['a javascript address', 'javascript:alert(1)'],
      ['a data address', 'data:text/html,x'],
      ['a relative path', 'sale'],
      ['a path with a space', '/a b'],
      ['a path with a new line', '/a\nb'],
      ['a backslash', '/\\evil.example.org'],
    ])('refuses %s for a button', (_name, url) => {
      const err = refusal(
        base({
          blocks: [
            { type: 'text', text: { en: 'a' } },
            { type: 'button', kind: 'shop', url },
          ],
        }),
      );

      expect(err.statusCode).toBe(400);
      expect(err.errorCode).toBe('NEWSLETTER_LINK_NOT_ALLOWED');
      expect(err.details).toEqual({ field: 'content.blocks[1].url', url });
    });

    // a link may lead to a site root trusts as well (context.trusted, its subdomains too): an absolute
    // address of http or https; a path is the shop's, whatever the trusted sites are
    describe('to a site root trusts', () => {
      it.each([
        ['a trusted site', '[x](https://blog.partner.test/post)'],
        ['a trusted site over http', '[x](http://blog.partner.test/post)'],
        ['a subdomain of a trusted site', '[x](https://www.blog.partner.test/post)'],
        ['a trusted site with a query and a fragment', '[x](https://blog.partner.test/p?a=1#top)'],
        ['a trusted site in bold', '**[x](https://blog.partner.test/post)**'],
        ['a trusted site in a heading', '# [x](https://blog.partner.test/post)'],
        ['a trusted site in a list', '- [ok](/ok)\n- [x](https://blog.partner.test/post)'],
      ])('lets in %s in a text', (_name, markup) => {
        expect(() => check(withText({ en: markup }))).not.toThrow();
      });

      it.each([
        ['the parent of a trusted site', '[x](https://partner.test/post)'],
        ['a sibling of a trusted site', '[x](https://news.partner.test/post)'],
        [
          'a site that starts like a trusted one',
          '[x](https://blog.partner.test.evil.example.org/)',
        ],
        ['a site that ends like a trusted one', '[x](https://evilblog.partner.test/)'],
        ['a trusted site as a user name', '[x](https://blog.partner.test@evil.example.org/)'],
        ['a trusted site with a user name', '[x](https://user@blog.partner.test/)'],
        ['a trusted site as a protocol-relative address', '[x](//blog.partner.test/post)'],
        ['a trusted site without a scheme', '[x](blog.partner.test/post)'],
        ['a trusted site under another scheme', '[x](ftp://blog.partner.test/post)'],
        ['a subdomain of the shop (not trusted)', '[x](https://cdn.shop.example.com/a)'],
      ])('still refuses %s', (_name, markup) => {
        const err = refusal(withText({ en: markup }));

        expect(err.errorCode).toBe('NEWSLETTER_LINK_NOT_ALLOWED');
        expect(err.details.field).toBe('content.blocks[0].text.en');
      });

      it('lets in a button to a trusted site, and a subdomain of it', () => {
        for (const url of ['https://blog.partner.test/post', 'https://www.blog.partner.test/']) {
          expect(() =>
            check(base({ blocks: [{ type: 'button', kind: 'shop', url }] })),
          ).not.toThrow();
        }
      });

      it.each([
        ['the parent of a trusted site', 'https://partner.test/post'],
        ['a site that starts like a trusted one', 'https://blog.partner.test.evil.example.org/'],
        ['a trusted site with a user name', 'https://user:pass@blog.partner.test/'],
        ['a trusted site as a protocol-relative address', '//blog.partner.test/post'],
        ['a trusted site without a scheme', 'blog.partner.test/post'],
        ['another site', 'https://evil.example.org/'],
      ])('still refuses a button to %s', (_name, url) => {
        const err = refusal(base({ blocks: [{ type: 'button', kind: 'shop', url }] }));

        expect(err.errorCode).toBe('NEWSLETTER_LINK_NOT_ALLOWED');
        expect(err.details).toEqual({ field: 'content.blocks[0].url', url });
      });

      it('refuses every address when no site is trusted', () => {
        const none = { ...CONTEXT, trusted: [] };

        expect(
          refusal(withText({ en: '[x](https://blog.partner.test/post)' }), none).errorCode,
        ).toBe('NEWSLETTER_LINK_NOT_ALLOWED');
        expect(
          refusal(
            base({ blocks: [{ type: 'button', kind: 'shop', url: 'https://blog.partner.test/' }] }),
            none,
          ).errorCode,
        ).toBe('NEWSLETTER_LINK_NOT_ALLOWED');
      });

      it('lets in a trusted site even when the shop has no address', () => {
        const noShop = { ...CONTEXT, origin: null };

        expect(() =>
          check(withText({ en: '[x](https://blog.partner.test/post)' }), noShop),
        ).not.toThrow();
        expect(refusal(withText({ en: '[x](/sale)' }), noShop).errorCode).toBe(
          'NEWSLETTER_LINK_NOT_ALLOWED',
        );
      });
    });

    it('cuts a long address in the answer', () => {
      const err = refusal(
        base({ blocks: [{ type: 'button', kind: 'shop', url: `//${'a'.repeat(1500)}` }] }),
      );

      expect(err.details.url!.length).toBeLessThanOrEqual(200);
    });

    it('refuses every link when the shop has no address, even a path', () => {
      const err = refusal(withText({ en: '[x](/sale)' }), { ...CONTEXT, origin: null });

      expect(err.errorCode).toBe('NEWSLETTER_LINK_NOT_ALLOWED');
    });

    it('does not read the links of a language it already refused', () => {
      const err = refusal(withText({ xx: '[x](https://evil.example.org)' }));

      expect(err.errorCode).toBe('LOCALE_INVALID');
    });
  });

  // An address written out in a text (with a scheme, with www, or a domain with a path) is judged
  // apart from a link of the markup: it leads where the reader's mail program takes it. It must
  // be of the shop or of a domain root trusts (context.domains, subdomains included)
  describe('the addresses of other sites in a text', () => {
    const addressRefusal = (content: unknown, context = CONTEXT) => {
      const err = refusal(content, context);

      expect(err.statusCode).toBe(400);
      expect(err.errorCode).toBe('NEWSLETTER_ADDRESS_NOT_ALLOWED');

      return err;
    };

    it.each([
      ['an address of the shop', 'See https://shop.example.com/sale now'],
      ['an address of a subdomain of the shop', 'See https://cdn.shop.example.com/a.png'],
      ['www of the shop', 'See www.shop.example.com/sale'],
      ['a domain of the shop with a path', 'See shop.example.com/sale'],
      ['an address of a trusted domain', 'Read https://blog.partner.test/post'],
      ['a trusted domain with a path', 'Read blog.partner.test/post'],
      ['a subdomain of a trusted domain', 'Read www.blog.partner.test/post'],
      ['a link of the markup to the shop', '[the sale](https://shop.example.com/sale)'],
      ['a path of the shop', '[the sale](/sale) or /new'],
      ['a plain domain, which is no address by itself', 'Mail help@evil.test, shop evil.test'],
      ['words with dots', 'e.g. 9.00/10.00 and/or i.e. the end.'],
    ])('lets in %s', (_name, text) => {
      expect(() => check(withText({ en: text }))).not.toThrow();
      expect(() => check(base({ subject: { en: text } }))).not.toThrow();
    });

    it.each([
      ['https', 'See https://evil.test/p', 'https://evil.test/p'],
      ['http in capitals', 'See HTTP://EVIL.TEST', 'HTTP://EVIL.TEST'],
      ['www', 'See www.evil.test', 'www.evil.test'],
      ['a domain with a path', 'See evil.test/p', 'evil.test/p'],
      [
        'a name with the shop in front',
        'See https://shop.example.com.evil.test/',
        'https://shop.example.com.evil.test/',
      ],
      [
        'a name with the shop as a login',
        'See https://shop.example.com@evil.test/',
        'https://shop.example.com@evil.test/',
      ],
      [
        'a name that ends like the shop',
        'See https://evilshop.example.com/',
        'https://evilshop.example.com/',
      ],
      [
        'an address in brackets and a full stop',
        'See (https://evil.test/p).',
        'https://evil.test/p',
      ],
      ['an address in bold', 'See **www.evil.test**', 'www.evil.test'],
      // it was let in as "brackets that are not a link" before the addresses were judged
      [
        'an address after brackets that are no link',
        '[x] (https://evil.test)',
        'https://evil.test',
      ],
      ['an address in the label of a link', '[evil.test/p](/sale)', 'evil.test/p'],
      ['a name of another alphabet', 'See https://пример.рф/p', 'https://пример.рф/p'],
      ['a name in punycode', 'See xn--e1afmkfd.xn--p1ai/p', 'xn--e1afmkfd.xn--p1ai/p'],
    ])('refuses %s in a text', (_name, text, address) => {
      const err = addressRefusal(withText({ en: text }));

      expect(err.details).toEqual({ field: 'content.blocks[0].text.en', address });
    });

    // The reader gets the text the markup makes, not the markup: a marker that splits a name, or a sign
    // the mail drops, does not hide an address from the mail program that makes it a link
    it.each([
      ['bold inside the name', 'See ev**il**.com/deal', 'evil.com/deal'],
      ['italic inside the zone', 'See evil.*com*/deal', 'evil.com/deal'],
      ['bold around the dot', 'See evil**.**com/deal', 'evil.com/deal'],
      ['bold inside www', 'See ww**w**.evil.test', 'www.evil.test'],
      ['bold inside a scheme', 'See ht**tps**://evil.test/p', 'https://evil.test/p'],
      ['a control sign inside the name', 'See evil\u0000.com/deal', 'evil.com/deal'],
      ['a marker in a heading', '# Sale ev**il**.com/deal', 'evil.com/deal'],
      ['a marker in an item of a list', '- one\n- ev**il**.com/deal', 'evil.com/deal'],
    ])('refuses an address that only the rendered text spells: %s', (_name, text, address) => {
      const err = addressRefusal(withText({ en: text }));

      expect(err.details).toEqual({ field: 'content.blocks[0].text.en', address });
    });

    it('lets in markers that make no address of the rendered text', () => {
      for (const text of [
        'Save **10.00/month** or *5.5/week*',
        'See **shop**.example.com/sale',
        'See [the sale](/sale) **now**',
        'Read **blog**.partner.test/post',
      ]) {
        expect(() => check(withText({ en: text }))).not.toThrow();
      }
    });

    it('reads a line as it is written: the markers of a subject or a title are no markup', () => {
      const text = 'See ev**il**.com/deal';

      expect(() => check(base({ subject: { en: text } }))).not.toThrow();
      expect(() => check(base({ preview: { en: text } }))).not.toThrow();
    });

    it('refuses an address in every place a text of the mail is written', () => {
      const bad = 'See https://evil.test/p';
      const address = 'https://evil.test/p';

      expect(addressRefusal(base({ subject: { en: bad } })).details).toEqual({
        field: 'content.subject.en',
        address,
      });
      expect(addressRefusal(base({ preview: { en: bad } })).details).toEqual({
        field: 'content.preview.en',
        address,
      });
      expect(
        addressRefusal(
          base({
            blocks: [
              { type: 'text', text: { en: 'fine' } },
              { type: 'products', title: { en: bad }, source: 'manual', productIds: [1] },
            ],
          }),
        ).details,
      ).toEqual({ field: 'content.blocks[1].title.en', address });
      expect(
        addressRefusal(base({ blocks: [{ type: 'category', categoryId: 1, title: { en: bad } }] }))
          .details,
      ).toEqual({ field: 'content.blocks[0].title.en', address });
    });

    it('names the language of the text that has the address', () => {
      const err = addressRefusal(
        base({
          subject: { en: 'S', uk: 'S' },
          blocks: [{ type: 'text', text: { en: 'fine', uk: 'bad www.evil.test' } }],
        }),
      );

      expect(err.details).toEqual({ field: 'content.blocks[0].text.uk', address: 'www.evil.test' });
    });

    it('names the first address of the content, in the order it is written', () => {
      const err = addressRefusal(
        base({
          subject: { en: 'S' },
          preview: { en: 'see www.second.test' },
          blocks: [{ type: 'text', text: { en: 'see www.third.test' } }],
        }),
      );

      expect(err.details).toEqual({ field: 'content.preview.en', address: 'www.second.test' });
    });

    it('names the first address of a text that has several', () => {
      const err = addressRefusal(withText({ en: 'a www.first.test b https://second.test/x' }));

      expect(err.details).toMatchObject({ address: 'www.first.test' });
    });

    it('refuses the link of the markup to another site as a link, not as an address', () => {
      const err = refusal(withText({ en: '[x](https://evil.test/p) www.other.test' }));

      expect(err.errorCode).toBe('NEWSLETTER_LINK_NOT_ALLOWED');
    });

    it('judges the address that is no link of the markup after the links are judged', () => {
      const err = addressRefusal(withText({ en: '[ok](/sale) and www.evil.test' }));

      expect(err.details).toMatchObject({ address: 'www.evil.test' });
    });

    it('does not read the addresses of a language it already refused', () => {
      const err = refusal(base({ subject: { xx: 'S https://evil.test' } }));

      expect(err.errorCode).toBe('LOCALE_INVALID');
    });

    it('does not read the address of a text of a language that has no subject', () => {
      const err = refusal(base({ preview: { uk: 'see www.evil.test' } }));

      expect(err.errorCode).toBe('NEWSLETTER_LOCALE_WITHOUT_SUBJECT');
    });

    it('lets in a button to the shop: the address of a button is judged as a link', () => {
      expect(() =>
        check(
          base({ blocks: [{ type: 'button', kind: 'shop', url: 'https://shop.example.com/' }] }),
        ),
      ).not.toThrow();
    });

    it('lets in only the trusted domains it is given', () => {
      const text = 'Read https://blog.partner.test/post';

      expect(() => check(withText({ en: text }))).not.toThrow();
      expect(addressRefusal(withText({ en: text }), { ...CONTEXT, domains: [] }).details).toEqual({
        field: 'content.blocks[0].text.en',
        address: 'https://blog.partner.test/post',
      });
    });

    it("refuses every address when there are no domains, the shop's own included", () => {
      const err = addressRefusal(withText({ en: 'See https://shop.example.com/sale' }), {
        ...CONTEXT,
        domains: [],
      });

      expect(err.details).toMatchObject({ address: 'https://shop.example.com/sale' });
    });

    it('cuts a long address in the answer', () => {
      const err = addressRefusal(withText({ en: `see https://evil.test/${'a'.repeat(1500)}` }));

      expect(err.details.address!.length).toBeLessThanOrEqual(200);
    });
  });
});

describe('emptyNewsletterContent', () => {
  it('is a content of no language and no block, which the check takes', () => {
    expect(emptyNewsletterContent()).toEqual({ subject: {}, preview: {}, blocks: [] });
    expect(check(emptyNewsletterContent())).toEqual(emptyNewsletterContent());
  });

  it('is a new object every time', () => {
    expect(emptyNewsletterContent()).not.toBe(emptyNewsletterContent());
  });
});

describe('languagesOfContent', () => {
  it('lists the languages that have a subject, in the order they were given', () => {
    expect(languagesOfContent(check(base({ subject: { uk: 'a', en: 'b' } })))).toEqual([
      'uk',
      'en',
    ]);
    expect(languagesOfContent(emptyNewsletterContent())).toEqual([]);
  });
});

describe('the defaults of a block of products', () => {
  it('are numbers the mail can use when the block leaves them out', () => {
    expect(RULE_BLOCK_DEFAULT_LIMIT).toBe(4);
    expect(BESTSELLERS_DEFAULT_PERIOD_DAYS).toBe(30);
  });
});

// A content is whole when it can go out: a block at least, the subject of the language of the shop,
// every text and title the blocks have in the language of the shop, and every other language that has
// a subject has all of its texts. A preview is never required
describe('missingInContent', () => {
  // the function judges a content the way it is stored, without the check of the languages (a
  // content may hold a text of a language with no subject here, to see it is not asked for)
  const whole = (over: Record<string, unknown> = {}) =>
    ({
      preview: {},
      subject: { en: 'Subject', es: 'Asunto' },
      blocks: [
        { type: 'text', text: { en: 'Hello', es: 'Hola' } },
        {
          type: 'products',
          source: 'manual',
          productIds: [1],
          title: { en: 'Picks', es: 'Ideas' },
        },
        { type: 'category', categoryId: 3 },
        { type: 'button', kind: 'shop', url: '/' },
      ],
      ...over,
    }) as unknown as NewsletterContentDto;

  const missing = (
    content: NewsletterContentDto,
    shopLocale = 'en',
    enabled: readonly string[] = ['en', 'es', 'uk'],
  ) => missingInContent(content, shopLocale, enabled);

  it('finds nothing missing in a whole content', () => {
    expect(missing(whole())).toEqual([]);
  });

  it('wants a block at least', () => {
    expect(missing(whole({ blocks: [] }))).toEqual([{ field: 'content.blocks', locale: null }]);
  });

  it('wants the subject of the language of the shop, whatever other subjects there are', () => {
    expect(missing(whole({ subject: { es: 'Asunto' } }))).toEqual([
      { field: 'content.subject.en', locale: 'en' },
    ]);
    expect(missing(whole({ subject: {} }), 'en')[0]).toEqual({
      field: 'content.subject.en',
      locale: 'en',
    });
  });

  it('takes the language of the shop it is told, not en', () => {
    const content = check({
      subject: { uk: 'Тема' },
      blocks: [{ type: 'text', text: { uk: 'Текст' } }],
    });

    expect(missing(content, 'uk')).toEqual([]);
    expect(missing(content, 'en')).toEqual([
      { field: 'content.subject.en', locale: 'en' },
      { field: 'content.blocks[0].text.en', locale: 'en' },
    ]);
  });

  it('wants the text of every text block in the language of the shop', () => {
    const content = whole({
      subject: { en: 'Subject' },
      blocks: [
        { type: 'text', text: { en: 'one' } },
        { type: 'text', text: {} },
        { type: 'text', text: { en: 'three' } },
      ],
    });

    expect(missing(content)).toEqual([{ field: 'content.blocks[1].text.en', locale: 'en' }]);
  });

  it('counts a text of spaces only as missing', () => {
    const content = whole({
      subject: { en: 'Subject' },
      blocks: [{ type: 'text', text: { en: '   \n  ' } }],
    });

    expect(missing(content)).toEqual([{ field: 'content.blocks[0].text.en', locale: 'en' }]);
  });

  it('wants the title of a block in the language of the shop when the block has a title in another', () => {
    const content = whole({
      subject: { en: 'Subject', es: 'Asunto' },
      blocks: [
        { type: 'products', source: 'manual', productIds: [1], title: { es: 'Ideas' } },
        { type: 'category', categoryId: 3, title: { es: 'Zapatos' } },
      ],
    });

    expect(missing(content)).toEqual([
      { field: 'content.blocks[0].title.en', locale: 'en' },
      { field: 'content.blocks[1].title.en', locale: 'en' },
    ]);
  });

  it('does not want a title a block does not have in any language', () => {
    const content = whole({
      subject: { en: 'Subject', es: 'Asunto' },
      blocks: [
        { type: 'products', source: 'rule', rule: 'new' },
        { type: 'category', categoryId: 3, title: {} },
        { type: 'button', kind: 'sale', url: '/sale' },
        { type: 'text', text: { en: 'Hi', es: 'Hola' } },
      ],
    });

    expect(missing(content)).toEqual([]);
  });

  it('wants every text of the other languages that have a subject', () => {
    const content = whole({
      subject: { en: 'Subject', es: 'Asunto' },
      blocks: [
        { type: 'text', text: { en: 'one' } },
        { type: 'products', source: 'manual', productIds: [1], title: { en: 'Picks' } },
        { type: 'text', text: { en: 'three', es: 'tres' } },
      ],
    });

    expect(missing(content)).toEqual([
      { field: 'content.blocks[0].text.es', locale: 'es' },
      { field: 'content.blocks[1].title.es', locale: 'es' },
    ]);
  });

  it('wants nothing of a language that has no subject', () => {
    // the check of a saved content keeps such a text out; the function does not depend on it
    const content = {
      subject: { en: 'Subject' },
      preview: {},
      blocks: [{ type: 'text', text: { en: 'one', es: 'uno' } }],
    } as unknown as NewsletterContentDto;

    expect(missing(content)).toEqual([]);
  });

  it('lists the language of the shop first, then the others in the order of their subjects, block by block', () => {
    const content = check({
      subject: { uk: 'a', es: 'b', en: 'c' },
      blocks: [
        { type: 'text', text: {} },
        { type: 'text', text: {} },
      ],
    });

    expect(missing(content)).toEqual([
      { field: 'content.blocks[0].text.en', locale: 'en' },
      { field: 'content.blocks[1].text.en', locale: 'en' },
      { field: 'content.blocks[0].text.uk', locale: 'uk' },
      { field: 'content.blocks[1].text.uk', locale: 'uk' },
      { field: 'content.blocks[0].text.es', locale: 'es' },
      { field: 'content.blocks[1].text.es', locale: 'es' },
    ]);
  });

  it('puts what is missing of the subject and the blocks together, without a repeat', () => {
    const content = check({ subject: { es: 'b' }, blocks: [{ type: 'text', text: {} }] });

    expect(missing(content)).toEqual([
      { field: 'content.subject.en', locale: 'en' },
      { field: 'content.blocks[0].text.en', locale: 'en' },
      { field: 'content.blocks[0].text.es', locale: 'es' },
    ]);
  });

  it('does not want a preview', () => {
    expect(missing(whole({ preview: {} }))).toEqual([]);
    expect(missing(whole({ preview: { es: 'Vista' } }))).toEqual([]);
  });

  it('says a campaign with no block is missing a block, and nothing else when the rest is there', () => {
    const content = check({ subject: { en: 'Subject' }, blocks: [] });

    expect(missing(content)).toEqual([{ field: 'content.blocks', locale: null }]);
  });

  // the text of a language root turned off stays in the campaign and does not go out (nobody has the
  // language any more), so what it still lacks is no reason to keep the campaign from going out
  describe('a language the shop has turned off', () => {
    const withUk = () =>
      whole({
        subject: { en: 'Subject', es: 'Asunto', uk: 'Тема' },
        blocks: [{ type: 'text', text: { en: 'one', es: 'uno' } }],
      });

    it('wants nothing of it', () => {
      expect(missing(withUk(), 'en', ['en', 'es'])).toEqual([]);
    });

    it('wants it as any other language the moment it is turned on again', () => {
      expect(missing(withUk(), 'en', ['en', 'es', 'uk'])).toEqual([
        { field: 'content.blocks[0].text.uk', locale: 'uk' },
      ]);
    });

    it('still wants what the languages that are on lack', () => {
      const content = whole({
        subject: { en: 'Subject', es: 'Asunto', uk: 'Тема' },
        blocks: [{ type: 'text', text: { en: 'one' } }],
      });

      expect(missing(content, 'en', ['en', 'es'])).toEqual([
        { field: 'content.blocks[0].text.es', locale: 'es' },
      ]);
    });

    it('wants nothing of its subject either', () => {
      const content = whole({
        subject: { en: 'Subject', uk: '   ' },
        blocks: [{ type: 'text', text: { en: 'one' } }],
      });

      expect(missing(content, 'en', ['en'])).toEqual([]);
    });
  });
});

// the languages of a campaign the shop does not answer in: the ones that have a subject in it
describe('disabledLocalesOf', () => {
  const stored = (subject: Record<string, string>) => ({ subject, preview: {}, blocks: [] });

  it('names the languages with a subject that the shop does not answer in, by their codes', () => {
    expect(disabledLocalesOf(stored({ uk: 'a', en: 'b', es: 'c' }), ['en'])).toEqual(['es', 'uk']);
  });

  it('names none when the shop answers in all of them', () => {
    expect(disabledLocalesOf(stored({ uk: 'a', en: 'b' }), ['en', 'uk', 'es'])).toEqual([]);
  });

  it('names none for a content with no subject, and reads what is no content as none', () => {
    expect(disabledLocalesOf(stored({}), ['en'])).toEqual([]);
    expect(disabledLocalesOf(null, ['en'])).toEqual([]);
    expect(disabledLocalesOf(undefined, ['en'])).toEqual([]);
    expect(disabledLocalesOf('text', ['en'])).toEqual([]);
    expect(disabledLocalesOf({ blocks: [] }, ['en'])).toEqual([]);
    expect(disabledLocalesOf({ subject: ['uk'] }, ['en'])).toEqual([]);
  });

  it('does not look at the texts of a language that has no subject', () => {
    const content = { subject: { en: 'a' }, preview: { uk: 'p' }, blocks: [] };

    expect(disabledLocalesOf(content, ['en'])).toEqual([]);
  });
});

// the languages a new content may be written in when it replaces a stored one: the languages of the
// shop, and the ones the stored content already has that the shop has turned off since and that still
// have a dictionary. A text in a language the shop does not answer in is never new
describe('localesForContent', () => {
  const stored = (subject: Record<string, string>) => ({ subject, preview: {}, blocks: [] });

  it('is the languages of the shop for a content that was never stored', () => {
    expect(localesForContent(['en', 'es'])).toEqual(['en', 'es']);
    expect(localesForContent(['en', 'es'], null)).toEqual(['en', 'es']);
  });

  it('adds the languages the stored content has a subject in that the shop turned off', () => {
    expect(localesForContent(['en'], stored({ en: 'a', uk: 'b', es: 'c' }))).toEqual([
      'en',
      'es',
      'uk',
    ]);
  });

  it('adds nothing the stored content does not have', () => {
    expect(localesForContent(['en'], stored({ en: 'a' }))).toEqual(['en']);
  });

  it('does not keep a language that has no dictionary any more', () => {
    expect(localesForContent(['en'], stored({ en: 'a', xx: 'b', uk: 'c' }))).toEqual(['en', 'uk']);
  });

  it('names a language of the shop once', () => {
    expect(localesForContent(['en', 'uk'], stored({ en: 'a', uk: 'b' }))).toEqual(['en', 'uk']);
  });
});
