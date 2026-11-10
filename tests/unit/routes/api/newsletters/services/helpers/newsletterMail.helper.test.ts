import { afterEach, describe, expect, it } from '@jest/globals';

import { manageTokenOf } from '@helpers/newsletterTokens.js';
import {
  deadManageToken,
  newsletterMailFor,
} from '@routes/api/newsletters/services/helpers/newsletterMail.helper.js';
import type { NewsletterContentDto, NewsletterSnapshotDto } from 'types/dto/newsletters.dto.js';

import { stubFetch } from '../../../../../../helpers/fetchStub.js';
import { dictionaryText } from '../../../../../../helpers/dictionary.js';
import { resetShopSettings, setShopSettings } from '../../../../../../helpers/shopSettings.js';

// The mail of a campaign for one reader, ready for the sender of the newsletters. The links of the
// subscription are the reader's own, or (the test mail of an admin) dead ones that touch nothing

const content: NewsletterContentDto = {
  subject: { en: 'Spring sale', es: 'Rebajas' },
  preview: {},
  blocks: [{ type: 'text', text: { en: 'Hello', es: 'Hola' } }],
};
const snapshot: NewsletterSnapshotDto = {
  takenAt: '2026-11-09T12:00:00.000Z',
  currency: 'EUR',
  blocks: [null],
};
const campaign = { id: 41, content };

// the token in the address of the manage page of the html and of the text, and of the unsubscribe
const manageTokenIn = (text: string) => /newsletter\/manage#token=([^\s"&<]+)/.exec(text)![1]!;
const unsubscribeTokenIn = (header: string) =>
  /\/api\/newsletters\/unsubscribe\/([^/?>]+)\?c=41>/.exec(header)![1]!;

afterEach(() => {
  resetShopSettings();
});

