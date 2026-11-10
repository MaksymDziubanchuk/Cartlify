import { afterEach, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';

import {
  CampaignLocaleMissingError,
  renderCampaignMail,
  type CampaignMailArgs,
} from '@services/email/templates/newsletters/campaign.template.js';
import type {
  NewsletterBlockDto,
  NewsletterCardDto,
  NewsletterContentDto,
  NewsletterSnapshotDto,
} from 'types/dto/newsletters.dto.js';

import { dictionaryText } from '../../../../../helpers/dictionary.js';
import { resetShopSettings, setShopSettings } from '../../../../../helpers/shopSettings.js';

// the logo of the shop is shown by its address at Cloudinary: the mail carries no attachment
const LOGO_URL = 'https://res.cloudinary.com/cartlify-test/image/upload/v1/test/shop/logo/a.png';

// The mail of a campaign: the blocks of the admin in their order under the logo, the permanent foot in
// the language of the reader. The tests read what the mail says, where it links and what it leaves out,
// never how it looks (colors, borders and backgrounds are for the one who owns the shop to change)

const ORIGIN = 'https://shop.example.com';
const MANAGE = 'https://shop.example.com/newsletter/manage?token=MANAGE_TOKEN';
const UNSUBSCRIBE = 'https://api.example.com/api/newsletters/unsubscribe/MANAGE_TOKEN?c=41';
const CAMPAIGN = 41;
// the moment a mail is built in these tests, unless a test names its own
const NOW = new Date('2026-11-10T12:00:00.000Z');

afterEach(() => resetShopSettings());

const card = (over: Partial<NewsletterCardDto> = {}): NewsletterCardDto => ({
  productId: 7,
  variantId: 70,
  name: 'Linen shirt',
  imageUrl: 'https://res.cloudinary.com/demo/image/upload/c_fit,w_400/v1/p/7.jpg',
  price: 12.5,
  from: false,
  salePrice: null,
  priorPrice: null,
  saleEndsAt: null,
  ...over,
});

const content = (
  blocks: NewsletterBlockDto[],
  over: Partial<NewsletterContentDto> = {},
): NewsletterContentDto => ({
  subject: { en: 'Spring sale', uk: 'Vesnianyi rozprodazh', es: 'Rebajas de primavera' },
  preview: { en: 'Up to 30% off', uk: 'Znyzhky do 30%' },
  blocks,
  ...over,
});

const products = (...items: NewsletterCardDto[]) => ({
  kind: 'products' as const,
  items,
  unavailable: [] as number[],
  categoryMissing: false,
});

const snapshot = (blocks: NewsletterSnapshotDto['blocks'] = []): NewsletterSnapshotDto => ({
  takenAt: '2026-11-09T12:00:00.000Z',
  currency: 'EUR',
  blocks,
});

function mail(
  blocks: NewsletterBlockDto[],
  snap: NewsletterSnapshotDto['blocks'] = [],
  over: Partial<CampaignMailArgs> & { content?: NewsletterContentDto } = {},
) {
  const { content: given, ...rest } = over;
  return renderCampaignMail({
    content: given ?? content(blocks),
    snapshot: snapshot(snap),
    locale: 'en',
    campaignId: CAMPAIGN,
    manageUrl: MANAGE,
    unsubscribeUrl: UNSUBSCRIBE,
    origin: ORIGIN,
    now: NOW,
    ...rest,
  });
}

const text = (body: Record<string, string>): NewsletterBlockDto => ({ type: 'text', text: body });

// the links of a mail in html, as a person's program reads them (the &amp; of an address is a &)
function anchors(html: string): { href: string; label: string }[] {
  return [...html.matchAll(/<a\b[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((match) => ({
    href: match[1]!.replaceAll('&amp;', '&'),
    label: match[2]!
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t\r\n]+/g, ' ')
      .trim(),
  }));
}

const hrefs = (html: string) => anchors(html).map((anchor) => anchor.href);

// the words of the mail, without its tags
const wordsOf = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    // the spaces of a line only: the no-break space of a price (12,50 €) is part of the price
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();

const euro = (locale: string, value: number) =>
  new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(value);

const phrase = (locale: string, key: string, values: Record<string, string> = {}) =>
  Object.entries(values).reduce(
    (out, [name, value]) => out.replaceAll(`{{${name}}}`, value),
    dictionaryText(locale, key),
  );

describe('the subject, the preview and the language', () => {
  it.each([
    ['en', 'Spring sale', 'Up to 30% off'],
    ['uk', 'Vesnianyi rozprodazh', 'Znyzhky do 30%'],
    ['es', 'Rebajas de primavera', ''],
  ])('takes the subject and the preview of the language %s', (locale, subject, preheader) => {
    const out = mail([], [], { locale });

    expect(out.subject).toBe(subject);
    expect(out.preheader).toBe(preheader);
  });

  it('shows the preview as the first words of the mail for a reader who has it, hidden', () => {
    const out = mail([]);

    expect(out.html).toContain('Up to 30% off');
    // the preview is the start of the mail but not of the plain text, which a program prints whole
    expect(out.text).not.toContain('Up to 30% off');
  });

  it('cuts the spaces round the subject and the preview', () => {
    const out = mail([], [], {
      content: content([], { subject: { en: '  Hello  ' }, preview: { en: ' Hi ' } }),
    });

    expect(out.subject).toBe('Hello');
    expect(out.preheader).toBe('Hi');
  });

  it.each([
    ['a language with no subject', 'fr'],
    ['a language with a blank subject', 'de'],
  ])('is an error for %s, a clean one the caller maps', (_case, locale) => {
    const given = content([], { subject: { en: 'A', de: '   ' } });

    let thrown: unknown;
    try {
      mail([], [], { locale, content: given });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CampaignLocaleMissingError);
    expect((thrown as CampaignLocaleMissingError).message).toBe(
      'NEWSLETTER_LOCALE_NOT_IN_CAMPAIGN',
    );
  });

  it.each([
    ['en', 'en'],
    ['uk', 'uk'],
    ['es', 'es'],
  ])('sets the language of the page: %s', (locale, lang) => {
    expect(mail([], [], { locale }).html).toContain(`<html lang="${lang}">`);
  });

  it('puts the subject in the title of the page, escaped', () => {
    const out = mail([], [], { content: content([], { subject: { en: 'Fish & <b>chips</b>' } }) });

    expect(out.html).toContain('<title>Fish &amp; &lt;b&gt;chips&lt;/b&gt;</title>');
    // the subject itself is for a header, not for html
    expect(out.subject).toBe('Fish & <b>chips</b>');
  });
});

describe('the top of the mail', () => {
  it('shows the logo by its address', () => {
    expect(mail([], [], { logoUrl: LOGO_URL }).html).toContain(`src="${LOGO_URL}"`);
  });

  it('shows the name of the shop in its place while there is no logo', () => {
    setShopSettings({ shopName: 'Linen & Co' });
    const out = mail([]);

    expect(out.html).not.toMatch(/<img\b/);
    expect(wordsOf(out.html)).toContain('Linen & Co');
  });

  it('has no greeting: the mail starts with the blocks', () => {
    for (const locale of ['en', 'uk', 'es']) {
      const out = mail([text({ en: 'Hello there', uk: 'Pryvit', es: 'Hola' })], [], {
        locale,
      });

      expect(out.html).not.toContain(dictionaryText(locale, 'common.greeting'));
      expect(out.text).not.toContain(dictionaryText(locale, 'common.greeting'));
    }
  });
});

// The test mail of an admin is the mail a reader gets with two marks: the subject starts with the
// word "test" of the language, and a line at the top says the subscribers did not get it. Nothing
// else of the mail changes
describe('a test mail', () => {
  const marks = (locale: string) => ({
    prefix: dictionaryText(locale, 'campaignMail.testSubjectPrefix'),
    notice: dictionaryText(locale, 'campaignMail.testNotice'),
  });
  const blocks: NewsletterBlockDto[] = [text({ en: 'Hello there', es: 'Hola', uk: 'Pryvit' })];
  const spanish = content(blocks, { subject: { en: 'Spring sale', es: 'Rebajas', uk: 'Vesna' } });

  it.each(['en', 'uk', 'es'])(
    'starts the subject with the prefix of the language: %s',
    (locale) => {
      const { prefix } = marks(locale);
      const plain = mail(blocks, [], { locale, content: spanish });
      const test = mail(blocks, [], { locale, content: spanish, test: true });

      expect(test.subject).toBe(`${prefix} ${plain.subject}`);
    },
  );

  it.each(['en', 'uk', 'es'])(
    'says at the top of the html and of the text that it is a test: %s',
    (locale) => {
      const { notice } = marks(locale);
      const out = mail(blocks, [], { locale, content: spanish, test: true });

      expect(wordsOf(out.html)).toContain(notice);
      expect(out.text.startsWith(notice)).toBe(true);
    },
  );

  it('puts the notice before the name of the shop and before the first block', () => {
    setShopSettings({ shopName: 'Linen & Co' });
    const out = mail(blocks, [], { test: true });
    const at = out.html.indexOf(marks('en').notice);

    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(out.html.indexOf('Linen &amp; Co'));
    expect(at).toBeLessThan(out.html.indexOf('Hello there'));
  });

  it('has the words in each language, no two of them the same', () => {
    const all = ['en', 'uk', 'es'].map(marks);

    expect(new Set(all.map((one) => one.notice)).size).toBe(3);
    expect(new Set(all.map((one) => one.prefix)).size).toBe(3);
  });

  it('has the notice in the language of the reader and in no other', () => {
    const out = mail(blocks, [], { locale: 'es', content: spanish, test: true });

    expect(out.html).toContain(marks('es').notice);
    expect(out.html).not.toContain(marks('en').notice);
    expect(out.text).not.toContain(marks('en').notice);
  });

  it('is the mail of a reader once the two marks are put aside', () => {
    const { prefix, notice } = marks('en');
    const plain = mail(blocks, []);
    const test = mail(blocks, [], { test: true });
    // the row of the notice, and the subject that names the page
    const row = new RegExp(`\\s*<tr>\\s*<td[^>]*>\\s*${notice}\\s*</td>\\s*</tr>`);

    expect(test.text).toBe(`${notice}\n\n${plain.text}`);
    expect(test.html.replace(row, '').replace(`<title>${prefix} `, '<title>')).toBe(plain.html);
    expect(test.preheader).toBe(plain.preheader);
    expect(test.headers).toEqual(plain.headers);
    expect(test.warnings).toEqual(plain.warnings);
  });

  it('names the page by the subject of the test mail', () => {
    const out = mail(blocks, [], { test: true });

    expect(out.html).toContain(`<title>${marks('en').prefix} Spring sale</title>`);
  });

  it('is no test mail by default, and not when told it is not', () => {
    const { prefix, notice } = marks('en');

    for (const out of [mail(blocks, []), mail(blocks, [], { test: false })]) {
      expect(out.subject).not.toContain(prefix);
      expect(out.html).not.toContain(notice);
      expect(out.text).not.toContain(notice);
    }
  });
});

describe('the foot of the mail', () => {
  it.each(['en', 'uk', 'es'])(
    'says in %s why the reader got it, with the name of the shop',
    (locale) => {
      setShopSettings({ shopName: 'Linen & Co' });
      const out = mail([], [], { locale });
      const reason = phrase(locale, 'campaignMail.reason', { appName: 'Linen & Co' });

      expect(wordsOf(out.html)).toContain(reason);
      expect(out.text).toContain(reason);
    },
  );

  it.each(['en', 'uk', 'es'])('has the link "Manage the subscription" in %s', (locale) => {
    const out = mail([], [], { locale });
    const label = dictionaryText(locale, 'campaignMail.manage');
    const manage = anchors(out.html).filter((anchor) => anchor.href === MANAGE);

    expect(manage).toHaveLength(1);
    expect(manage[0]!.label).toBe(label);
    expect(out.text).toContain(`${label}: ${MANAGE}`);
  });

  it('has the manage link exactly as it was given, no marks of a campaign on it', () => {
    const out = mail([text({ en: 'x' })]);

    expect(hrefs(out.html)).toContain(MANAGE);
    expect(MANAGE).not.toContain('utm_');
  });

  it.each(['en', 'uk', 'es'])(
    'says in %s that the mail is automatic and where to write to the shop',
    (locale) => {
      setShopSettings({ emailReplyTo: 'support@shop.example.com' });
      const out = mail([], [], { locale });
      const automatic = dictionaryText(locale, 'campaignMail.automatic');
      const questions = dictionaryText(locale, 'common.questionsIntro');
      const orTo = dictionaryText(locale, 'common.orTo');

      for (const part of [wordsOf(out.html), out.text]) {
        expect(part).toContain(automatic);
        expect(part).toContain(`${questions} ${orTo} support@shop.example.com`);
      }
    },
  );

  it('names the seller as the other mails do, in the language of the reader', () => {
    setShopSettings({
      sellerLegalName: 'Cartlify LLC',
      sellerAddress: null,
      sellerTaxId: null,
      sellerEmail: 'legal@shop.example.com',
      sellerPhone: null,
    });

    for (const locale of ['en', 'uk', 'es']) {
      const line = phrase(locale, 'common.seller', {
        details: 'Cartlify LLC, legal@shop.example.com',
      });
      const out = mail([], [], { locale });

      expect(wordsOf(out.html)).toContain(line);
      expect(out.text).toContain(line);
    }
  });

  it('leaves the seller out while root has filled in none of it', () => {
    setShopSettings({
      sellerLegalName: null,
      sellerAddress: null,
      sellerTaxId: null,
      sellerEmail: null,
      sellerPhone: null,
    });
    const out = mail([]);

    expect(out.html).not.toContain(dictionaryText('en', 'common.seller').split('{{')[0]!);
    expect(out.text).not.toContain(dictionaryText('en', 'common.seller').split('{{')[0]!);
  });

  it('puts the current year next to the name of the shop', () => {
    setShopSettings({ shopName: 'Linen' });

    expect(wordsOf(mail([]).html)).toContain(`© ${new Date().getFullYear()} Linen`);
  });

  it('escapes the name of the shop', () => {
    setShopSettings({ shopName: '<img src=x onerror=alert(1)>' });
    const out = mail([]);

    expect(out.html).not.toContain('<img src=x');
    expect(out.html).toContain('&lt;img src=x');
  });
});

describe('the blocks come in the order the admin put them', () => {
  it('shows a text, products, a category and a button one after another', () => {
    const out = mail(
      [
        text({ en: 'FIRST-TEXT' }),
        { type: 'products', source: 'manual', productIds: [7] },
        { type: 'category', categoryId: 3 },
        { type: 'button', kind: 'shop', url: '/' },
        text({ en: 'LAST-TEXT' }),
      ],
      [
        null,
        products(card({ name: 'PRODUCT-NAME' })),
        { kind: 'category', category: { id: 3, name: 'CATEGORY-NAME', imageUrl: null } },
        null,
        null,
      ],
    );
    const words = wordsOf(out.html);
    const at = ['FIRST-TEXT', 'PRODUCT-NAME', 'CATEGORY-NAME', 'LAST-TEXT'].map((word) =>
      words.indexOf(word),
    );

    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // the button sits between the category and the last text
    const shop = words.indexOf(dictionaryText('en', 'campaignMail.buttonShop'));
    expect(shop).toBeGreaterThan(at[2]!);
    expect(shop).toBeLessThan(at[3]!);
  });

  it('keeps the order in the plain text too', () => {
    const out = mail([text({ en: 'FIRST-TEXT' }), text({ en: 'SECOND-TEXT' })], [null, null]);

    expect(out.text.indexOf('FIRST-TEXT')).toBeGreaterThanOrEqual(0);
    expect(out.text.indexOf('SECOND-TEXT')).toBeGreaterThan(out.text.indexOf('FIRST-TEXT'));
  });
});

describe('a block of text', () => {
  it('turns the simple markup into html and into plain text', () => {
    const out = mail([
      text({ en: '# Big news\nThe **best** prices, *really*.\n\n- free delivery\n- returns' }),
    ]);

    expect(out.html).toMatch(/<h2\b[^>]*>Big news<\/h2>/);
    expect(out.html).toMatch(/<strong>best<\/strong>/);
    expect(out.html).toMatch(/<em>really<\/em>/);
    expect(out.html).toMatch(/<li\b[^>]*>free delivery<\/li>/);
    expect(out.text).toContain('Big news');
    expect(out.text).toContain('- free delivery');
    expect(out.text).not.toContain('**');
  });

  it('writes the text of the language of the reader', () => {
    const body = { en: 'English words', uk: 'Ukrainski slova', es: 'Palabras en español' };

    for (const [locale, words] of Object.entries(body)) {
      const out = mail([text(body)], [null], { locale });

      expect(wordsOf(out.html)).toContain(words);
      expect(out.text).toContain(words);
      for (const other of Object.values(body).filter((w) => w !== words)) {
        expect(out.html).not.toContain(other);
      }
    }
  });

  it('marks the links to the shop with the campaign: the source and the id', () => {
    const out = mail([text({ en: '[see the sale](/sale) and [home](https://shop.example.com/)' })]);

    expect(hrefs(out.html)).toEqual(
      expect.arrayContaining([
        'https://shop.example.com/sale?utm_source=newsletter&utm_campaign=41',
        'https://shop.example.com/?utm_source=newsletter&utm_campaign=41',
      ]),
    );
    expect(out.text).toContain(
      'see the sale (https://shop.example.com/sale?utm_source=newsletter&utm_campaign=41)',
    );
  });

  it('keeps the query of the link and replaces a mark that was there, it does not double it', () => {
    const out = mail([text({ en: '[go](/sale?color=red&utm_source=x&utm_campaign=9)' })]);
    const link = new URL(hrefs(out.html).find((href) => href.includes('/sale'))!);

    expect(link.searchParams.get('color')).toBe('red');
    expect(link.searchParams.getAll('utm_source')).toEqual(['newsletter']);
    expect(link.searchParams.getAll('utm_campaign')).toEqual(['41']);
  });

  it('writes a link that does not lead to the shop as words, and tells the admin', () => {
    const out = mail([text({ en: 'Visit [our friends](https://evil.example/phish) now' })]);

    expect(hrefs(out.html).filter((href) => href.includes('evil.example'))).toEqual([]);
    expect(wordsOf(out.html)).toContain('our friends');
    expect(out.warnings).toEqual([{ blockIndex: 0, code: 'LINK_NOT_ALLOWED' }]);
  });

  it('tells once for a block that has several links that do not lead to the shop', () => {
    const out = mail([
      text({ en: '[a](https://evil.example/1) [b](https://evil.example/2) [c](/ok)' }),
    ]);

    expect(out.warnings).toEqual([{ blockIndex: 0, code: 'LINK_NOT_ALLOWED' }]);
  });

  it('judges the links by the address of the shop as it is now, not as it was when they were saved', () => {
    const saved = [text({ en: '[sale](https://shop.example.com/sale)' })];

    const same = mail(saved);
    const moved = mail(saved, [], { origin: 'https://new-shop.example.org' });

    expect(hrefs(same.html).some((href) => href.startsWith('https://shop.example.com/sale'))).toBe(
      true,
    );
    expect(hrefs(moved.html).some((href) => href.includes('shop.example.com/sale'))).toBe(false);
    expect(moved.warnings).toEqual([{ blockIndex: 0, code: 'LINK_NOT_ALLOWED' }]);
  });

  // a site root trusts (the setting newsletterTrustedDomains, read when the mail is built) is a place a
  // link may lead to: its address goes as it is, without the marks of the campaign
  describe('a link to a site root trusts', () => {
    const TRUSTED = ['partner.test'];
    const link = text({ en: '[read](https://blog.partner.test/post?a=1) and [sale](/sale)' });

    it('is written as a link with no marks of the campaign, while a link to the shop keeps them', () => {
      const out = mail([link], [], { trustedDomains: TRUSTED });

      expect(hrefs(out.html)).toEqual(
        expect.arrayContaining([
          'https://blog.partner.test/post?a=1',
          'https://shop.example.com/sale?utm_source=newsletter&utm_campaign=41',
        ]),
      );
      expect(out.text).toContain('read (https://blog.partner.test/post?a=1)');
      expect(out.warnings).toEqual([]);
    });

    it('is read from the setting of the shop unless the call names the sites', () => {
      setShopSettings({ newsletterTrustedDomains: TRUSTED });

      const out = mail([link]);

      expect(hrefs(out.html)).toContain('https://blog.partner.test/post?a=1');
      expect(out.warnings).toEqual([]);
    });

    it('is judged by the sites as they are now: one root took away is written as words', () => {
      setShopSettings({ newsletterTrustedDomains: [] });

      const out = mail([link]);

      expect(hrefs(out.html).filter((href) => href.includes('partner.test'))).toEqual([]);
      expect(wordsOf(out.html)).toContain('read');
      expect(out.warnings).toEqual([{ blockIndex: 0, code: 'LINK_NOT_ALLOWED' }]);
    });

    it('does not make a link of a site that only looks trusted', () => {
      const out = mail(
        [
          text({
            en: '[a](https://partner.test.evil.example/1) [b](https://partner.test@evil.example/2)',
          }),
        ],
        [],
        { trustedDomains: TRUSTED },
      );

      expect(hrefs(out.html).filter((href) => href.includes('evil.example'))).toEqual([]);
      expect(out.warnings).toEqual([{ blockIndex: 0, code: 'LINK_NOT_ALLOWED' }]);
    });
  });

  it('shows a hostile text as text: a tag is not a tag, a quote does not leave its attribute', () => {
    const out = mail([
      text({
        en: '<script>alert(1)</script> <img src=x onerror=alert(1)> [a" onclick="alert(1)](/x)',
      }),
    ]);

    expect(out.html).not.toContain('<script>');
    expect(out.html).not.toMatch(/<img\b[^>]*onerror/);
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out.html).not.toMatch(/<[^>]*\sonclick=/);
  });

  it.each([
    ['has no text in the language of the reader', { uk: 'Pryvit' }],
    ['has a blank text', { en: '   \n  ' }],
  ])('drops the block that %s, and tells the admin', (_case, body) => {
    const out = mail([text(body), text({ en: 'STAYS' })]);

    expect(out.warnings).toEqual([{ blockIndex: 0, code: 'TEXT_MISSING' }]);
    expect(wordsOf(out.html)).toContain('STAYS');
  });

  it('drops a text that is too long to read, it is not a text of the editor', () => {
    const out = mail([text({ en: 'x'.repeat(5001) })]);

    expect(out.warnings).toEqual(expect.arrayContaining([{ blockIndex: 0, code: 'TEXT_MISSING' }]));
  });
});

describe('a block of products', () => {
  const block: NewsletterBlockDto = { type: 'products', source: 'manual', productIds: [7] };

  it('shows a card with the name, the picture and the price, all linking to the page of the product', () => {
    const out = mail([block], [products(card())]);
    const page = 'https://shop.example.com/products/7?utm_source=newsletter&utm_campaign=41';

    const toProduct = anchors(out.html).filter((anchor) => anchor.href === page);
    expect(toProduct.length).toBeGreaterThanOrEqual(2);
    expect(toProduct.map((anchor) => anchor.label)).toContain('Linen shirt');
    expect(out.html).toContain(
      'src="https://res.cloudinary.com/demo/image/upload/c_fit,w_400/v1/p/7.jpg"',
    );
    expect(out.html).toContain('alt="Linen shirt"');
    expect(wordsOf(out.html)).toContain(euro('en', 12.5));
    expect(out.text).toContain(`Linen shirt: ${euro('en', 12.5)}`);
    expect(out.text).toContain(page);
  });

  it('builds the link on the id of the product', () => {
    const out = mail([block], [products(card({ productId: 91 }))]);

    expect(hrefs(out.html)).toContain(
      'https://shop.example.com/products/91?utm_source=newsletter&utm_campaign=41',
    );
  });

  it.each([
    ['en', '12.50'],
    ['uk', '12,50'],
    ['es', '12,50'],
  ])('writes money in the language of the reader: %s', (locale, digits) => {
    const out = mail([block], [products(card())], { locale });

    expect(wordsOf(out.html)).toContain(euro(locale, 12.5));
    expect(euro(locale, 12.5)).toContain(digits);
  });

  it('shows a product on sale with the price now, the regular price and the lowest of 30 days', () => {
    const out = mail(
      [block],
      [
        products(
          card({
            price: 100,
            salePrice: 70,
            priorPrice: 90,
            saleEndsAt: '2026-12-01T00:00:00.000Z',
          }),
        ),
      ],
    );
    const words = wordsOf(out.html);

    expect(words).toContain(euro('en', 70));
    expect(words).toContain(euro('en', 100));
    expect(words).toContain(phrase('en', 'campaignMail.lowestPrice', { price: euro('en', 90) }));
    expect(out.text).toContain(phrase('en', 'campaignMail.lowestPrice', { price: euro('en', 90) }));
    expect(out.text).toContain(euro('en', 70));
    expect(out.text).toContain(euro('en', 100));
  });

  // A card on sale says until when the price lasts, in the language of the reader and in the day of
  // the time zone of the shop. The mail is built when it is sent (hours or days after the products were
  // taken), and a sale that has ended by then is not shown: the regular price only
  describe('the end of a sale', () => {
    const onSale = (over: Partial<NewsletterCardDto> = {}) =>
      card({
        price: 100,
        salePrice: 70,
        priorPrice: 90,
        saleEndsAt: '2026-12-01T23:30:00.000Z',
        ...over,
      });
    const until = (locale: string, date: string) =>
      phrase(locale, 'campaignMail.saleUntil', { date });

    it.each([
      // 23:30 UTC on the first of December is already the second in Madrid
      ['en', '2 December 2026'],
      ['es', '2 de diciembre de 2026'],
    ])(
      'says until what day the sale lasts in %s, by the day in the time zone of the shop',
      (locale, date) => {
        const out = mail([block], [products(onSale())], { locale, timeZone: 'Europe/Madrid' });

        expect(wordsOf(out.html)).toContain(until(locale, date));
        expect(out.text).toContain(until(locale, date));
      },
    );

    it('writes the date the way the language writes it', () => {
      const out = mail([block], [products(onSale())], { locale: 'uk', timeZone: 'Europe/Madrid' });
      const date = new Intl.DateTimeFormat('uk', {
        dateStyle: 'long',
        timeZone: 'Europe/Madrid',
      }).format(new Date('2026-12-01T23:30:00.000Z'));

      expect(date).toContain('2026');
      expect(wordsOf(out.html)).toContain(until('uk', date));
    });

    it('counts the day in the time zone of the shop, not in UTC', () => {
      const inNewYork = mail([block], [products(onSale())], {
        locale: 'en',
        timeZone: 'America/New_York',
      });

      // 23:30 UTC is 18:30 on the first in New York
      expect(wordsOf(inNewYork.html)).toContain(until('en', '1 December 2026'));
    });

    it('takes the time zone of the shop by default', () => {
      const out = mail([block], [products(onSale())]);
      const date = new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'long',
        timeZone: env.SHOP_TIME_ZONE,
      }).format(new Date('2026-12-01T23:30:00.000Z'));

      expect(wordsOf(out.html)).toContain(until('en', date));
    });

    it('shows the sale price, the regular price and the lowest price of 30 days while it lasts', () => {
      const out = mail([block], [products(onSale())]);
      const words = wordsOf(out.html);

      expect(words).toContain(euro('en', 70));
      expect(words).toContain(euro('en', 100));
      expect(words).toContain(phrase('en', 'campaignMail.lowestPrice', { price: euro('en', 90) }));
    });

    it('keeps the sale to the last moment: a sale that ends a millisecond from now is shown', () => {
      const out = mail([block], [products(onSale({ saleEndsAt: '2026-11-10T12:00:00.001Z' }))], {
        timeZone: 'Europe/Madrid',
      });

      expect(wordsOf(out.html)).toContain(euro('en', 70));
      expect(wordsOf(out.html)).toContain(until('en', '10 November 2026'));
    });

    it.each([
      ['a day ago', '2026-11-09T12:00:00.000Z'],
      ['a second ago', '2026-11-10T11:59:59.000Z'],
      ['this very moment', '2026-11-10T12:00:00.000Z'],
    ])('shows the regular price only when the sale ended %s', (_when, saleEndsAt) => {
      const out = mail([block], [products(onSale({ saleEndsAt }))]);
      const words = wordsOf(out.html);

      expect(words).toContain(euro('en', 100));
      expect(words).not.toContain(euro('en', 70));
      expect(words).not.toContain(euro('en', 90));
      expect(words).not.toContain(dictionaryText('en', 'campaignMail.saleUntil').split('{{')[0]!);
      expect(words).not.toContain(dictionaryText('en', 'campaignMail.lowestPrice').split('{{')[0]!);
      expect(out.text).toContain(`Linen shirt: ${euro('en', 100)}`);
      expect(out.text).not.toContain(euro('en', 70));
      expect(out.text).not.toContain(euro('en', 90));
      expect(out.text).not.toContain(
        dictionaryText('en', 'campaignMail.saleUntil').split('{{')[0]!,
      );
    });

    it.each(['en', 'uk', 'es'])('shows the regular price only in %s too', (locale) => {
      const out = mail([block], [products(onSale({ saleEndsAt: '2026-11-01T00:00:00.000Z' }))], {
        locale,
      });
      const words = wordsOf(out.html);

      expect(words).toContain(euro(locale, 100));
      expect(words).not.toContain(euro(locale, 70));
    });

    it('judges the sale by the moment the mail is built, not by the moment the products were taken', () => {
      const cards = [products(onSale({ saleEndsAt: '2026-11-12T00:00:00.000Z' }))];

      const early = mail([block], cards, { now: new Date('2026-11-10T12:00:00.000Z') });
      const late = mail([block], cards, { now: new Date('2026-11-12T00:00:01.000Z') });

      expect(wordsOf(early.html)).toContain(euro('en', 70));
      expect(wordsOf(late.html)).not.toContain(euro('en', 70));
      expect(wordsOf(late.html)).toContain(euro('en', 100));
    });

    it('judges the sale by the time of now when no moment is given', () => {
      const future = onSale({ saleEndsAt: new Date(Date.now() + 3_600_000).toISOString() });
      const past = onSale({ saleEndsAt: new Date(Date.now() - 3_600_000).toISOString() });

      const open = renderCampaignMail({
        content: content([block]),
        snapshot: snapshot([products(future)]),
        locale: 'en',
        campaignId: CAMPAIGN,
        manageUrl: MANAGE,
        unsubscribeUrl: UNSUBSCRIBE,
        origin: ORIGIN,
      });
      const closed = renderCampaignMail({
        content: content([block]),
        snapshot: snapshot([products(past)]),
        locale: 'en',
        campaignId: CAMPAIGN,
        manageUrl: MANAGE,
        unsubscribeUrl: UNSUBSCRIBE,
        origin: ORIGIN,
      });

      expect(wordsOf(open.html)).toContain(euro('en', 70));
      expect(wordsOf(closed.html)).not.toContain(euro('en', 70));
    });

    it('shows a sale that has no end as a sale, with no date', () => {
      const out = mail([block], [products(onSale({ saleEndsAt: null }))]);
      const words = wordsOf(out.html);

      expect(words).toContain(euro('en', 70));
      expect(words).not.toContain(dictionaryText('en', 'campaignMail.saleUntil').split('{{')[0]!);
    });

    it('shows a sale with an end it cannot read as a sale, with no date', () => {
      const out = mail([block], [products(onSale({ saleEndsAt: 'next week' }))]);
      const words = wordsOf(out.html);

      expect(words).toContain(euro('en', 70));
      expect(words).not.toContain(dictionaryText('en', 'campaignMail.saleUntil').split('{{')[0]!);
    });

    it('says nothing of a sale for a card that is not on sale, whatever the end says', () => {
      const out = mail(
        [block],
        [products(card({ salePrice: null, saleEndsAt: '2026-12-01T00:00:00.000Z' }))],
      );

      expect(wordsOf(out.html)).not.toContain(
        dictionaryText('en', 'campaignMail.saleUntil').split('{{')[0]!,
      );
    });

    it('judges every card on its own', () => {
      const out = mail(
        [block],
        [
          products(
            onSale({ productId: 1, name: 'ALPHA', saleEndsAt: '2026-11-01T00:00:00.000Z' }),
            onSale({ productId: 2, name: 'BRAVO' }),
          ),
        ],
      );
      const words = wordsOf(out.html);
      const alpha = words.slice(words.indexOf('ALPHA'), words.indexOf('BRAVO'));
      const bravo = words.slice(words.indexOf('BRAVO'));

      expect(alpha).toContain(euro('en', 100));
      expect(alpha).not.toContain(euro('en', 70));
      expect(bravo).toContain(euro('en', 70));
    });
  });

  it.each(['en', 'uk', 'es'])('says the lowest price of 30 days in %s', (locale) => {
    const out = mail([block], [products(card({ price: 100, salePrice: 70, priorPrice: 90 }))], {
      locale,
    });

    expect(wordsOf(out.html)).toContain(
      phrase(locale, 'campaignMail.lowestPrice', { price: euro(locale, 90) }),
    );
  });

  it('does not say the lowest price when the sale does not know it', () => {
    const out = mail([block], [products(card({ price: 100, salePrice: 70, priorPrice: null }))]);
    const sentence = dictionaryText('en', 'campaignMail.lowestPrice').split('{{')[0]!;

    expect(out.html).not.toContain(sentence);
    expect(out.text).not.toContain(sentence);
  });

  it('does not say the lowest price for a product that is not on sale', () => {
    const out = mail([block], [products(card({ priorPrice: 9 }))]);

    expect(out.html).not.toContain(
      dictionaryText('en', 'campaignMail.lowestPrice').split('{{')[0]!,
    );
  });

  it.each(['en', 'uk', 'es'])('says "from" the lowest price in %s', (locale) => {
    const out = mail([block], [products(card({ price: 12, from: true }))], { locale });

    expect(wordsOf(out.html)).toContain(
      phrase(locale, 'campaignMail.priceFrom', { price: euro(locale, 12) }),
    );
  });

  it('shows the cards in the order of the snapshot', () => {
    const out = mail(
      [block],
      [
        products(
          card({ productId: 1, name: 'ALPHA' }),
          card({ productId: 2, name: 'BRAVO' }),
          card({ productId: 3, name: 'CHARLIE' }),
        ),
      ],
    );
    const words = wordsOf(out.html);

    expect(words.indexOf('ALPHA')).toBeLessThan(words.indexOf('BRAVO'));
    expect(words.indexOf('BRAVO')).toBeLessThan(words.indexOf('CHARLIE'));
  });

  it('shows a card without a picture, and does not trust a picture that is no web address', () => {
    for (const imageUrl of [null, 'javascript:alert(1)', 'data:image/png;base64,AAAA']) {
      const out = mail([block], [products(card({ imageUrl }))]);

      expect(out.html).not.toMatch(/<img\b/);
      expect(out.html).not.toContain('javascript:');
      expect(out.html).not.toContain('data:image');
      expect(wordsOf(out.html)).toContain('Linen shirt');
    }
  });

  // the names are the shop's own and typed by people: they never become markup
  it('shows a hostile name of a product as text, in the page and in the picture description', () => {
    const name = '<script>alert(1)</script> "quoted" & <b>bold</b>';
    const out = mail([block], [products(card({ name }))]);

    expect(out.html).not.toContain('<script>');
    expect(out.html).not.toContain('<b>bold</b>');
    expect(out.html).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt; &quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt;',
    );
    expect(out.html).toContain('alt="&lt;script&gt;');
  });

  it('keeps a hostile name as it is in the plain text, which is no markup', () => {
    const out = mail([block], [products(card({ name: '<b>x</b>' }))]);

    expect(out.text).toContain('<b>x</b>: ');
  });

  describe('the title', () => {
    const titled = (title: Record<string, string>): NewsletterBlockDto => ({
      type: 'products',
      source: 'manual',
      productIds: [7],
      title,
    });

    it('is written in the language of the reader, and escaped', () => {
      const body = { en: 'Our <picks>', uk: 'Nash vybir', es: 'Nuestra selección' };

      for (const [locale, title] of Object.entries(body)) {
        const out = mail([titled(body)], [products(card())], { locale });

        expect(wordsOf(out.html)).toContain(title);
        expect(out.text).toContain(title);
        expect(out.html).not.toContain('<picks>');
      }
    });

    it('is left out, and told, when the block has titles but none in this language', () => {
      const out = mail([titled({ uk: 'Nash vybir' })], [products(card())]);

      expect(out.warnings).toEqual([{ blockIndex: 0, code: 'TITLE_MISSING' }]);
      expect(wordsOf(out.html)).toContain('Linen shirt');
      expect(out.html).not.toContain('Nash vybir');
    });

    it('is not missed when the block has no titles at all', () => {
      expect(mail([block], [products(card())]).warnings).toEqual([]);
      expect(mail([titled({})], [products(card())]).warnings).toEqual([]);
    });
  });

  describe('what is left out', () => {
    it('tells of each product that was left out, and shows the others', () => {
      const out = mail([block], [{ ...products(card()), unavailable: [8, 9] }]);

      expect(out.warnings).toEqual([
        { blockIndex: 0, code: 'PRODUCT_UNAVAILABLE', productId: 8 },
        { blockIndex: 0, code: 'PRODUCT_UNAVAILABLE', productId: 9 },
      ]);
      expect(wordsOf(out.html)).toContain('Linen shirt');
    });

    it('drops a block that has no card, with a warning', () => {
      const out = mail([text({ en: 'STAYS' }), block], [null, products()]);

      expect(out.warnings).toEqual([{ blockIndex: 1, code: 'BLOCK_EMPTY' }]);
      expect(wordsOf(out.html)).toContain('STAYS');
    });

    it('drops a block of products that were all left out, and tells of both', () => {
      const out = mail([text({ en: 'STAYS' }), block], [null, { ...products(), unavailable: [7] }]);

      expect(out.warnings).toEqual([
        { blockIndex: 1, code: 'PRODUCT_UNAVAILABLE', productId: 7 },
        { blockIndex: 1, code: 'BLOCK_EMPTY' },
      ]);
    });

    it('drops a block of a rule whose category is gone, and says so, not that it is empty', () => {
      const out = mail(
        [block],
        [{ kind: 'products', items: [], unavailable: [], categoryMissing: true }],
      );

      expect(out.warnings).toEqual([
        { blockIndex: 0, code: 'CATEGORY_MISSING' },
        { blockIndex: null, code: 'MAIL_EMPTY' },
      ]);
    });

    it.each([
      ['has no place in the snapshot', []],
      ['has a place of another kind', [{ kind: 'category' as const, category: null }]],
    ])('drops a block of products that %s', (_case, snap) => {
      const out = mail([block], snap);

      expect(out.warnings).toEqual([
        { blockIndex: 0, code: 'BLOCK_EMPTY' },
        { blockIndex: null, code: 'MAIL_EMPTY' },
      ]);
    });
  });
});

