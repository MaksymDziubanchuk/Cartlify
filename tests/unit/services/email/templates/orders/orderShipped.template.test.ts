import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  buildOrderShippedTemplate,
  type OrderShippedTemplateArgs,
} from '@services/email/templates/orders/orderShipped.template.js';

const orderUrl = 'https://shop.example.com/orders/42';

const order = (overrides: Partial<OrderShippedTemplateArgs> = {}): OrderShippedTemplateArgs => ({
  orderId: 42,
  orderUrl,
  items: [
    { name: 'Desk lamp', quantity: 2, totalPrice: '51.00' },
    { name: 'Notebook', quantity: 1, totalPrice: 3 },
  ],
  total: '54.00',
  currency: 'eur',
  ...overrides,
});

afterEach(() => {
  jest.useRealTimers();
});

describe('buildOrderShippedTemplate', () => {
  it.each([
    ['a price the buyer paid', 4.99, 'Delivery: €4.99'],
    ['a free delivery', 0, 'Delivery: free'],
  ])(
    'shows the delivery line of %s above the total in both versions',
    (_name, deliveryPrice, line) => {
      const { text, html } = buildOrderShippedTemplate(order({ deliveryPrice }));

      expect(text).toContain(line);
      expect(text.indexOf(line)).toBeLessThan(text.indexOf('Total:'));
      expect(html).toContain(line.replace('Delivery: ', ''));
    },
  );

  it('leaves the delivery line out for a pickup, which has no price', () => {
    const { text, html } = buildOrderShippedTemplate(order({ deliveryPrice: null }));

    expect(text).not.toContain('Delivery:');
    expect(html).not.toContain('>Delivery<');
  });

  it('names the shop and the order in the subject', () => {
    const { subject } = buildOrderShippedTemplate(order());

    expect(subject).toBe('Cartlify — Order #42 is shipped');
  });

  it('says the order is on its way in both versions', () => {
    const { text, html } = buildOrderShippedTemplate(order());

    expect(text).toContain('Your Cartlify order #42 is shipped and on its way to you.');
    expect(html).toContain('Your order <b>#42</b> is shipped and on its way to you.');
  });

  // the delivered mail keeps this promise
  it('tells the buyer a mail comes when the order is delivered', () => {
    const { text, html } = buildOrderShippedTemplate(order());

    expect(text).toContain('We will let you know when it is delivered.');
    expect(html).toContain('We will let you know when it is delivered.');
  });

  it('lists every item with its quantity and line total in both versions', () => {
    const { text, html } = buildOrderShippedTemplate(order());

    expect(text).toContain('- Desk lamp x 2 = €51.00');
    expect(text).toContain('- Notebook x 1 = €3.00');
    for (const part of ['Desk lamp', '€51.00', 'Notebook', '€3.00']) {
      expect(html).toContain(part);
    }
  });

  it('gives the total in the currency checkout charges in', () => {
    expect(buildOrderShippedTemplate(order()).text).toContain('Total: €54.00');
    expect(buildOrderShippedTemplate(order({ currency: 'usd' })).text).toContain('Total: $54.00');
  });

  it('puts the order link into the text and the html versions', () => {
    const { text, html } = buildOrderShippedTemplate(order());

    expect(text).toContain(orderUrl);
    expect(html).toContain(`href="${orderUrl}"`);
  });

  it('keeps the plain text version free of html', () => {
    expect(buildOrderShippedTemplate(order()).text).not.toMatch(/<[a-z!/]/i);
  });

  it('shows where the order goes only when the order has an address', () => {
    const withAddress = buildOrderShippedTemplate(order({ shippingAddress: 'Main st 1, Kyiv' }));
    const without = buildOrderShippedTemplate(order({ shippingAddress: null }));

    expect(withAddress.text).toContain('Shipping to: Main st 1, Kyiv');
    expect(withAddress.html).toContain('Main st 1, Kyiv');
    expect(without.text).not.toMatch(/shipping to/i);
    expect(without.html).not.toMatch(/shipping to/i);
  });

  it('names the recipient with the phone, and leaves the line out without them', () => {
    const withRecipient = buildOrderShippedTemplate(
      order({ recipientName: 'Anna Koval', recipientPhone: '+380501234567' }),
    );
    const without = buildOrderShippedTemplate(order({ recipientName: '', recipientPhone: null }));

    expect(withRecipient.text).toContain('Recipient: Anna Koval, +380501234567');
    expect(withRecipient.html).toContain('Anna Koval, +380501234567');
    expect(without.text).not.toMatch(/recipient/i);
    expect(without.html).not.toMatch(/recipient/i);
  });

  it('greets the user by name, or without one', () => {
    expect(buildOrderShippedTemplate(order({ userName: 'Anna' })).html).toContain('Hi Anna,');
    expect(buildOrderShippedTemplate(order({ userName: ' ' })).html).toContain('Hi,');
  });

  // the names come from the catalog and the address from the buyer
  it('escapes product names, the address and the user name in the html', () => {
    const { html } = buildOrderShippedTemplate(
      order({
        items: [{ name: '<script>x</script>', quantity: 1, totalPrice: 1 }],
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
    const { text } = buildOrderShippedTemplate(
      order({ items: [{ name: 'Mug {{orderId}}', quantity: 1, totalPrice: 5 }] }),
    );

    expect(text).toContain('- Mug {{orderId}} x 1 = €5.00');
  });

  it('shows the attached logo when a content id is given, the shop name otherwise', () => {
    expect(buildOrderShippedTemplate(order({ logoCid: 'cartlify-logo' })).html).toContain(
      'src="cid:cartlify-logo"',
    );
    expect(buildOrderShippedTemplate(order()).html).not.toContain('cid:');
  });

  it('puts the current year into the footer', () => {
    jest.useFakeTimers({ now: new Date('2031-05-01T00:00:00Z') });

    expect(buildOrderShippedTemplate(order()).html).toContain('© 2031 Cartlify');
  });

  it.each([
    ['without the order link', { orderUrl: ' ' }, 'ORDER_URL_REQUIRED'],
    ['without items', { items: [] }, 'ORDER_ITEMS_REQUIRED'],
  ])('refuses to build a mail %s', (_case, overrides, message) => {
    expect(() => buildOrderShippedTemplate(order(overrides))).toThrow(message);
  });
});
