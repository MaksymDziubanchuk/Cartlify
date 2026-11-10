import { describe, expect, it } from '@jest/globals';

import {
  buildOrderPaymentRefundOutsideTemplate,
  type OrderPaymentRefundOutsideTemplateArgs,
} from '@services/email/templates/orders/orderPaymentRefundOutside.template.js';

const orderUrl = 'https://shop.example.com/orders/42';
const supportEmail = 'support@shop.example.com';

const sent = (
  overrides: Partial<OrderPaymentRefundOutsideTemplateArgs> = {},
): OrderPaymentRefundOutsideTemplateArgs => ({
  orderId: 42,
  orderUrl,
  amount: '51.00',
  currency: 'eur',
  method: 'bank_transfer',
  sentOn: new Date('2026-11-02T10:05:00Z'),
  supportEmail,
  ...overrides,
});

// the mail of a payment the order could not take, whose refund failed, once root sent the money
// another way: how much, by which way and on which day; the note of root is for the shop

describe('buildOrderPaymentRefundOutsideTemplate', () => {
  it('names the shop and the order in the subject', () => {
    expect(buildOrderPaymentRefundOutsideTemplate(sent()).subject).toBe(
      'Cartlify — We sent you money for order #42',
    );
  });

  it('says how much, by which way and on which day, in both versions', () => {
    const { text, html } = buildOrderPaymentRefundOutsideTemplate(sent());

    for (const version of [text, html]) {
      expect(version).toContain('We sent you €51.00 for your order #42.');
      expect(version).toContain('We sent it by a bank transfer on 2 November 2026.');
    }
  });

  it.each([
    ['cash', 'cash'],
    ['other', 'another way'],
  ])('names the way %s as %s', (method, words) => {
    expect(buildOrderPaymentRefundOutsideTemplate(sent({ method })).text).toContain(
      `We sent it by ${words} on 2 November 2026.`,
    );
  });

  // the day is the day of the calendar of the shop, named with its time zone
  it('tells the day by the time zone of the shop', () => {
    const late = sent({ sentOn: new Date('2026-11-02T23:30:00Z'), timeZone: 'Europe/Madrid' });

    expect(buildOrderPaymentRefundOutsideTemplate(late).text).toContain('on 3 November 2026');
  });

  it('is not a promise of a bank day: the money is sent already', () => {
    const { text } = buildOrderPaymentRefundOutsideTemplate(sent());

    expect(text).not.toContain('Your bank shows');
    expect(text).not.toContain('If anything happens');
  });

  it('gives the amount in the currency it was paid in', () => {
    expect(buildOrderPaymentRefundOutsideTemplate(sent({ currency: 'usd' })).text).toContain(
      '$51.00',
    );
  });

  it('links the order, says where to write and keeps the text free of html', () => {
    const { text, html } = buildOrderPaymentRefundOutsideTemplate(sent());

    expect(text).toContain(orderUrl);
    expect(html).toContain(`href="${orderUrl}"`);
    expect(text).toContain(`Questions? Write to us in the chat on our site or to ${supportEmail}.`);
    expect(text).not.toMatch(/<[a-z!/]/i);
  });

  it('greets the user by name, or without one, and escapes the name in the html', () => {
    expect(buildOrderPaymentRefundOutsideTemplate(sent({ userName: 'Anna' })).text).toContain(
      'Hi Anna,',
    );
    expect(buildOrderPaymentRefundOutsideTemplate(sent()).text).toContain('Hi,');
    expect(
      buildOrderPaymentRefundOutsideTemplate(sent({ userName: '<b>x</b>' })).html,
    ).not.toContain('<b>x</b>');
  });

  it('refuses a mail without the order link', () => {
    expect(() => buildOrderPaymentRefundOutsideTemplate(sent({ orderUrl: ' ' }))).toThrow(
      'ORDER_URL_REQUIRED',
    );
  });

  it('shows the logo by its address and falls back to the name of the shop', () => {
    const logo = 'https://res.cloudinary.com/demo/logo.png';

    expect(buildOrderPaymentRefundOutsideTemplate(sent({ logoUrl: logo })).html).toContain(
      `src="${logo}"`,
    );
    expect(buildOrderPaymentRefundOutsideTemplate(sent({ logoUrl: null })).html).toContain(
      'Cartlify',
    );
  });

  // the dictionary of the recipient's own language (src/locales), English unless told
  it('writes in the language given, English by default', () => {
    const uk = buildOrderPaymentRefundOutsideTemplate(sent({ locale: 'uk' }));
    const es = buildOrderPaymentRefundOutsideTemplate(sent({ locale: 'es' }));

    expect(uk.subject).toContain('Ми надіслали вам кошти за замовлення #42');
    expect(uk.text).toContain('Ми надіслали вам 51,00');
    expect(uk.text).toContain('Ми надіслали кошти банківським переказом 2 листопада 2026');
    expect(es.subject).toContain('Te enviamos dinero del pedido #42');
    expect(es.text).toContain('Te enviamos 51,00');
    expect(es.text).toContain('Lo enviamos por transferencia bancaria el 2 de noviembre de 2026');
  });
});