describe('a block of a category', () => {
  const block: NewsletterBlockDto = { type: 'category', categoryId: 3 };
  const known = (over: Partial<{ name: string; imageUrl: string | null }> = {}) => ({
    kind: 'category' as const,
    category: {
      id: 3,
      name: 'Shoes',
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/c_fit,w_400/v1/c/3.jpg',
      ...over,
    },
  });

  it('shows the name and the picture, both linking to the page of the category', () => {
    const out = mail([block], [known()]);
    const page = 'https://shop.example.com/categories/3?utm_source=newsletter&utm_campaign=41';

    const toCategory = anchors(out.html).filter((anchor) => anchor.href === page);
    expect(toCategory.map((anchor) => anchor.label)).toContain('Shoes');
    expect(toCategory.length).toBeGreaterThanOrEqual(2);
    expect(out.html).toContain(
      'src="https://res.cloudinary.com/demo/image/upload/c_fit,w_400/v1/c/3.jpg"',
    );
    expect(out.text).toContain('Shoes');
    expect(out.text).toContain(page);
  });

  it.each(['en', 'uk', 'es'])('has the button of the category in %s', (locale) => {
    const out = mail([block], [known()], { locale });

    expect(wordsOf(out.html)).toContain(dictionaryText(locale, 'campaignMail.buttonCategory'));
  });

  it('shows a category without a picture by its name', () => {
    const out = mail([block], [known({ imageUrl: null })]);

    expect(out.html).not.toMatch(/<img\b/);
    expect(wordsOf(out.html)).toContain('Shoes');
  });

  it('shows a hostile name of a category as text', () => {
    const out = mail([block], [known({ name: '<script>x</script> & "y"' })]);

    expect(out.html).not.toContain('<script>x');
    expect(out.html).toContain('&lt;script&gt;x&lt;/script&gt; &amp; &quot;y&quot;');
  });

  it('has the title of the language of the reader', () => {
    const titled: NewsletterBlockDto = {
      type: 'category',
      categoryId: 3,
      title: { en: 'Walk', uk: 'Prohulianka' },
    };

    expect(wordsOf(mail([titled], [known()]).html)).toContain('Walk');
    expect(wordsOf(mail([titled], [known()], { locale: 'uk' }).html)).toContain('Prohulianka');
  });

  it('drops a block of a category that is gone, with a warning', () => {
    const out = mail([block], [{ kind: 'category', category: null }]);

    expect(out.warnings).toEqual(
      expect.arrayContaining([{ blockIndex: 0, code: 'CATEGORY_MISSING' }]),
    );
    expect(hrefs(out.html).filter((href) => href.includes('/categories/'))).toEqual([]);
  });
});

