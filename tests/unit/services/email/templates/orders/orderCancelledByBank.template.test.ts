import { describe, expect, it } from '@jest/globals';

import {
  buildOrderCancelledByBankTemplate,
  type OrderCancelledByBankTemplateArgs,
} from '@services/email/templates/orders/orderCancelledByBank.template.js';

// The mail of an order the shop cancelled before it was sent because the bank decided a dispute of
// its payment for the buyer (a dispute lost on an order not sent): the bank gave
// the buyer back X, the shop sent the rest, Y (none when the bank gave back all of it)

const orderUrl = 'https://shop.example.com/orders/42';

const cancelled = (
  overrides: Partial<OrderCancelledByBankTemplateArgs> = {},
): OrderCancelledByBankTemplateArgs => ({
  orderId: 42,
  orderUrl,
  bankAmount: '15.00',
  sentAmount: '5.00',
  currency: 'eur',
  ...overrides,
});

describe('buildOrderCancelledByBankTemplate', () => {
  it('names the shop and the order in the subject', () => {
    expect(buildOrderCancelledByBankTemplate(cancelled()).subject).toBe(
      'Cartlify — Order #42 is cancelled after the decision of your bank',
    );
  });

  it('says what the bank gave back, that the order is cancelled and what the shop sent, in both versions', () => {
    const { text, html } = buildOrderCancelledByBankTemplate(cancelled());

    for (const version of [text, html]) {
      expect(version).toContain(
        'Your bank decided the dispute about your payment for order #42 for you and gave you back €15.00.',
      );
      expect(version).toContain('We cancelled the order, which had not been sent yet.');
      expect(version).toContain(
        'We sent you the rest of your payment, €5.00, to the way you paid.',
      );
      expect(version).toContain('If you still want the items, you can place a new order.');
    }
  });

  // the bank gave back all of the payment: the shop sent nothing more
  it('says nothing of money sent when the bank gave back all of it', () => {
    const { text, html } = buildOrderCancelledByBankTemplate(
      cancelled({ bankAmount: '20.00', sentAmount: 0 }),
    );

    for (const version of [text, html]) {
      expect(version).toContain('gave you back €20.00.');
      expect(version).not.toContain('We sent you the rest');
    }
  });

  it('writes in the language given, English by default', () => {
    const uk = buildOrderCancelledByBankTemplate(cancelled({ locale: 'uk' }));
    const es = buildOrderCancelledByBankTemplate(cancelled({ locale: 'es' }));

    expect(uk.subject).toContain('Замовлення #42 скасовано після рішення вашого банку');
    expect(uk.text).toContain('Ми скасували замовлення, його ще не відправили.');
    expect(es.subject).toContain('El pedido #42 está cancelado tras la decisión de tu banco');
    expect(es.text).toContain('Cancelamos el pedido, que aún no se había enviado.');
  });

  it('puts the order link into both versions and keeps the text free of html', () => {
    const { text, html } = buildOrderCancelledByBankTemplate(cancelled());

    expect(text).toContain(orderUrl);
    expect(html).toContain(`href="${orderUrl}"`);
    expect(text).not.toMatch(/<[a-z!/]/i);
  });

  it('greets the user by name, escaped', () => {
    expect(buildOrderCancelledByBankTemplate(cancelled({ userName: 'Anna' })).html).toContain(
      'Hi Anna,',
    );
    expect(
      buildOrderCancelledByBankTemplate(cancelled({ userName: '<b>x</b>' })).html,
    ).not.toContain('<b>x</b>');
  });

  it('refuses a mail without the order link', () => {
    expect(() => buildOrderCancelledByBankTemplate(cancelled({ orderUrl: '' }))).toThrow(
      'ORDER_URL_REQUIRED',
    );
  });
});
