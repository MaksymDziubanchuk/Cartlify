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

  // the files are the versions of the terms and of the contract the order was made under
  it('names the documents attached, only when the mail carries them', () => {
    const line = 'The terms and the contract you accepted are attached to this mail.';
    const both = buildOrderPaidTemplate(order({ attachedDocuments: ['terms', 'contract'] }));

    expect(both.text).toContain(line);
    expect(both.html).toContain(line);
    expect(buildOrderPaidTemplate(order({ attachedDocuments: ['terms'] })).text).toContain(
      'The terms you accepted are attached to this mail.',
    );
    expect(buildOrderPaidTemplate(order({ attachedDocuments: ['contract'] })).text).toContain(
      'The contract you accepted is attached to this mail.',
    );
    for (const args of [order({ attachedDocuments: [] }), order()]) {
      const mail = buildOrderPaidTemplate(args);
      expect(mail.text).not.toContain('attached');
      expect(mail.html).not.toContain('attached');
    }
  });

  describe('the right of withdrawal of the goods', () => {
    const withRules = (
      ...rules: Array<'allowed' | 'sealed_media' | 'perishable' | 'personalised'>
    ) =>
      order({
        items: rules.map((withdrawal, index) => ({
          name: `Item ${index + 1}`,
          quantity: 1,
          unitPrice: 10,
          totalPrice: 10,
          withdrawal,
        })),
        total: 10 * rules.length,
      });

    it('says nothing of it while every item may be taken back freely', () => {
      for (const mail of [
        buildOrderPaidTemplate(withRules('allowed', 'allowed')),
        buildOrderPaidTemplate(order()),
      ]) {
        expect(mail.text).not.toMatch(/withdraw/i);
        expect(mail.html).not.toMatch(/withdraw/i);
      }
    });

    it('names the items that are not taken back, each with its reason', () => {
      const { text, html } = buildOrderPaidTemplate(
        withRules('allowed', 'perishable', 'personalised'),
      );

      expect(text).toContain('No right of withdrawal applies to these goods:');
      expect(text).toContain('- Item 2: goods that spoil or expire quickly');
      expect(text).toContain('- Item 3: goods made to your specification or personalised');
      expect(text).not.toContain('Item 1:');
      for (const part of ['No right of withdrawal applies to these goods:', 'Item 2', 'Item 3']) {
        expect(html).toContain(part);
      }
    });

    it('names the items that are taken back only while sealed, with the condition', () => {
      const { text, html } = buildOrderPaidTemplate(withRules('sealed_media', 'allowed'));

      expect(text).toContain('You may withdraw from these goods only while the condition holds:');
      expect(text).toContain(
        '- Item 1: sealed audio or video recordings and software, until the seal is broken',
      );
      expect(text).not.toContain('No right of withdrawal applies');
      expect(html).toContain('Item 1');
      expect(html).toContain('until the seal is broken');
    });

    it('gives both lists when the order has both kinds of item', () => {
      const { text } = buildOrderPaidTemplate(withRules('perishable', 'sealed_media'));

      expect(text.indexOf('No right of withdrawal applies')).toBeGreaterThan(-1);
      expect(text.indexOf('You may withdraw from these goods only')).toBeGreaterThan(-1);
    });

    it('escapes the name of an item in the html', () => {
      const { html } = buildOrderPaidTemplate(
        order({
          items: [
            {
              name: '<b>Fresh</b> flowers',
              quantity: 1,
              unitPrice: 5,
              totalPrice: 5,
              withdrawal: 'perishable',
            },
          ],
        }),
      );

      expect(html).not.toContain('<b>Fresh</b>');
      expect(html).toContain('&lt;b&gt;Fresh&lt;/b&gt; flowers');
    });
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
