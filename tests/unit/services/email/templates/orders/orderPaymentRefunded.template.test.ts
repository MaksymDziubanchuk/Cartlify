import { describe, expect, it } from '@jest/globals';

import {
  buildOrderPaymentRefundedTemplate,
  type OrderPaymentRefundedTemplateArgs,
} from '@services/email/templates/orders/orderPaymentRefunded.template.js';

const orderUrl = 'https://shop.example.com/orders/42';

const refund = (
  overrides: Partial<OrderPaymentRefundedTemplateArgs> = {},
): OrderPaymentRefundedTemplateArgs => ({
  orderId: 42,
  orderUrl,
  amount: '51.00',
  currency: 'eur',
  reason: 'OUT_OF_STOCK',
  ...overrides,
});

describe('buildOrderPaymentRefundedTemplate', () => {
  it('names the shop and the order in the subject', () => {
    expect(buildOrderPaymentRefundedTemplate(refund()).subject).toBe(
      'Cartlify — We sent your payment for order #42 back',
    );
  });

  // the buyer paid after the reservation and the order could not take the money: the return page
  // said paid, the mail has to say it is not
  it('says the order is not paid and the money was sent back, in both versions', () => {
    const { text, html } = buildOrderPaymentRefundedTemplate(refund());

    expect(text).toContain('We sent your payment of €51.00 for order #42 back');
    expect(text).toContain('The order is not paid');
    expect(html).toContain('We sent your payment of €51.00 for order #42 back');
    expect(html).toContain('The order is not paid');
  });

  // the mail goes when the money is sent, not when the bank shows it: the bank may still send it
  // back, and the buyer is then told
  it('says the bank shows the money within a few days and promises a mail if the refund goes wrong', () => {
    const { text, html } = buildOrderPaymentRefundedTemplate(refund());

    for (const version of [text, html]) {
      expect(version).toContain('Your bank shows the money within a few days.');
      expect(version).toContain('If anything happens to this refund, we will write to you.');
    }
  });

  it('never calls the money returned or refunded: it was sent', () => {
    const { subject, text, html } = buildOrderPaymentRefundedTemplate(refund());

    for (const version of [subject, text, html]) {
      expect(version).not.toMatch(/refunded in full|is refunded|were returned|was returned/i);
    }
  });

  // the other payment paid the order: it goes out as it is, only this payment comes back
  it('says the order stays paid when another payment paid it', () => {
    const { text, html } = buildOrderPaymentRefundedTemplate(
      refund({ reason: 'ALREADY_PAID_OTHER_PAYMENT' }),
    );

    for (const version of [text, html]) {
      expect(version).toContain('The order stays paid with your other payment');
      expect(version).not.toContain('The order is not paid');
    }
  });

  it.each([
    ['OUT_OF_STOCK', 'some items of it were no longer in stock'],
    ['ALREADY_PAID_OTHER_PAYMENT', 'the order was paid with another payment already'],
    ['AMOUNT_MISMATCH', 'the order changed after the payment page was opened'],
    ['ORDER_NOT_PAYABLE', 'the order could not take a payment any more'],
    ['ORDER_NOT_FOUND', 'the order no longer exists'],
  ] as const)('tells why for %s', (reason, why) => {
    const { text, html } = buildOrderPaymentRefundedTemplate(refund({ reason }));

    expect(text).toContain(why);
    expect(html).toContain(why);
  });

  it('gives the amount in the currency it was paid in', () => {
    expect(buildOrderPaymentRefundedTemplate(refund({ currency: 'usd' })).text).toContain(
      'We sent your payment of $51.00',
    );
  });

  // the dictionary of the recipient's own language (src/locales), English unless told
  it('writes in the language given, English by default', () => {
    const uk = buildOrderPaymentRefundedTemplate(refund({ locale: 'uk' }));
    const es = buildOrderPaymentRefundedTemplate(refund({ locale: 'es' }));

    expect(uk.subject).toContain('Ми надіслали вашу оплату за замовлення #42 назад');
    expect(uk.text).toContain('Ми надіслали вам назад оплату');
    expect(uk.text).toContain('Банк покаже кошти протягом кількох днів.');
    expect(uk.text).toContain('Якщо з цим поверненням щось станеться, ми вам напишемо.');
    expect(es.subject).toContain('Te enviamos de vuelta el pago del pedido #42');
    expect(es.text).toContain('Te enviamos de vuelta tu pago de');
    expect(es.text).toContain('Tu banco mostrará el dinero en unos días.');
    expect(es.text).toContain('Si pasa algo con este reembolso, te escribiremos.');
  });

  it('puts the order link into the text and the html versions', () => {
    const { text, html } = buildOrderPaymentRefundedTemplate(refund());

    expect(text).toContain(orderUrl);
    expect(html).toContain(`href="${orderUrl}"`);
  });

  it('keeps the plain text version free of html', () => {
    expect(buildOrderPaymentRefundedTemplate(refund()).text).not.toMatch(/<[a-z!/]/i);
  });

  it('greets the user by name, or without one', () => {
    expect(buildOrderPaymentRefundedTemplate(refund({ userName: 'Anna' })).html).toContain(
      'Hi Anna,',
    );
    expect(buildOrderPaymentRefundedTemplate(refund({ userName: ' ' })).html).toContain('Hi,');
  });

  it('escapes the user name in the html', () => {
    expect(buildOrderPaymentRefundedTemplate(refund({ userName: '<b>x</b>' })).html).not.toContain(
      '<b>x</b>',
    );
  });

  it('refuses a mail without the order link', () => {
    expect(() => buildOrderPaymentRefundedTemplate(refund({ orderUrl: ' ' }))).toThrow(
      'ORDER_URL_REQUIRED',
    );
  });
});
