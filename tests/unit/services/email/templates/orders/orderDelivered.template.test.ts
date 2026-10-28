import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  buildOrderDeliveredTemplate,
  type OrderDeliveredTemplateArgs,
} from '@services/email/templates/orders/orderDelivered.template.js';

const orderUrl = 'https://shop.example.com/orders/42';

const order = (
  overrides: Partial<OrderDeliveredTemplateArgs> = {},
): OrderDeliveredTemplateArgs => ({
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

describe('buildOrderDeliveredTemplate', () => {
  it.each([
    ['a price the buyer paid', 4.99, 'Delivery: €4.99'],
    ['a free delivery', 0, 'Delivery: free'],
  ])(
    'shows the delivery line of %s above the total in both versions',
    (_name, deliveryPrice, line) => {
      const { text, html } = buildOrderDeliveredTemplate(order({ deliveryPrice }));

      expect(text).toContain(line);
      expect(text.indexOf(line)).toBeLessThan(text.indexOf('Total:'));
      expect(html).toContain(line.replace('Delivery: ', ''));
    },
  );

  it('leaves the delivery line out for a pickup, which has no price', () => {
    const { text, html } = buildOrderDeliveredTemplate(order({ deliveryPrice: null }));

    expect(text).not.toContain('Delivery:');
    expect(html).not.toContain('>Delivery<');
  });

  // a delivered order asks the buyer to rate what came, each product with the page of its reviews
  it('asks to rate each product that has the page of its reviews', () => {
    const { text, html } = buildOrderDeliveredTemplate(
      order({
        items: [
          {
            name: 'Desk lamp',
            quantity: 2,
            totalPrice: '51.00',
            reviewUrl: 'https://shop.example.com/products/7#reviews',
          },
          { name: 'Notebook', quantity: 1, totalPrice: 3 },
        ],
      }),
    );

    expect(text).toContain('Rate what you bought');
    expect(text).toContain('- Desk lamp: https://shop.example.com/products/7#reviews');
    expect(text).not.toContain('- Notebook:');
    expect(html).toContain('href="https://shop.example.com/products/7#reviews"');
    expect(html).toContain('Rate Desk lamp');
  });

  it('asks nothing when no product has the page of its reviews', () => {
    const { text, html } = buildOrderDeliveredTemplate(order());

    expect(text).not.toContain('Rate what you bought');
    expect(html).not.toContain('Rate what you bought');
  });

  it('names the shop and the order in the subject', () => {
    const { subject } = buildOrderDeliveredTemplate(order());

    expect(subject).toBe('Cartlify — Order #42 is delivered');
  });

  it('says the order is delivered in both versions', () => {
    const { text, html } = buildOrderDeliveredTemplate(order());

    expect(text).toContain('Your Cartlify order #42 is delivered.');
    expect(html).toContain('Your order <b>#42</b> is delivered.');
  });

  it('lists every item with its quantity and line total in both versions', () => {
    const { text, html } = buildOrderDeliveredTemplate(order());

    expect(text).toContain('- Desk lamp x 2 = €51.00');
    expect(text).toContain('- Notebook x 1 = €3.00');
    for (const part of ['Desk lamp', '€51.00', 'Notebook', '€3.00']) {
      expect(html).toContain(part);
    }
  });

  it('gives the total in the currency checkout charges in', () => {
    expect(buildOrderDeliveredTemplate(order()).text).toContain('Total: €54.00');
    expect(buildOrderDeliveredTemplate(order({ currency: 'usd' })).text).toContain('Total: $54.00');
  });

  it('puts the order link into the text and the html versions', () => {
    const { text, html } = buildOrderDeliveredTemplate(order());

    expect(text).toContain(orderUrl);
    expect(html).toContain(`href="${orderUrl}"`);
  });

  it('keeps the plain text version free of html', () => {
    expect(buildOrderDeliveredTemplate(order()).text).not.toMatch(/<[a-z!/]/i);
  });

  it('shows where the order went only when the order has an address', () => {
    const withAddress = buildOrderDeliveredTemplate(order({ shippingAddress: 'Main st 1, Kyiv' }));
    const without = buildOrderDeliveredTemplate(order({ shippingAddress: null }));

    expect(withAddress.text).toContain('Delivered to: Main st 1, Kyiv');
    expect(withAddress.html).toContain('Main st 1, Kyiv');
    expect(without.text).not.toMatch(/delivered to/i);
    expect(without.html).not.toMatch(/delivered to/i);
  });

  it('names the recipient with the phone, and leaves the line out without them', () => {
    const withRecipient = buildOrderDeliveredTemplate(
      order({ recipientName: 'Anna Koval', recipientPhone: '+380501234567' }),
    );
    const without = buildOrderDeliveredTemplate(order({ recipientName: '', recipientPhone: null }));

    expect(withRecipient.text).toContain('Recipient: Anna Koval, +380501234567');
    expect(withRecipient.html).toContain('Anna Koval, +380501234567');
    expect(without.text).not.toMatch(/recipient/i);
    expect(without.html).not.toMatch(/recipient/i);
  });

  // an admin may mark an order delivered that never arrived, the buyer needs to know where to say so
  it('tells the buyer where to say the order did not arrive', () => {
    const { text, html } = buildOrderDeliveredTemplate(order());

    expect(text).toContain('The order did not reach you');
    expect(html).toContain('The order did not reach you');
  });

  it('greets the user by name, or without one', () => {
    expect(buildOrderDeliveredTemplate(order({ userName: 'Anna' })).html).toContain('Hi Anna,');
    expect(buildOrderDeliveredTemplate(order({ userName: ' ' })).html).toContain('Hi,');
  });

  // the names come from the catalog and the address from the buyer
  it('escapes product names, the address and the user name in the html', () => {
    const { html } = buildOrderDeliveredTemplate(
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
    const { text } = buildOrderDeliveredTemplate(
      order({ items: [{ name: 'Mug {{orderId}}', quantity: 1, totalPrice: 5 }] }),
    );

    expect(text).toContain('- Mug {{orderId}} x 1 = €5.00');
  });

  it('shows the attached logo when a content id is given, the shop name otherwise', () => {
    expect(buildOrderDeliveredTemplate(order({ logoCid: 'cartlify-logo' })).html).toContain(
      'src="cid:cartlify-logo"',
    );
    expect(buildOrderDeliveredTemplate(order()).html).not.toContain('cid:');
  });

  it('puts the current year into the footer', () => {
    jest.useFakeTimers({ now: new Date('2031-05-01T00:00:00Z') });

    expect(buildOrderDeliveredTemplate(order()).html).toContain('© 2031 Cartlify');
  });

  it.each([
    ['without the order link', { orderUrl: ' ' }, 'ORDER_URL_REQUIRED'],
    ['without items', { items: [] }, 'ORDER_ITEMS_REQUIRED'],
  ])('refuses to build a mail %s', (_case, overrides, message) => {
    expect(() => buildOrderDeliveredTemplate(order(overrides))).toThrow(message);
  });
});
