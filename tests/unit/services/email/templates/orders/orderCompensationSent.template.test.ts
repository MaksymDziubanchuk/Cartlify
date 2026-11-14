import { describe, expect, it } from '@jest/globals';

import {
  buildOrderCompensationSentTemplate,
  type OrderCompensationSentTemplateArgs,
} from '@services/email/templates/orders/orderCompensationSent.template.js';

const orderUrl = 'https://shop.example.com/orders/42';
const supportEmail = 'support@shop.example.com';

const sent = (
  over: Partial<OrderCompensationSentTemplateArgs> = {},
): OrderCompensationSentTemplateArgs => ({
  orderId: 42,
  orderUrl,
  amount: '5.00',
  currency: 'eur',
  supportEmail,
  ...over,
});

// the mail of a compensation root gave by the button of the app, once the provider sent it
describe('buildOrderCompensationSentTemplate', () => {
  it('names the shop and the order in the subject', () => {
    expect(buildOrderCompensationSentTemplate(sent()).subject).toBe(
      'Cartlify — We sent you a compensation for order #42',
    );
  });

  it('says how much and that it goes the way the buyer paid, in both versions', () => {
    const { text, html } = buildOrderCompensationSentTemplate(sent());

    for (const version of [text, html]) {
      expect(version).toContain('We sent you €5.00 as a compensation for your order #42.');
      expect(version).toContain('It goes back the way you paid.');
      expect(version).toContain(orderUrl);
    }
  });

  it('greets by name, says where to write, and writes in the language given', () => {
    const named = buildOrderCompensationSentTemplate(sent({ userName: 'Anna' }));
    const uk = buildOrderCompensationSentTemplate(sent({ locale: 'uk' }));
    const es = buildOrderCompensationSentTemplate(sent({ locale: 'es' }));

    expect(named.text).toContain('Anna');
    expect(named.text).toContain(supportEmail);
    expect(uk.subject).toContain('компенсацію');
    expect(es.subject).toContain('compensación');
  });

  it('refuses no order link', () => {
    expect(() => buildOrderCompensationSentTemplate(sent({ orderUrl: ' ' }))).toThrow(
      'ORDER_URL_REQUIRED',
    );
  });
});
