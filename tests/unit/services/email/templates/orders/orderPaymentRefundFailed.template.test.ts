import { describe, expect, it } from '@jest/globals';

import {
  buildOrderPaymentRefundFailedTemplate,
  type OrderPaymentRefundFailedTemplateArgs,
} from '@services/email/templates/orders/orderPaymentRefundFailed.template.js';

const orderUrl = 'https://shop.example.com/orders/42';
const supportEmail = 'support@shop.example.com';

const failed = (
  overrides: Partial<OrderPaymentRefundFailedTemplateArgs> = {},
): OrderPaymentRefundFailedTemplateArgs => ({
  orderId: 42,
  orderUrl,
  amount: '51.00',
  currency: 'eur',
  failure: 'card_unavailable',
  supportEmail,
  ...overrides,
});

// the mail of a payment the order could not take, whose refund did not go through: the buyer paid
// and has neither the order nor the money. It says so, why in words, and that the shop writes about
// another way; the words of the payment provider are for the shop

describe('buildOrderPaymentRefundFailedTemplate', () => {
  it('names the shop and the order in the subject', () => {
    expect(buildOrderPaymentRefundFailedTemplate(failed()).subject).toBe(
      'Cartlify — We could not send your payment back for order #42',
    );
  });

  it('says the payment could not be sent back to a card that can no longer take money', () => {
    const { text, html } = buildOrderPaymentRefundFailedTemplate(failed());

    for (const version of [text, html]) {
      expect(version).toContain(
        'We could not send your payment of €51.00 for order #42 back to the card it was paid with',
      );
      expect(version).toContain('the card can no longer take money');
    }
  });

  // the cases of the provider that are not about the card of the buyer are told in general words
  it.each(['shop_balance', 'disputed', 'unknown'] as const)(
    'gives a general reason for %s, not the card',
    (failure) => {
      const { text, html } = buildOrderPaymentRefundFailedTemplate(failed({ failure }));

      for (const version of [text, html]) {
        expect(version).toContain('We could not send your payment of €51.00 for order #42 back');
        expect(version).not.toContain('the card can no longer take money');
      }
    },
  );

  it('promises to write about another way and offers to write to the shop', () => {
    const { text, html } = buildOrderPaymentRefundFailedTemplate(failed());

    for (const version of [text, html]) {
      expect(version).toContain('We will contact you about another way to send it.');
    }
    expect(text).toContain(`Questions? Write to us in the chat on our site or to ${supportEmail}.`);
  });

  // the money was sent, the buyer was told, and the bank of the card sent it back
  it('says the bank sent the money back when it had been sent', () => {
    const sentBack = 'The money we sent earlier was sent back to us by your bank';

    expect(buildOrderPaymentRefundFailedTemplate(failed({ sentBack: true })).text).toContain(
      sentBack,
    );
    expect(buildOrderPaymentRefundFailedTemplate(failed({ sentBack: true })).html).toContain(
      sentBack,
    );
    expect(buildOrderPaymentRefundFailedTemplate(failed()).text).not.toContain(sentBack);
  });

  it('gives the amount in the currency it was paid in', () => {
    expect(buildOrderPaymentRefundFailedTemplate(failed({ currency: 'usd' })).text).toContain(
      '$51.00',
    );
  });

  it('links the order in both versions and keeps the text free of html', () => {
    const { text, html } = buildOrderPaymentRefundFailedTemplate(failed());

    expect(text).toContain(orderUrl);
    expect(html).toContain(`href="${orderUrl}"`);
    expect(text).not.toMatch(/<[a-z!/]/i);
  });

  it('never quotes the words of the provider', () => {
    const { text, html } = buildOrderPaymentRefundFailedTemplate(failed());

    for (const version of [text, html]) {
      expect(version).not.toContain('expired_or_canceled_card');
      expect(version).not.toContain('lost_or_stolen_card');
    }
  });

  it('greets the user by name, or without one, and escapes the name in the html', () => {
    expect(buildOrderPaymentRefundFailedTemplate(failed({ userName: 'Anna' })).text).toContain(
      'Hi Anna,',
    );
    expect(buildOrderPaymentRefundFailedTemplate(failed()).text).toContain('Hi,');
    expect(
      buildOrderPaymentRefundFailedTemplate(failed({ userName: '<b>x</b>' })).html,
    ).not.toContain('<b>x</b>');
  });

  it('refuses a mail without the order link', () => {
    expect(() => buildOrderPaymentRefundFailedTemplate(failed({ orderUrl: ' ' }))).toThrow(
      'ORDER_URL_REQUIRED',
    );
  });

  it('shows the logo by its address and falls back to the name of the shop', () => {
    const logo = 'https://res.cloudinary.com/demo/logo.png';

    expect(buildOrderPaymentRefundFailedTemplate(failed({ logoUrl: logo })).html).toContain(
      `src="${logo}"`,
    );
    expect(buildOrderPaymentRefundFailedTemplate(failed({ logoUrl: null })).html).toContain(
      'Cartlify',
    );
  });

  // the dictionary of the recipient's own language (src/locales), English unless told
  it('writes in the language given, English by default', () => {
    const uk = buildOrderPaymentRefundFailedTemplate(failed({ locale: 'uk', sentBack: true }));
    const es = buildOrderPaymentRefundFailedTemplate(failed({ locale: 'es', sentBack: true }));

    expect(uk.subject).toContain('Ми не змогли надіслати вашу оплату назад за замовлення #42');
    expect(uk.text).toContain('картка більше не приймає кошти');
    expect(uk.text).toContain('банк надіслав нам назад');
    expect(uk.text).toContain('Ми напишемо вам про інший спосіб');
    expect(es.subject).toContain('No pudimos enviarte de vuelta el pago del pedido #42');
    expect(es.text).toContain('la tarjeta ya no acepta pagos');
    expect(es.text).toContain('nos lo envió de vuelta tu banco');
    expect(es.text).toContain('Te contactaremos sobre otra forma');
  });
});
