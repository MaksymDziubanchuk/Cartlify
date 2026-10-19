import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  buildOrderPaidTemplate,
  type OrderPaidTemplateArgs,
} from '@services/email/templates/orders/orderPaid.template.js';

const orderUrl = 'https://shop.example.com/orders/42';

const order = (overrides: Partial<OrderPaidTemplateArgs> = {}): OrderPaidTemplateArgs => ({
  orderId: 42,
  orderUrl,
  items: [
    { name: 'Desk lamp', quantity: 2, unitPrice: '25.50', totalPrice: '51.00' },
    { name: 'Notebook', quantity: 1, unitPrice: 3, totalPrice: 3 },
  ],
  total: '54.00',
  currency: 'eur',
  paidAt: new Date('2026-10-17T18:05:00Z'),
  ...overrides,
});

afterEach(() => {
  jest.useRealTimers();
});

describe('buildOrderPaidTemplate', () => {
  it('names the shop and the order in the subject', () => {
    const { subject } = buildOrderPaidTemplate(order());

    expect(subject).toBe('Cartlify — Order #42 is paid');
  });

  it('lists every item with its quantity and prices in both versions', () => {
    const { text, html } = buildOrderPaidTemplate(order());

    expect(text).toContain('- Desk lamp x 2 = €51.00');
    expect(text).toContain('- Notebook x 1 = €3.00');
    for (const part of ['Desk lamp', '€25.50', '€51.00', 'Notebook', '€3.00']) {
      expect(html).toContain(part);
    }
  });

  it('gives the total in the currency checkout charges in', () => {
    expect(buildOrderPaidTemplate(order()).text).toContain('Total: €54.00');
    expect(buildOrderPaidTemplate(order({ currency: 'usd' })).text).toContain('Total: $54.00');
  });

  it('says when the order was paid, in utc', () => {
    const { text, html } = buildOrderPaidTemplate(order());

    expect(text).toContain('Paid on 17 October 2026 at 18:05 UTC.');
    expect(html).toContain('Paid on 17 October 2026 at 18:05 UTC');
  });

  it('puts the order link into the text and the html versions', () => {
    const { text, html } = buildOrderPaidTemplate(order());

    expect(text).toContain(orderUrl);
    expect(html).toContain(`href="${orderUrl}"`);
  });

  it('keeps the plain text version free of html', () => {
    expect(buildOrderPaidTemplate(order()).text).not.toMatch(/<[a-z!/]/i);
  });

  it('shows the shipping address only when the order has one', () => {
    const withAddress = buildOrderPaidTemplate(order({ shippingAddress: 'Main st 1, Kyiv' }));
    const without = buildOrderPaidTemplate(order({ shippingAddress: null }));

    expect(withAddress.text).toContain('Shipping to: Main st 1, Kyiv');
    expect(withAddress.html).toContain('Main st 1, Kyiv');
    expect(without.text).not.toMatch(/shipping to/i);
    expect(without.html).not.toMatch(/shipping to/i);
  });

  it('names the recipient with the phone, and leaves the line out without them', () => {
    const withRecipient = buildOrderPaidTemplate(
      order({ recipientName: 'Anna Koval', recipientPhone: '+380501234567' }),
    );
    const without = buildOrderPaidTemplate(order({ recipientName: '', recipientPhone: null }));

    expect(withRecipient.text).toContain('Recipient: Anna Koval, +380501234567');
    expect(withRecipient.html).toContain('Anna Koval, +380501234567');
    expect(without.text).not.toMatch(/recipient/i);
    expect(without.html).not.toMatch(/recipient/i);
  });

  it('greets the user by name, or without one', () => {
    expect(buildOrderPaidTemplate(order({ userName: 'Anna' })).html).toContain('Hi Anna,');
    expect(buildOrderPaidTemplate(order({ userName: ' ' })).html).toContain('Hi,');
  });

  // the names come from the catalog and the address from the buyer
  it('escapes product names, the address and the user name in the html', () => {
    const { html } = buildOrderPaidTemplate(
      order({
        items: [{ name: '<script>x</script>', quantity: 1, unitPrice: 1, totalPrice: 1 }],
        shippingAddress: '<img src=x onerror=alert(1)>',
        recipientName: '<i>Koval</i>',
        userName: '<b>Anna</b>',
      }),
    );

    expect(html).not.toContain('<script>x</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<i>Koval</i>');
    expect(html).not.toContain('<b>Anna</b>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('takes a product name with braces as it is', () => {
    const { text } = buildOrderPaidTemplate(
      order({ items: [{ name: 'Mug {{orderId}}', quantity: 1, unitPrice: 5, totalPrice: 5 }] }),
    );

    expect(text).toContain('- Mug {{orderId}} x 1 = €5.00');
  });

  it('shows the attached logo when a content id is given, the shop name otherwise', () => {
    expect(buildOrderPaidTemplate(order({ logoCid: 'cartlify-logo' })).html).toContain(
      'src="cid:cartlify-logo"',
    );
    expect(buildOrderPaidTemplate(order()).html).not.toContain('cid:');
  });

  it('puts the current year into the footer', () => {
    jest.useFakeTimers({ now: new Date('2031-05-01T00:00:00Z') });

    expect(buildOrderPaidTemplate(order()).html).toContain('© 2031 Cartlify');
  });

  it.each([
    ['without the order link', { orderUrl: ' ' }, 'ORDER_URL_REQUIRED'],
    ['without items', { items: [] }, 'ORDER_ITEMS_REQUIRED'],
  ])('refuses to build a mail %s', (_case, overrides, message) => {
    expect(() => buildOrderPaidTemplate(order(overrides))).toThrow(message);
  });
});