describe('a button', () => {
  const button = (kind: string, url: string): NewsletterBlockDto =>
    ({ type: 'button', kind, url }) as NewsletterBlockDto;

  it.each([
    ['shop', 'buttonShop'],
    ['sale', 'buttonSale'],
    ['new', 'buttonNew'],
    ['category', 'buttonCategory'],
    ['product', 'buttonProduct'],
  ])(
    'labels a button of the kind %s from the dictionary, in the language of the reader',
    (kind, key) => {
      for (const locale of ['en', 'uk', 'es']) {
        const out = mail([button(kind, '/target')], [null], { locale });
        const label = dictionaryText(locale, `campaignMail.${key}`);

        expect(anchors(out.html).some((anchor) => anchor.label === label)).toBe(true);
        expect(out.text).toContain(
          `${label}: https://shop.example.com/target?utm_source=newsletter&utm_campaign=41`,
        );
      }
    },
  );

  it.each([
    [
      'a path of the shop',
      '/sale',
      'https://shop.example.com/sale?utm_source=newsletter&utm_campaign=41',
    ],
    [
      'an address of the shop',
      'https://shop.example.com/sale',
      'https://shop.example.com/sale?utm_source=newsletter&utm_campaign=41',
    ],
    [
      'a path with a query',
      '/sale?color=red',
      'https://shop.example.com/sale?color=red&utm_source=newsletter&utm_campaign=41',
    ],
    [
      'the home of the shop',
      '/',
      'https://shop.example.com/?utm_source=newsletter&utm_campaign=41',
    ],
  ])('links to %s with the marks of the campaign', (_case, url, expected) => {
    const out = mail([button('sale', url)]);

    expect(hrefs(out.html)).toContain(expected);
  });

  // the content was checked when it was written; the address of the shop may have changed since, and
  // a content that was changed behind the back of the check must not send the readers away
  it.each([
    ['an address of another site', 'https://evil.example/pay'],
    ['the address of the shop as it was before', 'https://old-shop.example.org/sale'],
    ['an address that starts with two slashes', '//evil.example/pay'],
    ['a javascript address', 'javascript:alert(1)'],
    ['an address with a space', '/sale now'],
    ['a backslash', '/\\evil.example'],
    ['a relative path', 'sale'],
    ['nothing', ''],
  ])('drops a button that links to %s, with a warning', (_case, url) => {
    const out = mail([text({ en: 'STAYS' }), button('shop', url)]);

    expect(out.warnings).toEqual([{ blockIndex: 1, code: 'LINK_NOT_ALLOWED' }]);
    expect(wordsOf(out.html)).toContain('STAYS');
    expect(wordsOf(out.html)).not.toContain(dictionaryText('en', 'campaignMail.buttonShop'));
    expect(hrefs(out.html).filter((href) => href.includes('evil.example'))).toEqual([]);
  });

  // a button may lead to a site root trusts as well, as it is and with no marks of the campaign
  describe('to a site root trusts', () => {
    const TRUSTED = ['partner.test'];

    it('links to it with no marks of the campaign', () => {
      const out = mail([button('shop', 'https://www.partner.test/offer?a=1')], [], {
        trustedDomains: TRUSTED,
      });
      const label = dictionaryText('en', 'campaignMail.buttonShop');

      expect(hrefs(out.html)).toContain('https://www.partner.test/offer?a=1');
      expect(out.text).toContain(`${label}: https://www.partner.test/offer?a=1`);
      expect(out.warnings).toEqual([]);
    });

    it('is read from the setting of the shop unless the call names the sites', () => {
      setShopSettings({ newsletterTrustedDomains: TRUSTED });

      const out = mail([button('shop', 'https://partner.test/')]);

      expect(hrefs(out.html)).toContain('https://partner.test/');
      expect(out.warnings).toEqual([]);
    });

    it('is dropped, with a warning, when root took the site away', () => {
      setShopSettings({ newsletterTrustedDomains: [] });

      expect(mail([button('shop', 'https://partner.test/')]).warnings).toEqual([
        { blockIndex: 0, code: 'LINK_NOT_ALLOWED' },
        { blockIndex: null, code: 'MAIL_EMPTY' },
      ]);
    });

    it.each([
      ['another site', 'https://evil.example/pay'],
      ['a site that starts like a trusted one', 'https://partner.test.evil.example/'],
      ['a trusted site with a user name', 'https://user@partner.test/'],
      ['a trusted site as a protocol-relative address', '//partner.test/offer'],
    ])('still drops a button that links to %s', (_case, url) => {
      const out = mail([text({ en: 'STAYS' }), button('shop', url)], [], {
        trustedDomains: TRUSTED,
      });

      expect(out.warnings).toEqual([{ blockIndex: 1, code: 'LINK_NOT_ALLOWED' }]);
      expect(hrefs(out.html).filter((href) => href.includes('evil.example'))).toEqual([]);
    });
  });

  it('re-checks the address against the origin of the shop as it is now', () => {
    const saved = [button('sale', 'https://shop.example.com/sale')];

    expect(mail(saved).warnings).toEqual([]);
    expect(mail(saved, [], { origin: 'https://other.example.org' }).warnings).toEqual([
      { blockIndex: 0, code: 'LINK_NOT_ALLOWED' },
      { blockIndex: null, code: 'MAIL_EMPTY' },
    ]);
  });
});

