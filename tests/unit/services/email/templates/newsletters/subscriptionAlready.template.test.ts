import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { buildSubscriptionAlreadyTemplate } from '@services/email/templates/newsletters/subscriptionAlready.template.js';

import { resetShopSettings, setShopSettings } from '../../../../../helpers/shopSettings.js';

// the logo of the shop is shown by its address at Cloudinary: the mail carries no attachment
const LOGO_URL = 'https://res.cloudinary.com/cartlify-test/image/upload/v1/test/shop/logo/a.png';

const manageUrl = 'https://shop.test/newsletter/manage#token=abc123';
const args = { manageUrl };

afterEach(() => {
  jest.useRealTimers();
  resetShopSettings();
});

const anchorTo = (html: string, url: string): string => {
  const match = new RegExp(`<a href="${url.replaceAll('?', '\\?')}"[^>]*>([\\s\\S]*?)</a>`).exec(
    html,
  );
  return match ? match[1]!.replace(/\s+/g, ' ').trim() : '';
};

describe('buildSubscriptionAlreadyTemplate', () => {
  it('names the shop and the news in the subject', () => {
    const { subject } = buildSubscriptionAlreadyTemplate(args);

    expect(subject).toContain('Cartlify');
    expect(subject.toLowerCase()).toContain('already subscribed');
  });

  it('uses the given shop name instead of the default one', () => {
    const { subject, html, text } = buildSubscriptionAlreadyTemplate({
      ...args,
      appName: 'Other Shop',
    });

    expect(subject).toContain('Other Shop');
    expect(html).toContain('newsletter of Other Shop');
    expect(text).toContain('newsletter of Other Shop');
  });

  it('says this address is already subscribed to the newsletter of the shop', () => {
    const { html, text } = buildSubscriptionAlreadyTemplate(args);

    for (const part of [html, text]) {
      expect(part).toContain('This address is already subscribed to the newsletter of Cartlify.');
    }
  });

  it('has one button, "Manage the subscription", with the management link', () => {
    const { html, text } = buildSubscriptionAlreadyTemplate(args);

    expect(anchorTo(html, manageUrl)).toContain('Manage the subscription');
    expect(text).toMatch(/Manage the subscription:\s+https:\/\/shop\.test\/newsletter\/manage/);
  });

  it('asks nothing of the reader whose request this was not: do nothing', () => {
    const { html, text } = buildSubscriptionAlreadyTemplate(args);

    expect(html).toContain('If the request was not yours, do nothing.');
    expect(text).toContain('If the request was not yours, do nothing.');
  });

  // there is nothing to confirm in this mail, so no deadline and no way to refuse the address
  it('has no confirmation, no days of validity and no "not me" button', () => {
    const { html, text } = buildSubscriptionAlreadyTemplate(args);

    for (const part of [html, text]) {
      expect(part).not.toMatch(/valid for/i);
      expect(part).not.toMatch(/not me/i);
      expect(part).not.toMatch(/confirm/i);
    }
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
    expect(hrefs.every((href) => href === manageUrl || href!.startsWith('mailto:'))).toBe(true);
  });

  it('keeps the plain text version free of html', () => {
    const { text } = buildSubscriptionAlreadyTemplate({ ...args, logoUrl: LOGO_URL });

    expect(text).not.toMatch(/<[a-z!/]/i);
  });

  describe('the seller', () => {
    const SELLER = {
      sellerLegalName: 'Cartlify LLC',
      sellerAddress: null,
      sellerTaxId: null,
      sellerEmail: 'legal@cartlify.test',
      sellerPhone: null,
    };

    it('is named at the foot, in the html and in the text, once root has filled it in', () => {
      setShopSettings(SELLER);
      const { html, text } = buildSubscriptionAlreadyTemplate(args);

      expect(html).toContain('Seller: Cartlify LLC, legal@cartlify.test');
      expect(text).toContain('Seller: Cartlify LLC, legal@cartlify.test');
    });

    it('is left out while root has filled in none of it', () => {
      setShopSettings({
        sellerLegalName: null,
        sellerAddress: null,
        sellerTaxId: null,
        sellerEmail: null,
        sellerPhone: null,
      });
      const { html, text } = buildSubscriptionAlreadyTemplate(args);

      expect(html).not.toContain('Seller');
      expect(text).not.toContain('Seller');
    });
  });

  // the mail of "you are already subscribed" to a subscription that a spam mark paused would be a lie:
  // no mail of the newsletter goes to it. It says what happened and where to resume it
  describe('when the subscription is paused after a spam mark', () => {
    const paused = { ...args, paused: true };

    it('says it is paused and where to resume it, not that it is active', () => {
      const { subject, html, text } = buildSubscriptionAlreadyTemplate(paused);

      expect(subject).toContain('Cartlify');
      expect(subject.toLowerCase()).toContain('paused');
      for (const part of [subject, html, text]) {
        expect(part.toLowerCase()).not.toContain('already subscribed');
      }
      const body =
        'The subscription of this address to the newsletter of Cartlify is paused after a spam mark. Resume it on the page "Manage the subscription".';
      expect(text).toContain(body);
      // the html escapes the quotes
      expect(html).toContain(body.replaceAll('"', '&quot;'));
    });

    it('keeps the one button to the page of management and the advice for a stranger', () => {
      const { html, text } = buildSubscriptionAlreadyTemplate(paused);

      expect(anchorTo(html, manageUrl)).toContain('Manage the subscription');
      expect(text).toMatch(/Manage the subscription:\s+https:\/\/shop\.test\/newsletter\/manage/);
      expect(html).toContain('If the request was not yours, do nothing.');
      const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
      expect(hrefs.every((href) => href === manageUrl || href!.startsWith('mailto:'))).toBe(true);
    });

    it.each([
      [
        'uk',
        'Підписку призупинено',
        'Підписку цієї адреси на розсилку Cartlify призупинено після позначки «спам». Відновіть її на сторінці «Керування підпискою».',
      ],
      [
        'es',
        'Tu suscripción está en pausa',
        'La suscripción de esta dirección al boletín de Cartlify está en pausa tras una marca de spam. Reanúdala en la página «Gestionar la suscripción».',
      ],
      [
        'en',
        'Your subscription is paused',
        'The subscription of this address to the newsletter of Cartlify is paused after a spam mark. Resume it on the page "Manage the subscription".',
      ],
    ])('writes in %s', (locale, heading, body) => {
      const { subject, html, text } = buildSubscriptionAlreadyTemplate({ ...paused, locale });

      expect(subject).toContain(heading);
      expect(html).toContain(heading);
      expect(html).toContain(body.replaceAll('"', '&quot;'));
      expect(text).toContain(body);
    });

    it('is the usual mail for a subscription that is not paused', () => {
      expect(buildSubscriptionAlreadyTemplate({ ...args, paused: false })).toEqual(
        buildSubscriptionAlreadyTemplate(args),
      );
    });
  });

  it('escapes the shop name and the link', () => {
    const { html } = buildSubscriptionAlreadyTemplate({
      manageUrl: 'https://shop.test/m?a=1&b="><script>alert(1)</script>',
      appName: '<b>Shop</b>',
    });

    expect(html).not.toContain('"><script>');
    expect(html).toContain('a=1&amp;b=');
    expect(html).not.toContain('<b>Shop</b>');
  });

  it('shows the logo by its address when the shop has one, the shop name otherwise', () => {
    expect(buildSubscriptionAlreadyTemplate({ ...args, logoUrl: LOGO_URL }).html).toContain(
      `src="${LOGO_URL}"`,
    );
    expect(buildSubscriptionAlreadyTemplate(args).html).not.toMatch(/<img\b/);
  });

  it('puts the current year into the footer', () => {
    jest.useFakeTimers({ now: new Date('2031-05-01T12:00:00Z') });

    expect(buildSubscriptionAlreadyTemplate(args).html).toContain('© 2031 Cartlify');
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
  ])('refuses to build the mail when the management link is %s', (_case, url) => {
    expect(() => buildSubscriptionAlreadyTemplate({ manageUrl: url })).toThrow();
  });

  // the language of the subscription that exists, not of the new request: the caller passes it
  describe('the language', () => {
    it.each([
      [
        'en',
        {
          heading: 'You are already subscribed',
          button: 'Manage the subscription',
          ignore: 'If the request was not yours, do nothing.',
        },
      ],
      [
        'uk',
        {
          heading: 'Ви вже підписані',
          button: 'Керування підпискою',
          ignore: 'Якщо запит робили не ви, нічого не робіть.',
        },
      ],
      [
        'es',
        {
          heading: 'La suscripción ya está activa',
          button: 'Gestionar la suscripción',
          ignore: 'Si la solicitud no fue tuya, no hagas nada.',
        },
      ],
    ])('writes in %s: the heading, the button and the advice', (locale, words) => {
      const { html, text, subject } = buildSubscriptionAlreadyTemplate({ ...args, locale });

      expect(subject).toContain(words.heading);
      expect(html).toContain(words.heading);
      expect(anchorTo(html, manageUrl)).toContain(words.button);
      expect(text).toContain(`${words.button}:`);
      expect(html).toContain(words.ignore);
      expect(text).toContain(words.ignore);
    });

    it('writes in English by default', () => {
      expect(buildSubscriptionAlreadyTemplate(args).html).toContain('You are already subscribed');
    });

    it('sets the language of the page, not only of the words', () => {
      expect(buildSubscriptionAlreadyTemplate({ ...args, locale: 'es' }).html).toContain(
        '<html lang="es">',
      );
      expect(buildSubscriptionAlreadyTemplate(args).html).toContain('<html lang="en">');
    });
  });
});
