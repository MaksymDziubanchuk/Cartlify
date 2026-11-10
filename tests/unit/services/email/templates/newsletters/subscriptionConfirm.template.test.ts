import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { buildSubscriptionConfirmTemplate } from '@services/email/templates/newsletters/subscriptionConfirm.template.js';

import { resetShopSettings, setShopSettings } from '../../../../../helpers/shopSettings.js';

// the logo of the shop is shown by its address at Cloudinary: the mail carries no attachment
const LOGO_URL = 'https://res.cloudinary.com/cartlify-test/image/upload/v1/test/shop/logo/a.png';

const confirmUrl = 'https://shop.test/newsletter/confirm?token=abc123';
const declineUrl = 'https://shop.test/newsletter/decline?token=abc123';
const args = { confirmUrl, declineUrl };

afterEach(() => {
  jest.useRealTimers();
  resetShopSettings();
});

// the anchor of a link, with the words it shows
const anchorTo = (html: string, url: string): string => {
  const match = new RegExp(`<a href="${url.replaceAll('?', '\\?')}"[^>]*>([\\s\\S]*?)</a>`).exec(
    html,
  );
  return match ? match[1]!.replace(/\s+/g, ' ').trim() : '';
};

describe('buildSubscriptionConfirmTemplate', () => {
  it('names the shop and the purpose in the subject', () => {
    const { subject } = buildSubscriptionConfirmTemplate(args);

    expect(subject).toContain('Cartlify');
    expect(subject.toLowerCase()).toContain('confirm your subscription');
  });

  it('uses the given shop name instead of the default one', () => {
    const { subject, html, text } = buildSubscriptionConfirmTemplate({
      ...args,
      appName: 'Other Shop',
    });

    expect(subject).toContain('Other Shop');
    expect(html).toContain('newsletter of Other Shop');
    expect(text).toContain('newsletter of Other Shop');
  });

  it('says that someone, maybe the reader, asked to subscribe this address', () => {
    const { html, text } = buildSubscriptionConfirmTemplate(args);

    for (const part of [html, text]) {
      expect(part).toContain('Someone, maybe you, asked to subscribe this address');
      expect(part).toContain('the newsletter of Cartlify');
    }
  });

  describe('the two buttons', () => {
    it('has a button that confirms, with the confirmation link', () => {
      const { html } = buildSubscriptionConfirmTemplate(args);

      expect(anchorTo(html, confirmUrl)).toContain('Confirm the subscription');
    });

    it('has a second button "this is not me", with the other link', () => {
      const { html } = buildSubscriptionConfirmTemplate(args);

      expect(anchorTo(html, declineUrl)).toBe('This is not me, do not send anything more');
    });

    it('keeps the two links apart: each button opens its own', () => {
      const { html } = buildSubscriptionConfirmTemplate(args);

      expect(anchorTo(html, confirmUrl)).not.toContain('not me');
      expect(anchorTo(html, declineUrl)).not.toContain('Confirm the subscription');
    });

    it('puts both links in the text version too, each under its words', () => {
      const { text } = buildSubscriptionConfirmTemplate(args);

      expect(text).toContain(confirmUrl);
      expect(text).toContain(declineUrl);
      expect(text).toMatch(/Confirm the subscription:\s+https:\/\/shop\.test\/newsletter\/confirm/);
      expect(text).toMatch(
        /This is not me, do not send anything more:\s+https:\/\/shop\.test\/newsletter\/decline/,
      );
    });

    // the buttons are the only actions: the mail adds no other link to this address's subscription
    it('links nowhere else, but to the two pages and the support address', () => {
      const { html } = buildSubscriptionConfirmTemplate(args);
      const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);

      expect(
        hrefs.every(
          (href) => [confirmUrl, declineUrl].includes(href!) || href!.startsWith('mailto:'),
        ),
      ).toBe(true);
    });
  });

  it('says the link is valid for 3 days', () => {
    const { html, text } = buildSubscriptionConfirmTemplate(args);

    expect(html).toContain('valid for 3 days');
    expect(text).toContain('valid for 3 days');
  });

  it('says that nothing needs to be done if it was not the reader, and there will be no subscription', () => {
    const { html, text } = buildSubscriptionConfirmTemplate(args);

    expect(html).toContain('If it was not you, do nothing and there will be no subscription.');
    expect(text).toContain('If it was not you, do nothing and there will be no subscription.');
  });

  it('gives the plain link as well, for a reader whose mail program shows no button', () => {
    const { html } = buildSubscriptionConfirmTemplate(args);

    expect(html).toContain('If the button does not work, open this link:');
    expect(html).toContain(`>${confirmUrl}</a>`);
  });

  it('keeps the plain text version free of html', () => {
    const { text } = buildSubscriptionConfirmTemplate({ ...args, logoUrl: LOGO_URL });

    expect(text).not.toMatch(/<[a-z!/]/i);
  });

  it('does not greet by a name: the reader of this mail has none', () => {
    const { html } = buildSubscriptionConfirmTemplate(args);

    expect(html).not.toContain('Hi,');
  });

  describe('the seller', () => {
    const SELLER = {
      sellerLegalName: 'Cartlify LLC',
      sellerAddress: 'Main St 1, Kyiv',
      sellerTaxId: null,
      sellerEmail: 'legal@cartlify.test',
      sellerPhone: null,
    };

    it('is named at the foot, in the html and in the text, once root has filled it in', () => {
      setShopSettings(SELLER);
      const { html, text } = buildSubscriptionConfirmTemplate(args);

      expect(html).toContain('Seller: Cartlify LLC, Main St 1, Kyiv, legal@cartlify.test');
      expect(text).toContain('Seller: Cartlify LLC, Main St 1, Kyiv, legal@cartlify.test');
    });

    it('is in the language of the mail', () => {
      setShopSettings(SELLER);

      expect(buildSubscriptionConfirmTemplate({ ...args, locale: 'uk' }).text).toContain(
        'Продавець: Cartlify LLC',
      );
    });

    it('is left out while root has filled in none of it', () => {
      setShopSettings({
        sellerLegalName: null,
        sellerAddress: null,
        sellerTaxId: null,
        sellerEmail: null,
        sellerPhone: null,
      });
      const { html, text } = buildSubscriptionConfirmTemplate(args);

      expect(html).not.toContain('Seller');
      expect(text).not.toContain('Seller');
    });
  });

  it('escapes the shop name, it is typed by root and must not inject html', () => {
    const { html } = buildSubscriptionConfirmTemplate({
      ...args,
      appName: '<script>alert(1)</script>',
    });

    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes the links so they cannot break out of the href', () => {
    const { html } = buildSubscriptionConfirmTemplate({
      confirmUrl: 'https://shop.test/c?a=1&b="><script>alert(1)</script>',
      declineUrl: 'https://shop.test/d?a=1&b="><script>alert(2)</script>',
    });

    expect(html).not.toContain('"><script>');
    expect(html).toContain('a=1&amp;b=');
  });

  it('shows the logo by its address when the shop has one, the shop name otherwise', () => {
    expect(buildSubscriptionConfirmTemplate({ ...args, logoUrl: LOGO_URL }).html).toContain(
      `src="${LOGO_URL}"`,
    );
    expect(buildSubscriptionConfirmTemplate(args).html).not.toMatch(/<img\b/);
    expect(buildSubscriptionConfirmTemplate({ ...args, appName: 'Other Shop' }).html).toContain(
      'Other Shop',
    );
  });

  it('puts the current year into the footer', () => {
    jest.useFakeTimers({ now: new Date('2031-05-01T12:00:00Z') });

    expect(buildSubscriptionConfirmTemplate(args).html).toContain('© 2031 Cartlify');
  });

  it.each([
    ['confirmation link is empty', { confirmUrl: '', declineUrl }],
    ['confirmation link is blank', { confirmUrl: '   ', declineUrl }],
    ['"this is not me" link is empty', { confirmUrl, declineUrl: '' }],
    ['"this is not me" link is blank', { confirmUrl, declineUrl: '  ' }],
  ])('refuses to build the mail when the %s', (_case, bad) => {
    expect(() => buildSubscriptionConfirmTemplate(bad)).toThrow();
  });

  // the dictionary of the language the subscription asked for (src/locales), English unless told
  describe('the language', () => {
    it.each([
      [
        'en',
        {
          heading: 'Confirm your subscription',
          confirm: 'Confirm the subscription',
          decline: 'This is not me, do not send anything more',
          days: '3 days',
        },
      ],
      [
        'uk',
        {
          heading: 'Підтвердьте підписку',
          confirm: 'Підтвердити підписку',
          decline: 'Це не я, більше не надсилати',
          days: '3 днів',
        },
      ],
      [
        'es',
        {
          heading: 'Confirma tu suscripción',
          confirm: 'Confirmar la suscripción',
          decline: 'No he sido yo, no enviar nada más',
          days: '3 días',
        },
      ],
    ])('writes in %s: the heading, both buttons and the days', (locale, words) => {
      const { html, text, subject } = buildSubscriptionConfirmTemplate({ ...args, locale });

      expect(subject).toContain(words.heading);
      expect(html).toContain(words.heading);
      expect(anchorTo(html, confirmUrl)).toContain(words.confirm);
      expect(anchorTo(html, declineUrl)).toBe(words.decline);
      expect(html).toContain(words.days);
      expect(text).toContain(words.days);
      expect(text).toContain(`${words.decline}:`);
    });

    it('writes in English by default', () => {
      const { html } = buildSubscriptionConfirmTemplate(args);

      expect(html).toContain('Confirm the subscription');
    });

    it('sets the language of the page, not only of the words', () => {
      expect(buildSubscriptionConfirmTemplate({ ...args, locale: 'uk' }).html).toContain(
        '<html lang="uk">',
      );
      expect(buildSubscriptionConfirmTemplate(args).html).toContain('<html lang="en">');
    });
  });
});