describe('a mail with nothing left', () => {
  it('tells the mail is empty when every block was dropped, and still has its top and its foot', () => {
    const out = mail(
      [{ type: 'products', source: 'manual', productIds: [7] }, text({ uk: 'x' })],
      [products()],
      { logoUrl: LOGO_URL },
    );

    expect(out.warnings).toEqual([
      { blockIndex: 0, code: 'BLOCK_EMPTY' },
      { blockIndex: 1, code: 'TEXT_MISSING' },
      { blockIndex: null, code: 'MAIL_EMPTY' },
    ]);
    expect(out.html).toContain(`src="${LOGO_URL}"`);
    expect(hrefs(out.html)).toContain(MANAGE);
  });

  it('tells the mail is empty when it has no blocks at all', () => {
    expect(mail([]).warnings).toEqual([{ blockIndex: null, code: 'MAIL_EMPTY' }]);
  });

  it('does not tell it when something is shown', () => {
    expect(
      mail([text({ en: 'x' })]).warnings.some((warning) => warning.code === 'MAIL_EMPTY'),
    ).toBe(false);
  });

  // Gmail cuts a mail of about 100 KB and hides the foot with the link to leave
  it('warns when the html is past the size Gmail cuts at', () => {
    const big = Array.from({ length: 25 }, () => text({ en: 'word '.repeat(1000) }));

    const out = mail(big);

    expect(Buffer.byteLength(out.html)).toBeGreaterThan(102_400);
    expect(out.warnings).toContainEqual({ blockIndex: null, code: 'MAIL_TOO_LARGE' });
    expect(mail([text({ en: 'short' })]).warnings).toEqual([]);
  });
});

