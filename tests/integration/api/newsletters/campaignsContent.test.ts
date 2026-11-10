import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { webOrigin } from '@helpers/webOrigin.js';

import { startApp, stopApp } from '../../../helpers/app.js';
import { accessCookie } from '../../../helpers/actors.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  campaignApi,
  campaignRowOf,
  draftOf,
  forgetCampaigns,
  moveTo,
  type CampaignApi,
} from '../../../helpers/newsletterCampaigns.js';
import {
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../../helpers/newsletterStaff.js';
import { resetShopSettings, setShopSettings } from '../../../helpers/shopSettings.js';

// What the content of a campaign may hold, through the two routes that take it: POST (the content of
// a new draft) and PATCH (the whole new content of one). The same rules hold for both. The shape of
// each block and its limits are the unit test of the schema (newslettersCampaign.dtoSchemas); here
// they are tried through the app, which has to use the strict validator for them (nothing converted,
// nothing dropped), and the rules that depend on the shop are tried one by one: the languages and the
// links

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
let api: CampaignApi;
const made: number[] = [];
let spare = 0;

// each route takes a content its own way; both give back the answer of the route
type Submit = (content: unknown) => Promise<LightMyRequestResponse>;

const viaCreate: Submit = async (content) => {
  const res = await api.create(staff.manager, { name: 'Content check', content });
  if (res.statusCode === 201) made.push(res.json().id as number);
  return res;
};

const viaUpdate: Submit = async (content) => {
  if (!spare) {
    spare = await draftOf(api, staff.manager, { name: 'Content target' });
    made.push(spare);
  }
  return api.update(staff.manager, spare, { content });
};

const OK = { create: 201, update: 200 } as const;

const subject = { en: 'Subject', es: 'Asunto' };
const withBlocks = (...blocks: unknown[]) => ({ subject, blocks });
const text = (en: string, extra: Record<string, string> = {}) => ({
  type: 'text',
  text: { en, ...extra },
});

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  staff = await createNewsletterStaff();
  api = campaignApi(app, csrf);
});

afterEach(() => {
  resetShopSettings();
});

afterAll(async () => {
  try {
    await forgetCampaigns(api, staff.manager, made);
    await closeStaff(staff);
  } finally {
    await stopApp();
  }
});

