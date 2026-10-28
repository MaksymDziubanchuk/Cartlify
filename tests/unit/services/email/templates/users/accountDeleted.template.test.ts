import { describe, expect, it } from '@jest/globals';

import {
  buildAccountDeletedTemplate,
  type AccountDeletedTemplateArgs,
} from '@services/email/templates/users/accountDeleted.template.js';

const mail = (overrides: Partial<AccountDeletedTemplateArgs> = {}) =>
  buildAccountDeletedTemplate({ deliveries: [], cancelled: [], currency: 'eur', ...overrides });

const lamp = { name: 'Desk lamp', quantity: 2 };
const notebook = { name: 'Notebook', quantity: 1 };

describe('buildAccountDeletedTemplate', () => {
  it('names the shop in the subject', () => {
    expect(mail().subject).toBe('Cartlify — Your account is deleted');
  });

  it('says the account is gone and lists no orders when there are none', () => {
    const { text, html } = mail();

    expect(text).toContain('Your Cartlify account is deleted.');
    expect(text).not.toContain('Order #');
    expect(text).not.toContain('will still be delivered');
    expect(text).not.toContain('cancelled');
    expect(html).not.toContain('Order #');
  });

  it('greets by the name when there is one', () => {
    expect(mail({ userName: 'Anna' }).text.startsWith('Hi Anna,')).toBe(true);
    expect(mail().text.startsWith('Your Cartlify account is deleted.')).toBe(true);
  });

  it('lists the paid and shipped orders that will still be delivered, with total and items', () => {
    const { text, html } = mail({
      deliveries: [
        { orderId: 3, status: 'paid', total: '51.00', items: [lamp, notebook] },
        { orderId: 4, status: 'shipped', total: 3, items: [notebook] },
      ],
    });

    expect(text).toContain('will still be delivered');
    expect(text).toContain('- Order #3, €51.00: paid, it will be shipped');
    expect(text).toContain('Desk lamp x 2, Notebook x 1');
    expect(text).toContain('- Order #4, €3.00: shipped, it is on its way');
    for (const part of ['Order #3', 'Order #4', '€51.00', 'Desk lamp x 2, Notebook x 1']) {
      expect(html).toContain(part);
    }
  });

  // a pickup is not sent: it waits for the customer at the shop
  it('tells a pickup as it is, prepared for a paid order and ready for a shipped one', () => {
    const { text, html } = mail({
      deliveries: [
        { orderId: 3, status: 'paid', total: 10, items: [lamp], pickup: true },
        { orderId: 4, status: 'shipped', total: 10, items: [lamp], pickup: true },
      ],
    });

    expect(text).toContain('- Order #3, €10.00: paid, it will be prepared for pickup at the shop');
    expect(text).toContain('- Order #4, €10.00: ready, it waits for you at the shop');
    expect(text).toContain('or kept for you to collect at the shop');
    expect(html).toContain('prepared for pickup at the shop');
    expect(html).toContain('or keep them for you to collect at the shop');
  });

  // only what stripe said goes in: an unknown payment is a condition, never a guess
  it.each([
    ['not_taken', 'cancelled, no payment was taken and none will be'],
    ['refunding', 'cancelled, your payment was received and is refunded in full'],
    ['unknown', 'cancelled; if you paid for it, the payment is refunded in full automatically'],
  ] as const)('tells a cancelled order whose payment is %s as it is', (payment, sentence) => {
    const { text, html } = mail({
      cancelled: [{ orderId: 9, total: '10.00', items: [lamp], payment }],
    });

    expect(text).toContain('waiting for payment and are cancelled');
    expect(text).toContain(`- Order #9, €10.00: ${sentence}`);
    expect(html).toContain(sentence);
  });

  it('shows both lists in one mail', () => {
    const { text } = mail({
      deliveries: [{ orderId: 3, status: 'paid', total: 10, items: [lamp] }],
      cancelled: [{ orderId: 9, total: 10, items: [lamp], payment: 'not_taken' }],
    });

    expect(text.indexOf('Order #3')).toBeLessThan(text.indexOf('Order #9'));
  });

  it('escapes what comes from the shop in the html and keeps the text as it is', () => {
    const { text, html } = mail({
      userName: '<b>Anna</b>',
      deliveries: [
        { orderId: 3, status: 'paid', total: 10, items: [{ name: 'Lamp & <shade>', quantity: 1 }] },
      ],
    });

    expect(html).toContain('Lamp &amp; &lt;shade&gt;');
    expect(html).not.toContain('<b>Anna</b>');
    expect(text).toContain('Lamp & <shade> x 1');
  });

  it('formats money in the currency of the shop', () => {
    const { text } = mail({
      currency: 'usd',
      deliveries: [{ orderId: 3, status: 'paid', total: '1234.5', items: [lamp] }],
    });

    expect(text).toContain('$1,234.50');
  });
});