describe('the headers', () => {
  it('asks the mail program for a one-click unsubscribe (RFC 8058)', () => {
    expect(mail([]).headers).toEqual({
      'List-Unsubscribe': `<${UNSUBSCRIBE}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it.each([
    ['empty', ''],
    ['not an address', 'mailto:stop@example.com'],
    ['with a space', 'https://api.example.com/x y'],
    ['with an angle bracket', 'https://api.example.com/x>, <https://evil.example/'],
    ['with a new line', 'https://api.example.com/x\r\nBcc: a@b.c'],
  ])(
    'refuses an address of the unsubscribe that is %s: it would be a header of another mail',
    (_case, url) => {
      expect(() => mail([], [], { unsubscribeUrl: url })).toThrow();
    },
  );

  it.each([
    ['empty', ''],
    ['blank', '  '],
  ])('refuses a link to manage that is %s', (_case, url) => {
    expect(() => mail([], [], { manageUrl: url })).toThrow();
  });
});

describe('the address of the shop', () => {
  it('is the address the app knows when none is given', () => {
    const out = renderCampaignMail({
      content: content([{ type: 'button', kind: 'shop', url: '/sale' }]),
      snapshot: snapshot([null]),
      locale: 'en',
      campaignId: CAMPAIGN,
      manageUrl: MANAGE,
      unsubscribeUrl: UNSUBSCRIBE,
    });

    // the address of the frontend in the tests, when none is set
    expect(hrefs(out.html)).toContain(
      'http://localhost:3000/sale?utm_source=newsletter&utm_campaign=41',
    );
  });

  it('stops the mail when the app has none: no link could be built', () => {
    expect(() => mail([], [], { origin: null })).toThrow(
      expect.objectContaining({ details: { reason: 'WEB_ORIGIN_REQUIRED' } }),
    );
  });
});

describe('the plain text', () => {
  it('has no html', () => {
    const out = mail(
      [
        text({ en: '# Hi\n**bold** [sale](/sale)' }),
        { type: 'products', source: 'manual', productIds: [7] },
        { type: 'category', categoryId: 3 },
        { type: 'button', kind: 'shop', url: '/' },
      ],
      [
        null,
        products(card()),
        { kind: 'category', category: { id: 3, name: 'Shoes', imageUrl: null } },
        null,
      ],
      { logoUrl: LOGO_URL },
    );

    expect(out.text).not.toMatch(/<\/?[a-z][^>]*>/i);
    expect(out.text).not.toContain('&amp;');
  });

  it('is the readable mail: every link of the html is written out in it', () => {
    const out = mail(
      [text({ en: '[sale](/sale)' }), { type: 'products', source: 'manual', productIds: [7] }],
      [null, products(card())],
    );

    for (const href of new Set(hrefs(out.html).filter((href) => href.startsWith('http')))) {
      expect(out.text).toContain(href);
    }
  });
});