describe.each([
  ['POST /api/newsletters/campaigns', viaCreate, 'create'],
  ['PATCH /api/newsletters/campaigns/:campaignId', viaUpdate, 'update'],
] as const)('%s', (_name, submit, kind) => {
  const accepted = OK[kind];

  describe('the blocks', () => {
    it('takes every kind of block and gives the content back as it was sent', async () => {
      const content = {
        subject,
        preview: { en: 'Preview' },
        blocks: [
          text('# Title\n**bold** and *italic*\n\n- one\n- two\n\n[the sale](/sale)'),
          {
            type: 'products',
            title: { en: 'Picks', es: 'Selección' },
            source: 'manual',
            productIds: [3, 1, 2],
          },
          { type: 'products', source: 'rule', rule: 'new' },
          { type: 'products', source: 'rule', rule: 'sale', limit: 12, categoryId: 4 },
          { type: 'products', source: 'rule', rule: 'popular', limit: 1 },
          { type: 'products', source: 'rule', rule: 'top_rated' },
          { type: 'products', source: 'rule', rule: 'bestsellers', periodDays: 90 },
          { type: 'category', categoryId: 9 },
          { type: 'category', categoryId: 9, title: { en: 'Shoes' } },
          { type: 'button', kind: 'product', url: '/products/12' },
        ],
      };

      const res = await submit(content);

      expect(res.statusCode).toBe(accepted);
      expect(res.json().content).toEqual(content);
    });

    it('keeps the order of the blocks and of the products', async () => {
      const res = await submit(
        withBlocks(
          { type: 'button', kind: 'new', url: '/new' },
          { type: 'products', source: 'manual', productIds: [9, 4, 7] },
          text('last'),
        ),
      );

      expect(res.json().content.blocks.map((block: { type: string }) => block.type)).toEqual([
        'button',
        'products',
        'text',
      ]);
      expect(res.json().content.blocks[1].productIds).toEqual([9, 4, 7]);
    });

    it('takes the most blocks a mail has and refuses one more', async () => {
      const block = text('a');

      expect((await submit(withBlocks(...Array(10).fill(block)))).statusCode).toBe(accepted);

      const res = await submit(withBlocks(...Array(11).fill(block)));
      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('VALIDATION_ERROR');
    });

    it('takes the most products a block has and refuses one more', async () => {
      const ids = (count: number) => Array.from({ length: count }, (_, i) => i + 1);
      const products = (count: number) => ({
        type: 'products',
        source: 'manual',
        productIds: ids(count),
      });

      expect((await submit(withBlocks(products(12)))).statusCode).toBe(accepted);
      expect((await submit(withBlocks(products(13)))).statusCode).toBe(400);
      expect((await submit(withBlocks(products(0)))).statusCode).toBe(400);
    });

    it('takes the longest text and refuses one a sign longer', async () => {
      expect((await submit(withBlocks(text('a'.repeat(5000))))).statusCode).toBe(accepted);
      expect((await submit(withBlocks(text('a'.repeat(5001))))).statusCode).toBe(400);
    });

    it('takes the content with the most that every limit allows', async () => {
      const full = text('a'.repeat(5000), { es: 'b'.repeat(5000) });
      const res = await submit({ subject, preview: subject, blocks: Array(10).fill(full) });

      expect(res.statusCode).toBe(accepted);
    });

    it.each([
      ['a block of a kind there is none of', { type: 'banner' }],
      ['a text with a field of its own', { type: 'text', text: { en: 'a' }, html: '<b>x</b>' }],
      ['a text that is a number', { type: 'text', text: { en: 5 } }],
      ['a product id that is a text', { type: 'products', source: 'manual', productIds: ['1'] }],
      ['a product id of zero', { type: 'products', source: 'manual', productIds: [0] }],
      ['a product twice', { type: 'products', source: 'manual', productIds: [1, 1] }],
      [
        'a manual block with a rule',
        { type: 'products', source: 'manual', productIds: [1], rule: 'new' },
      ],
      [
        'a rule block with products',
        { type: 'products', source: 'rule', rule: 'new', productIds: [1] },
      ],
      [
        'a period for a rule that has none',
        { type: 'products', source: 'rule', rule: 'new', periodDays: 7 },
      ],
      ['a limit past the most', { type: 'products', source: 'rule', rule: 'new', limit: 13 }],
      ['a limit that is a text', { type: 'products', source: 'rule', rule: 'new', limit: '4' }],
      ['a category that is a text', { type: 'category', categoryId: '3' }],
      [
        'a button with a label of free text',
        { type: 'button', kind: 'shop', url: '/', label: 'Go' },
      ],
      ['a button of a kind there is none of', { type: 'button', kind: 'link', url: '/' }],
    ])('refuses %s, and converts or drops nothing', async (_name, block) => {
      const res = await submit(withBlocks(block));

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('VALIDATION_ERROR');
    });

    it.each([
      ['a subject with a new line', { subject: { en: 'a\nb' }, blocks: [] }],
      ['a subject of spaces', { subject: { en: '   ' }, blocks: [] }],
      ['a subject that is too long', { subject: { en: 'a'.repeat(151) }, blocks: [] }],
      ['a preview that is too long', { subject, preview: { en: 'a'.repeat(151) }, blocks: [] }],
      ['no subject', { blocks: [] }],
      ['no blocks', { subject }],
      ['a field that is not known', { subject, blocks: [], footer: 'x' }],
    ])('refuses %s', async (_name, content) => {
      const res = await submit(content);

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('VALIDATION_ERROR');
    });
  });

  describe('a draft that is not finished', () => {
    it.each([
      ['no language at all', { subject: {}, blocks: [] }],
      ['no block yet', { subject: { en: 'Subject' }, blocks: [] }],
      [
        'the language of the shop missing',
        { subject: { es: 'Solo espanol' }, blocks: [{ type: 'text', text: {} }] },
      ],
      ['a text block of no language', withBlocks({ type: 'text', text: {} })],
      [
        'a block with a title of no language',
        withBlocks({ type: 'category', categoryId: 1, title: {} }),
      ],
    ])('is taken with %s', async (_name, content) => {
      const res = await submit(content);

      expect(res.statusCode).toBe(accepted);
    });
  });

  describe('the languages', () => {
    it.each([
      ['a language the shop does not have', { xx: 'S' }, 'xx'],
      ['a language in capitals', { EN: 'S' }, 'EN'],
      ['a language with a region', { 'en-GB': 'S' }, 'en-GB'],
      ['a language written out', { english: 'S' }, 'english'],
      ['an empty key', { '': 'S' }, ''],
    ])('refuses %s as a subject, and names it', async (_name, languages, key) => {
      const res = await submit({ subject: languages, blocks: [] });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'LOCALE_INVALID',
        details: { field: `content.subject.${key}`, locale: key },
      });
    });

    it('names the place of a language in a preview, a text and a title', async () => {
      const cases: [unknown, string][] = [
        [{ subject, preview: { xx: 'P' }, blocks: [] }, 'content.preview.xx'],
        [withBlocks(text('a'), text('b', { xx: 'c' })), 'content.blocks[1].text.xx'],
        [
          withBlocks({ type: 'products', title: { xx: 'T' }, source: 'manual', productIds: [1] }),
          'content.blocks[0].title.xx',
        ],
        [
          withBlocks({ type: 'category', categoryId: 1, title: { xx: 'T' } }),
          'content.blocks[0].title.xx',
        ],
      ];

      for (const [content, field] of cases) {
        const res = await submit(content);

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({
          errorCode: 'LOCALE_INVALID',
          details: { field, locale: 'xx' },
        });
      }
    });

    it('refuses a language the shop turned off, though it has a dictionary', async () => {
      // a PATCH may keep a language the stored content has, so the content stored by now has none
      expect((await submit({ subject: { en: 'S' }, blocks: [] })).statusCode).toBe(accepted);
      setShopSettings({ enabledLocales: ['en'] });

      const refused = await submit({ subject: { en: 'S', es: 'S' }, blocks: [] });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({
        errorCode: 'LOCALE_INVALID',
        details: { locale: 'es' },
      });

      expect((await submit({ subject: { en: 'S' }, blocks: [] })).statusCode).toBe(accepted);
    });

    it('takes a language the shop turned on', async () => {
      setShopSettings({ enabledLocales: ['en', 'es', 'uk'] });

      expect((await submit({ subject: { uk: 'S', es: 'S' }, blocks: [] })).statusCode).toBe(
        accepted,
      );
    });

    it.each([
      [
        'a preview',
        { subject: { en: 'S' }, preview: { es: 'P' }, blocks: [] },
        'content.preview.es',
      ],
      [
        'a text',
        { subject: { en: 'S' }, blocks: [text('a', { es: 'b' })] },
        'content.blocks[0].text.es',
      ],
      [
        'a title of products',
        {
          subject: { en: 'S' },
          blocks: [{ type: 'products', title: { es: 'T' }, source: 'manual', productIds: [1] }],
        },
        'content.blocks[0].title.es',
      ],
      [
        'a title of a category',
        { subject: { en: 'S' }, blocks: [{ type: 'category', categoryId: 1, title: { es: 'T' } }] },
        'content.blocks[0].title.es',
      ],
    ])('refuses %s in a language that has no subject', async (_name, content, field) => {
      const res = await submit(content);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'NEWSLETTER_LOCALE_WITHOUT_SUBJECT',
        details: { field, locale: 'es' },
      });
    });
  });

  describe('the links', () => {
    const SALE = `${webOrigin}/sale`;

    it.each([
      ['a path', '[Sale](/sale)'],
      ['an address of the shop', `[Sale](${SALE})`],
      ['a path with a query and a fragment', '[Sale](/sale?a=1&b=2#top)'],
      ['a link in bold', '**[Sale](/sale)**'],
      ['a link in a heading', '# [Sale](/sale)'],
      ['a link in a list', '- [Sale](/sale)'],
      ['a call that the markup does not take for a link', '[x](javascript:alert(1))'],
    ])('lets in %s in a text', async (_name, markup) => {
      const res = await submit(withBlocks(text(markup)));

      expect(res.statusCode).toBe(accepted);
      expect(res.json().content.blocks[0].text.en).toBe(markup);
    });

    it.each([
      ['another site', '[x](https://evil.example.org/p)', 'https://evil.example.org/p'],
      ['another site over http', '[x](http://evil.example.org/p)', 'http://evil.example.org/p'],
      [
        'a site that starts like the shop',
        `[x](${webOrigin}.evil.example.org/p)`,
        `${webOrigin}.evil.example.org/p`,
      ],
      [
        'an address with a user name',
        `[x](https://user@${new URL(webOrigin!).host}/p)`,
        `https://user@${new URL(webOrigin!).host}/p`,
      ],
      ['a protocol-relative address', '[x](//evil.example.org/p)', '//evil.example.org/p'],
      ['a javascript address', '[x](javascript:alert)', 'javascript:alert'],
      ['a javascript address in capitals', '[x](JAVASCRIPT:alert)', 'JAVASCRIPT:alert'],
      [
        'a data address',
        '[x](data:text/html;base64,PHNjcmlwdD4=)',
        'data:text/html;base64,PHNjcmlwdD4=',
      ],
      ['a mail address', '[x](mailto:a@example.com)', 'mailto:a@example.com'],
      ['a relative path', '[x](sale)', 'sale'],
      ['a link in bold', '**[x](https://evil.example.org)**', 'https://evil.example.org'],
      [
        'a link after a good one',
        '[ok](/ok) and [x](https://evil.example.org)',
        'https://evil.example.org',
      ],
    ])('refuses %s in a text, and names the place and the address', async (_name, markup, url) => {
      const res = await submit(withBlocks(text('fine'), text(markup)));

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'NEWSLETTER_LINK_NOT_ALLOWED',
        details: { field: 'content.blocks[1].text.en', url },
      });
    });

    it('judges the text of every language', async () => {
      const res = await submit(
        withBlocks(text('[ok](/ok)', { es: '[mal](https://evil.example.org)' })),
      );

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'NEWSLETTER_LINK_NOT_ALLOWED',
        details: { field: 'content.blocks[0].text.es' },
      });
    });

    it.each([
      ['a path', '/sale'],
      ['an address of the shop', SALE],
      ['the shop itself', `${webOrigin}/`],
    ])('lets in %s for a button', async (_name, url) => {
      expect((await submit(withBlocks({ type: 'button', kind: 'shop', url }))).statusCode).toBe(
        accepted,
      );
    });

    it.each([
      ['another site', 'https://evil.example.org/'],
      ['a protocol-relative address', '//evil.example.org'],
      ['a javascript address', 'javascript:alert(1)'],
      ['a data address', 'data:text/html,x'],
      ['a relative path', 'sale'],
      ['a path with a space', '/sale now'],
      ['a path with a backslash', '/\\evil.example.org'],
    ])('refuses %s for a button, and names the place and the address', async (_name, url) => {
      const res = await submit(withBlocks(text('a'), { type: 'button', kind: 'shop', url }));

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'NEWSLETTER_LINK_NOT_ALLOWED',
        details: { field: 'content.blocks[1].url', url },
      });
    });
  });

  // A link of a text or a button may lead to a site root trusts as well (newsletterTrustedDomains of the
  // data of the shop, subdomains included): an absolute address of http or https. Whatever else is not
  // the shop's or a trusted site's is still NEWSLETTER_LINK_NOT_ALLOWED
  describe('the links to the sites root trusts', () => {
    const linkRefused = (res: LightMyRequestResponse, field: string, url: string) => {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'NEWSLETTER_LINK_NOT_ALLOWED',
        details: { field, url },
      });
    };

    it('lets in a link of a text and a button to a trusted domain and to its subdomains, while root trusts it', async () => {
      const content = withBlocks(
        text(
          'Read [the post](https://blog.partner.test/post) or [more](https://partner.test/a?b=1#c)',
        ),
        { type: 'button', kind: 'shop', url: 'https://www.partner.test/offer' },
      );

      linkRefused(
        await submit(content),
        'content.blocks[0].text.en',
        'https://blog.partner.test/post',
      );

      setShopSettings({ newsletterTrustedDomains: ['partner.test'] });
      const res = await submit(content);
      expect(res.statusCode).toBe(accepted);
      expect(res.json().content).toEqual({ ...content, preview: {} });

      resetShopSettings();
      linkRefused(
        await submit(content),
        'content.blocks[0].text.en',
        'https://blog.partner.test/post',
      );
    });

    it.each([
      ['the parent of a trusted domain', 'https://partner.test/post'],
      ['a sibling of a trusted domain', 'https://news.partner.test/post'],
      ['a domain that ends like a trusted one', 'https://evilblog.partner.test/post'],
      [
        'a domain that starts like a trusted one',
        'https://blog.partner.test.elsewhere.example/post',
      ],
      ['a trusted domain as a user name', 'https://blog.partner.test@elsewhere.example/post'],
      ['a trusted domain with a user name', 'https://user@blog.partner.test/post'],
      ['a trusted domain as a protocol-relative address', '//blog.partner.test/post'],
      ['a trusted domain under another scheme', 'ftp://blog.partner.test/post'],
    ])('still refuses %s, in a text and in a button', async (_name, url) => {
      setShopSettings({ newsletterTrustedDomains: ['blog.partner.test'] });

      linkRefused(await submit(withBlocks(text(`[x](${url})`))), 'content.blocks[0].text.en', url);
      linkRefused(
        await submit(withBlocks(text('a'), { type: 'button', kind: 'shop', url })),
        'content.blocks[1].url',
        url,
      );
    });

    it('shows the preview a link to a trusted domain as it is, with no marks of the campaign', async () => {
      setShopSettings({ newsletterTrustedDomains: ['partner.test'] });
      const res = await submit(
        withBlocks(text('Read [the post](https://blog.partner.test/post?a=1) and [sale](/sale)'), {
          type: 'button',
          kind: 'shop',
          url: 'https://partner.test/offer',
        }),
      );
      expect(res.statusCode).toBe(accepted);

      const preview = await api.preview(staff.manager, res.json().id as number, { locale: 'en' });

      expect(preview.statusCode).toBe(200);
      const html = preview.json().html as string;
      expect(html).toContain('href="https://blog.partner.test/post?a=1"');
      expect(html).toContain('href="https://partner.test/offer"');
      expect(html).toMatch(/href="[^"]*\/sale\?utm_source=newsletter&amp;utm_campaign=\d+"/);
      expect(preview.json().warnings).toEqual([]);
    });
  });

  // An address written out in a text, not made a link by the markup, leads where the reader's mail
  // program takes it. It must be of the shop, or of a domain root trusts (newsletterTrustedDomains of
  // the data of the shop), subdomains included
  describe('the addresses of other sites in a text', () => {
    const own = new URL(webOrigin!).host;
    const refused = (res: LightMyRequestResponse, field: string, address: string) => {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'NEWSLETTER_ADDRESS_NOT_ALLOWED',
        details: { field, address },
      });
    };

    it.each([
      ['an address of the shop', `Open ${webOrigin}/sale now`],
      ['a domain of the shop with a path', `Open ${own}/sale now`],
      ['www and a subdomain of the shop', `Open www.${own}/sale or https://cdn.${own}/a`],
      ['a plain domain, no address', 'Mail help@elsewhere.example, see elsewhere.example'],
    ])('lets in %s', async (_name, plain) => {
      const res = await submit({
        subject: { en: plain },
        preview: { en: plain },
        blocks: [text(plain), { type: 'category', categoryId: 1, title: { en: plain } }],
      });

      expect(res.statusCode).toBe(accepted);
      expect(res.json().content.blocks[0].text.en).toBe(plain);
    });

    it.each([
      ['https', 'Open https://elsewhere.example/p now', 'https://elsewhere.example/p'],
      ['www', 'Open www.elsewhere.example now', 'www.elsewhere.example'],
      ['a domain with a path', 'Open elsewhere.example/p now', 'elsewhere.example/p'],
      [
        'a name that starts like the shop',
        `Open ${own}.elsewhere.example/p`,
        `${own}.elsewhere.example/p`,
      ],
      ['an address in the label of a link', '[elsewhere.example/p](/sale)', 'elsewhere.example/p'],
    ])(
      'refuses %s in a text, and names the place and the address',
      async (_name, plain, address) => {
        refused(
          await submit(withBlocks(text('fine'), text(plain))),
          'content.blocks[1].text.en',
          address,
        );
      },
    );

    // a name with no path is an address when it ends with a real top-level domain, with a path or not
    it.each([
      ['a name with no path', 'Open elsewhere.com now', 'elsewhere.com'],
      ['a name with a subdomain', 'Open shop.elsewhere.co.uk now', 'shop.elsewhere.co.uk'],
      ['a name followed by a query', 'Open elsewhere.com?utm=1 now', 'elsewhere.com?utm=1'],
      ['a name followed by a fragment', 'Open elsewhere.com#top now', 'elsewhere.com#top'],
      ['a name at the end of a sentence', 'Open elsewhere.com.', 'elsewhere.com'],
      ['a file name that ends with a zone', 'Open the file readme.md now', 'readme.md'],
    ])(
      'refuses %s in a text, and names the place and the address',
      async (_name, plain, address) => {
        refused(
          await submit(withBlocks(text('fine'), text(plain))),
          'content.blocks[1].text.en',
          address,
        );
      },
    );

    it.each([
      ['an abbreviation', 'Take e.g. a coat, i.e. a jacket'],
      ['a title and a name', 'Mr.Smith came'],
      ['a version', 'Version v1.2 is out'],
      ['a picture', 'See photo.jpg'],
      ['numbers', 'It costs 3.5 or 9.99'],
      ['a mail address', 'Mail help@elsewhere.com or anna.red@elsewhere.com'],
    ])('lets in %s, a name that is no address', async (_name, plain) => {
      const res = await submit(withBlocks(text(plain)));

      expect(res.statusCode).toBe(accepted);
    });

    it('refuses a name with a real zone in the subject, and lets in the domains of root with no path', async () => {
      refused(
        await submit({ subject: { en: 'Sale at elsewhere.com' }, blocks: [] }),
        'content.subject.en',
        'elsewhere.com',
      );

      setShopSettings({ newsletterTrustedDomains: ['elsewhere.com'] });
      expect(
        (await submit({ subject: { en: 'Sale at elsewhere.com' }, blocks: [] })).statusCode,
      ).toBe(accepted);
    });

    it('refuses an address in the subject, the preview and a title', async () => {
      const bad = 'Open https://elsewhere.example/p';
      const address = 'https://elsewhere.example/p';

      refused(await submit({ subject: { en: bad }, blocks: [] }), 'content.subject.en', address);
      refused(
        await submit({ subject, preview: { en: bad }, blocks: [] }),
        'content.preview.en',
        address,
      );
      refused(
        await submit(
          withBlocks({ type: 'products', title: { en: bad }, source: 'manual', productIds: [1] }),
        ),
        'content.blocks[0].title.en',
        address,
      );
      refused(
        await submit(withBlocks({ type: 'category', categoryId: 1, title: { es: bad } })),
        'content.blocks[0].title.es',
        address,
      );
    });

    it('judges the text of every language', async () => {
      refused(
        await submit(withBlocks(text('fine', { es: 'mal www.elsewhere.example' }))),
        'content.blocks[0].text.es',
        'www.elsewhere.example',
      );
    });

    it('leaves a link of the markup to another site to the code of a link', async () => {
      const res = await submit(withBlocks(text('[x](https://elsewhere.example/p)')));

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('NEWSLETTER_LINK_NOT_ALLOWED');
    });

    it('lets in the domains root trusts, and their subdomains, and only while it trusts them', async () => {
      const plain = 'Read https://blog.partner.test/post, partner.test/a and www.partner.test/b';

      refused(
        await submit(withBlocks(text(plain))),
        'content.blocks[0].text.en',
        'https://blog.partner.test/post',
      );

      setShopSettings({ newsletterTrustedDomains: ['partner.test'] });
      expect((await submit(withBlocks(text(plain)))).statusCode).toBe(accepted);

      resetShopSettings();
      refused(
        await submit(withBlocks(text(plain))),
        'content.blocks[0].text.en',
        'https://blog.partner.test/post',
      );
    });

    it('does not trust the domain next to a trusted one', async () => {
      setShopSettings({ newsletterTrustedDomains: ['blog.partner.test'] });

      refused(
        await submit(withBlocks(text('Read https://partner.test/post'))),
        'content.blocks[0].text.en',
        'https://partner.test/post',
      );
      refused(
        await submit(withBlocks(text('Read https://evilblog.partner.test/post'))),
        'content.blocks[0].text.en',
        'https://evilblog.partner.test/post',
      );
    });
  });

  describe('the text', () => {
    it('keeps raw html as the plain text it is: the markup has no html to refuse', async () => {
      const html = '<script>alert(1)</script><img src=x onerror=alert(1)> &amp; "quotes"';
      const res = await submit({ subject: { en: '<b>S</b>' }, blocks: [text(html)] });

      expect(res.statusCode).toBe(accepted);
      expect(res.json().content.subject.en).toBe('<b>S</b>');
      expect(res.json().content.blocks[0].text.en).toBe(html);
    });

    it('keeps the text as it was typed, with its spaces, lines and signs', async () => {
      const typed = '  # Title  \n\n\n- a\n- b\ttab\n\n**x** \u{1F600} \u200b';
      const res = await submit(withBlocks(text(typed)));

      expect(res.json().content.blocks[0].text.en).toBe(typed);
    });
  });

  it('keeps nothing of a content it refused', async () => {
    const id = await draftOf(api, staff.manager, { name: 'Kept as it was' });
    made.push(id);
    const before = (await campaignRowOf(id))!.content;

    const res = await api.update(staff.manager, id, { content: withBlocks({ type: 'banner' }) });

    expect(res.statusCode).toBe(400);
    expect((await campaignRowOf(id))!.content).toEqual(before);
  });
});

