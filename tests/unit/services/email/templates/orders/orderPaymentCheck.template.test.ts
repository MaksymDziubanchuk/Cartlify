import { describe, expect, it } from '@jest/globals';

import {
  buildOrderPaymentCheckTemplate,
  type OrderPaymentCheckTemplateArgs,
} from '@services/email/templates/orders/orderPaymentCheck.template.js';

// The mail of a paid order the shop holds before sending it while the payment is checked: an early
// warning of the network of the card, or a review of the payment provider. The
// warning may be wrong, so the mail never speaks of fraud: the payment came, it is checked once
// more, the shop writes when the order is sent or the money goes back

const orderUrl = 'https://shop.example.com/orders/42';

const check = (
  overrides: Partial<OrderPaymentCheckTemplateArgs> = {},
): OrderPaymentCheckTemplateArgs => ({ orderId: 42, orderUrl, ...overrides });

describe('buildOrderPaymentCheckTemplate', () => {
  it('names the shop and the order in the subject', () => {
    expect(buildOrderPaymentCheckTemplate(check()).subject).toBe(
      'Cartlify — We are checking the payment for order #42',
    );
  });

  it('says the payment came, is checked before the order is sent, and what comes next', () => {
    const { text, html } = buildOrderPaymentCheckTemplate(check());

    for (const version of [text, html]) {
      expect(version).toContain('We received your payment for order #42.');
      expect(version).toContain('Before we send the order, we check the payment once more.');
      expect(version).toContain(
        'We will write to you as soon as we send the order or give the money back.',
      );
    }
  });

  it('never speaks of fraud, in any language', () => {
    for (const locale of ['en', 'uk', 'es']) {
      const { subject, text, html } = buildOrderPaymentCheckTemplate(check({ locale }));
      for (const version of [subject, text, html]) {
        expect(version).not.toMatch(/fraud|шахрай|fraude/i);
      }
    }
  });

  it('writes in the language given, English by default', () => {
    const uk = buildOrderPaymentCheckTemplate(check({ locale: 'uk' }));
    const es = buildOrderPaymentCheckTemplate(check({ locale: 'es' }));

    expect(uk.subject).toContain('Ми перевіряємо оплату замовлення #42');
    expect(uk.text).toContain('Ми отримали вашу оплату замовлення #42.');
    expect(es.subject).toContain('Estamos comprobando el pago del pedido #42');
    expect(es.text).toContain('Recibimos tu pago del pedido #42.');
  });

  it('puts the order link into both versions and keeps the text free of html', () => {
    const { text, html } = buildOrderPaymentCheckTemplate(check());

    expect(text).toContain(orderUrl);
    expect(html).toContain(`href="${orderUrl}"`);
    expect(text).not.toMatch(/<[a-z!/]/i);
  });

  it('greets the user by name, escaped', () => {
    expect(buildOrderPaymentCheckTemplate(check({ userName: 'Anna' })).html).toContain('Hi Anna,');
    expect(buildOrderPaymentCheckTemplate(check({ userName: '<b>x</b>' })).html).not.toContain(
      '<b>x</b>',
    );
  });

  it('refuses a mail without the order link', () => {
    expect(() => buildOrderPaymentCheckTemplate(check({ orderUrl: ' ' }))).toThrow(
      'ORDER_URL_REQUIRED',
    );
  });
});
