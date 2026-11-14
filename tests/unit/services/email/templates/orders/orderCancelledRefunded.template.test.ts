import { describe, expect, it } from '@jest/globals';

import {
  buildOrderCancelledRefundedTemplate,
  type OrderCancelledRefundedTemplateArgs,
} from '@services/email/templates/orders/orderCancelledRefunded.template.js';

// The mail of an order the shop cancelled before it was sent because all of its payment went back to
// the buyer by hand in the dashboard of the payment provider (situation B of the refunds made by
// hand): the order is cancelled and the money is sent, nothing will be sent

const orderUrl = 'https://shop.example.com/orders/42';

const cancelled = (
  overrides: Partial<OrderCancelledRefundedTemplateArgs> = {},
): OrderCancelledRefundedTemplateArgs => ({
  orderId: 42,
  orderUrl,
  amount: '20.00',
  currency: 'eur',
  ...overrides,
});

describe('buildOrderCancelledRefundedTemplate', () => {
  it('names the shop and the order in the subject', () => {
    expect(buildOrderCancelledRefundedTemplate(cancelled()).subject).toBe(
      'Cartlify — Order #42 is cancelled and your money is sent back',
    );
  });

  it('says the order is cancelled, nothing is sent and the money went back, in both versions', () => {
    const { text, html } = buildOrderCancelledRefundedTemplate(cancelled());

    for (const version of [text, html]) {
      expect(version).toContain('We cancelled order #42 before sending it.');
      expect(version).toContain('We sent your payment of €20.00 back to the way you paid.');
      expect(version).toContain('Your bank shows the money within a few days.');
      expect(version).toContain('If you still want the items, you can place a new order.');
    }
  });

  it('gives the amount in the currency it was paid in', () => {
    expect(buildOrderCancelledRefundedTemplate(cancelled({ currency: 'usd' })).text).toContain(
      'payment of $20.00',
    );
  });

  it('writes in the language given, English by default', () => {
    const uk = buildOrderCancelledRefundedTemplate(cancelled({ locale: 'uk' }));
    const es = buildOrderCancelledRefundedTemplate(cancelled({ locale: 'es' }));

    expect(uk.subject).toContain('Замовлення #42 скасовано, кошти надіслано назад');
    expect(uk.text).toContain('Ми скасували замовлення #42 до відправки.');
    expect(uk.text).toContain('Банк покаже кошти протягом кількох днів.');
    expect(es.subject).toContain('El pedido #42 está cancelado y tu dinero va de vuelta');
    expect(es.text).toContain('Cancelamos el pedido #42 antes de enviarlo.');
    expect(es.text).toContain('Tu banco mostrará el dinero en unos días.');
  });

  it('puts the order link and the address of the shop into both versions', () => {
    const { text, html } = buildOrderCancelledRefundedTemplate(
      cancelled({ supportEmail: 'support@shop.example.com' }),
    );

    expect(text).toContain(orderUrl);
    expect(html).toContain(`href="${orderUrl}"`);
    expect(text).toContain('support@shop.example.com');
    expect(html).toContain('mailto:support@shop.example.com');
  });

  it('keeps the plain text version free of html', () => {
    expect(buildOrderCancelledRefundedTemplate(cancelled()).text).not.toMatch(/<[a-z!/]/i);
  });

  it('greets the user by name, escaped, or without one', () => {
    expect(buildOrderCancelledRefundedTemplate(cancelled({ userName: 'Anna' })).html).toContain(
      'Hi Anna,',
    );
    expect(buildOrderCancelledRefundedTemplate(cancelled({ userName: ' ' })).html).toContain('Hi,');
    expect(
      buildOrderCancelledRefundedTemplate(cancelled({ userName: '<b>x</b>' })).html,
    ).not.toContain('<b>x</b>');
  });

  it('refuses a mail without the order link', () => {
    expect(() => buildOrderCancelledRefundedTemplate(cancelled({ orderUrl: ' ' }))).toThrow(
      'ORDER_URL_REQUIRED',
    );
  });
});