// a scheduled campaign is one that can go out: a new text of it is as complete as scheduling asked
// (a draft may be unfinished, above)
describe('PATCH /api/newsletters/campaigns/:campaignId of a scheduled campaign', () => {
  const complete = withBlocks(text('Hello', { es: 'Hola' }));

  it('refuses a content that could not go out and keeps the one it had, and takes a complete one', async () => {
    const id = await draftOf(api, staff.manager, { name: 'Scheduled content', content: complete });
    made.push(id);
    await moveTo(staff.manager, id, 'scheduled');

    try {
      const incomplete = await api.update(staff.manager, id, {
        content: { subject, blocks: [] },
      });

      expect(incomplete.statusCode).toBe(400);
      expect(incomplete.json()).toMatchObject({ errorCode: 'NEWSLETTER_CONTENT_INCOMPLETE' });
      expect((await campaignRowOf(id))!.content).toMatchObject(complete);

      const next = withBlocks(text('Hello again', { es: 'Hola otra vez' }));
      const changed = await api.update(staff.manager, id, { content: next });

      expect(changed.statusCode).toBe(200);
      expect((await campaignRowOf(id))!.content).toMatchObject(next);
    } finally {
      // a scheduled campaign of the whole shop must not outlive the test
      await app.inject({
        method: 'POST',
        url: `/api/newsletters/campaigns/${id}/cancel`,
        headers: withCsrf(csrf, accessCookie(staff.manager)),
      });
    }
  });
});