describe('deadManageToken', () => {
  it('is a token of the size of a real one, and a new one every time', () => {
    const tokens = Array.from({ length: 50 }, () => deadManageToken());

    expect(new Set(tokens).size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  // a real token is made of the salt of a subscription and the secret of the links: this one is not
  it('is not the token of any salt', () => {
    expect(deadManageToken()).not.toBe(manageTokenOf('a'.repeat(43)));
  });
});

describe('newsletterMailFor, for a reader', () => {
  it('links to the page of the subscription on the token of management and to its one-click unsubscribe on the token of the unsubscribe', () => {
    const mail = newsletterMailFor({
      campaign,
      snapshot,
      locale: 'en',
      subscriber: { manageToken: 'READER_TOKEN', unsubscribeToken: 'LEAVE_TOKEN' },
    });

    expect(mail.html).toContain('http://localhost:3000/newsletter/manage#token=READER_TOKEN');
    expect(mail.text).toContain('http://localhost:3000/newsletter/manage#token=READER_TOKEN');
    expect(mail.html).not.toContain('LEAVE_TOKEN');
    expect(mail.headers).toEqual({
      'List-Unsubscribe': '<http://localhost:4000/api/newsletters/unsubscribe/LEAVE_TOKEN?c=41>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('is the subject, the bodies, the headers and the warnings, nothing the sender adds', () => {
    const mail = newsletterMailFor({
      campaign,
      snapshot,
      locale: 'es',
      subscriber: { manageToken: 'T', unsubscribeToken: 'U' },
    });

    expect(Object.keys(mail).sort()).toEqual(['headers', 'html', 'subject', 'text', 'warnings']);
    expect(mail.subject).toBe('Rebajas');
    expect(mail.warnings).toEqual([]);
    // the ids of the campaign and of the reader that SendGrid hands back are the sender's to add
    expect(mail).not.toHaveProperty('customArgs');
  });

  it('is an error for a language the campaign has no subject in', () => {
    expect(() =>
      newsletterMailFor({
        campaign,
        snapshot,
        locale: 'uk',
        subscriber: { manageToken: 'T', unsubscribeToken: 'U' },
      }),
    ).toThrow('NEWSLETTER_LOCALE_NOT_IN_CAMPAIGN');
  });
});

describe('newsletterMailFor, without a reader', () => {
  it('links to a token no subscription has, the same in the page and in the unsubscribe', () => {
    const mail = newsletterMailFor({ campaign, snapshot, locale: 'en' });

    const token = manageTokenIn(mail.html);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(manageTokenIn(mail.text)).toBe(token);
    expect(unsubscribeTokenIn(mail.headers['List-Unsubscribe']!)).toBe(token);
  });

  it('makes a new dead token for every mail', () => {
    const first = newsletterMailFor({ campaign, snapshot, locale: 'en' });
    const second = newsletterMailFor({ campaign, snapshot, locale: 'en' });

    expect(manageTokenIn(first.html)).not.toBe(manageTokenIn(second.html));
  });

  it('is otherwise the mail of a reader, with no mark of a test', () => {
    const dead = newsletterMailFor({ campaign, snapshot, locale: 'en' });
    const real = newsletterMailFor({
      campaign,
      snapshot,
      locale: 'en',
      subscriber: { manageToken: 'X'.repeat(43), unsubscribeToken: 'Y'.repeat(43) },
    });
    const hide = (html: string) => html.replace(/[A-Za-z0-9_-]{43}/g, 'TOKEN');

    expect(hide(dead.html)).toBe(hide(real.html));
    expect(hide(dead.text)).toBe(hide(real.text));
    expect(dead.subject).toBe(real.subject);
    expect(dead.subject.toLowerCase()).not.toContain('test');
    expect(dead.html.toLowerCase()).not.toContain('[test]');
  });
});

describe('the logo', () => {
  const LOGO =
    'https://res.cloudinary.com/cartlify-test/image/upload/v1/test/shop/logo/campaign.png';

  // the mail shows the logo by its address at Cloudinary: it asks nobody for the file and carries none
  it('is shown by its address when the shop has one, and nothing is fetched or attached', () => {
    setShopSettings({ logoUrl: LOGO });
    const calls = stubFetch(() => new Response('no', { status: 500 }));

    const mail = newsletterMailFor({ campaign, snapshot, locale: 'en' });

    expect(mail.html).toContain(`<img src="${LOGO}"`);
    expect(mail).not.toHaveProperty('attachments');
    expect(calls).toHaveLength(0);
  });

  it('is left out when the shop has none: the name of the shop in its place', () => {
    setShopSettings({ logoUrl: null, shopName: 'Linen & Co' });

    const mail = newsletterMailFor({ campaign, snapshot, locale: 'en' });

    expect(mail.html).not.toMatch(/<img\b/);
    expect(mail.html).toContain('Linen &amp; Co');
  });
});

describe('the test mail', () => {
  const marks = (locale: string) => ({
    prefix: dictionaryText(locale, 'campaignMail.testSubjectPrefix'),
    notice: dictionaryText(locale, 'campaignMail.testNotice'),
  });

  it.each(['en', 'es'])(
    'starts the subject with the prefix of the language and puts the notice at the top: %s',
    (locale) => {
      const { prefix, notice } = marks(locale);

      const mail = newsletterMailFor({ campaign, snapshot, locale, test: true });

      expect(mail.subject).toBe(`${prefix} ${content.subject[locale]}`);
      expect(mail.text.startsWith(notice)).toBe(true);
      expect(mail.html).toContain(notice);
    },
  );

  it('is the same mail as the reader gets once the marks are put aside', () => {
    const { prefix, notice } = marks('en');
    const plain = newsletterMailFor({ campaign, snapshot, locale: 'en' });
    const test = newsletterMailFor({ campaign, snapshot, locale: 'en', test: true });
    const hide = (text: string) => text.replace(/[A-Za-z0-9_-]{43}/g, 'TOKEN');

    expect(test.subject).toBe(`${prefix} ${plain.subject}`);
    expect(hide(test.text)).toBe(`${notice}\n\n${hide(plain.text)}`);
    expect(test.headers['List-Unsubscribe']).toMatch(/^<http/);
    expect(test.warnings).toEqual(plain.warnings);
  });

  it('is no test mail unless asked: no flag, no marks', () => {
    const { prefix, notice } = marks('en');

    for (const test of [undefined, false]) {
      const mail = newsletterMailFor({
        campaign,
        snapshot,
        locale: 'en',
        ...(test === undefined ? {} : { test }),
      });

      expect(mail.subject).not.toContain(prefix);
      expect(mail.text).not.toContain(notice);
      expect(mail.html).not.toContain(notice);
    }
  });
});

describe('a sale on a card', () => {
  const euro = (value: number) =>
    new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR' }).format(value);
  const product = (saleEndsAt: string | null) =>
    ({
      takenAt: '2026-11-09T12:00:00.000Z',
      currency: 'EUR',
      blocks: [
        {
          kind: 'products',
          items: [
            {
              productId: 7,
              variantId: 70,
              name: 'Linen shirt',
              imageUrl: null,
              price: 100,
              from: false,
              salePrice: 70,
              priorPrice: null,
              saleEndsAt,
            },
          ],
          unavailable: [],
          categoryMissing: false,
        },
      ],
    }) satisfies NewsletterSnapshotDto;
  const withProducts: NewsletterContentDto = {
    ...content,
    blocks: [{ type: 'products', source: 'manual', productIds: [7] }],
  };
  const mailFor = (saleEndsAt: string | null) =>
    newsletterMailFor({
      campaign: { id: 41, content: withProducts },
      snapshot: product(saleEndsAt),
      locale: 'en',
    });

  // the products are taken when the campaign starts, the mails go out hours or days later: the sale is
  // judged when the mail is built
  it('is shown with the day it ends while it lasts', () => {
    const mail = mailFor(new Date(Date.now() + 3 * 24 * 3_600_000).toISOString());

    expect(mail.text).toContain(euro(70));
    expect(mail.text).toContain(dictionaryText('en', 'campaignMail.saleUntil').split('{{')[0]!);
  });

  it('is left out, the regular price only, once it has ended by the time the mail is built', () => {
    const mail = mailFor(new Date(Date.now() - 3_600_000).toISOString());

    expect(mail.text).toContain('Linen shirt: ');
    expect(mail.text).toContain(`Linen shirt: ${euro(100)}`);
    expect(mail.text).not.toContain(euro(70));
    expect(mail.text).not.toContain(dictionaryText('en', 'campaignMail.saleUntil').split('{{')[0]!);
  });
});
