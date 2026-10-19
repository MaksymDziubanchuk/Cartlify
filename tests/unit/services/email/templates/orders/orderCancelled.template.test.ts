import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  buildOrderCancelledTemplate,
  type OrderCancelledTemplateArgs,
} from '@services/email/templates/orders/orderCancelled.template.js';

const orderUrl = 'https://shop.example.com/orders/42';

const order = (
  overrides: Partial<OrderCancelledTemplateArgs> = {},
): OrderCancelledTemplateArgs => ({
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

describe('buildOrderCancelledTemplate', () => {
  it('names the shop and the order in the subject', () => {
    const { subject } = buildOrderCancelledTemplate(order());

    expect(subject).toBe('Cartlify — Order #42 is cancelled');
  });

  // the buyer paid, the mail says the money goes back and how much
  it('says the whole payment is refunded in both versions', () => {
    const { text, html } = buildOrderCancelledTemplate(order());

    expect(text).toContain('Your Cartlify order #42 is cancelled.');
    expect(text).toContain('The payment of €54.00 is refunded in full');
    expect(html).toContain('The payment of <b>€54.00</b> is refunded in full');
  });

  it('lists every item with its quantity and line total in both versions', () => {
    const { text, html } = buildOrderCancelledTemplate(order());

    expect(text).toContain('- Desk lamp x 2 = €51.00');
    expect(text).toContain('- Notebook x 1 = €3.00');
    for (const part of ['Desk lamp', '€51.00', 'Notebook', '€3.00']) {
      expect(html).toContain(part);
    }
  });

  it('gives the refund in the currency checkout charges in', () => {
    expect(buildOrderCancelledTemplate(order({ currency: 'usd' })).text).toContain(
      'The payment of $54.00 is refunded in full',
    );
  });

  it('puts the order link into the text and the html versions', () => {
    const { text, html } = buildOrderCancelledTemplate(order());

    expect(text).toContain(orderUrl);
    expect(html).toContain(`href="${orderUrl}"`);
  });

  it('keeps the plain text version free of html', () => {
    expect(buildOrderCancelledTemplate(order()).text).not.toMatch(/<[a-z!/]/i);
  });

  it('greets the user by name, or without one', () => {
    expect(buildOrderCancelledTemplate(order({ userName: 'Anna' })).html).toContain('Hi Anna,');
    expect(buildOrderCancelledTemplate(order({ userName: ' ' })).html).toContain('Hi,');
  });

  // the names come from the catalog
  it('escapes product names and the user name in the html', () => {
    const { html } = buildOrderCancelledTemplate(
      order({
        items: [{ name: '<script>x</script>', quantity: 1, totalPrice: 1 }],
        userName: '<b>Anna</b>',
      }),
    );

    expect(html).not.toContain('<script>x</script>');
    expect(html).not.toContain('<b>Anna</b>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('takes a product name with braces as it is', () => {
    const { text } = buildOrderCancelledTemplate(
      order({ items: [{ name: 'Mug {{orderId}}', quantity: 1, totalPrice: 5 }] }),
    );

    expect(text).toContain('- Mug {{orderId}} x 1 = €5.00');
  });

  it('shows the attached logo when a content id is given, the shop name otherwise', () => {
    expect(buildOrderCancelledTemplate(order({ logoCid: 'cartlify-logo' })).html).toContain(
      'src="cid:cartlify-logo"',
    );
    expect(buildOrderCancelledTemplate(order()).html).not.toContain('cid:');
  });

  it('puts the current year into the footer', () => {
    jest.useFakeTimers({ now: new Date('2031-05-01T00:00:00Z') });

    expect(buildOrderCancelledTemplate(order()).html).toContain('© 2031 Cartlify');
  });

  it.each([
    ['without the order link', { orderUrl: ' ' }, 'ORDER_URL_REQUIRED'],
    ['without items', { items: [] }, 'ORDER_ITEMS_REQUIRED'],
  ])('refuses to build a mail %s', (_case, overrides, message) => {
    expect(() => buildOrderCancelledTemplate(order(overrides))).toThrow(message);
  });
});
