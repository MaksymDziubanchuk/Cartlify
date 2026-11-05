import { describe, expect, it } from '@jest/globals';

import { renderSource, renderTemplate } from '@services/email/renderTemplate.js';

const html = { html: true };
const text = { html: false };

describe('renderSource', () => {
  it('puts the values into their marks', () => {
    expect(
      renderSource('Hi {{name}}, see {{url}}', { name: 'Anna', url: 'https://x.test' }, text),
    ).toBe('Hi Anna, see https://x.test');
  });

  it('escapes the values of an html template, they come from users and links', () => {
    const out = renderSource(
      '<a href="{{url}}">{{name}}</a>',
      { url: 'https://x.test/?a=1&b="2"', name: '<b>x</b>' },
      html,
    );

    expect(out).toBe('<a href="https://x.test/?a=1&amp;b=&quot;2&quot;">&lt;b&gt;x&lt;/b&gt;</a>');
  });

  it('keeps the values of a text template as they are', () => {
    expect(renderSource('{{url}}', { url: 'https://x.test/?a=1&b=2' }, text)).toBe(
      'https://x.test/?a=1&b=2',
    );
  });

  it('keeps a section only when its value is not empty', () => {
    const source = 'Hi{{#name}} {{name}}{{/name}},';

    expect(renderSource(source, { name: 'Anna' }, text)).toBe('Hi Anna,');
    expect(renderSource(source, { name: '' }, text)).toBe('Hi,');
  });

  it('keeps an inverted section only when its value is empty', () => {
    const source = '{{#logo}}<img src="cid:{{logo}}">{{/logo}}{{^logo}}<b>{{app}}</b>{{/logo}}';

    expect(renderSource(source, { logo: 'l1', app: 'Shop' }, html)).toBe('<img src="cid:l1">');
    expect(renderSource(source, { logo: '', app: 'Shop' }, html)).toBe('<b>Shop</b>');
  });

  it('takes a section over several lines', () => {
    expect(renderSource('a\n{{#ttl}}valid for {{ttl}}\n{{/ttl}}b', { ttl: '1 hour' }, text)).toBe(
      'a\nvalid for 1 hour\nb',
    );
  });

  it('repeats a list section for each item, the marks inside take the fields of the item', () => {
    const source = '{{#items}}<li>{{name}} x {{qty}} ({{shop}})</li>{{/items}}';
    const items = [
      { name: 'Lamp', qty: '2' },
      { name: '<Mug>', qty: '1' },
    ];

    expect(renderSource(source, { items, shop: 'S' }, html)).toBe(
      '<li>Lamp x 2 (S)</li><li>&lt;Mug&gt; x 1 (S)</li>',
    );
  });

  it('drops a list section for an empty list and keeps its inverted one', () => {
    const source = '{{#items}}<li>{{name}}</li>{{/items}}{{^items}}none{{/items}}';

    expect(renderSource(source, { items: [] }, html)).toBe('none');
  });

  // a value is filled in once: braces typed by a user are not a mark
  it('never reads a value as a mark', () => {
    const out = renderSource(
      'Hi {{name}}, {{#items}}{{title}}{{/items}}',
      {
        name: '{{year}}',
        year: '2031',
        items: [{ title: '{{name}} {{' }],
      },
      text,
    );

    expect(out).toBe('Hi {{year}}, {{name}} {{');
  });

  it('refuses a list where a text is expected', () => {
    expect(() => renderSource('{{items}}', { items: [] }, text)).toThrow(
      /EMAIL_TEMPLATE_LIST_AS_TEXT/,
    );
  });

  it('drops the spaces and lines at the edges', () => {
    expect(renderSource('\n  {{name}}  \n', { name: 'x' }, text)).toBe('x');
  });

  // a mistake in a template must stop the mail, not reach a mailbox
  it.each([
    ['a mark without a value', '{{missing}}', {}],
    ['a section without a value', '{{#missing}}x{{/missing}}', {}],
    ['a section that is never closed', '{{#name}}x', { name: 'a' }],
    ['a mark with a typo', '{{ name }}', { name: 'a' }],
  ])('refuses %s', (_case, source, values) => {
    expect(() =>
      renderSource(source, values as Record<string, string>, { ...text, name: 't.txt' }),
    ).toThrow(/EMAIL_TEMPLATE_.*t\.txt/);
  });
});

describe('renderTemplate', () => {
  const values = {
    appName: 'Cartlify',
    verifyUrl: 'https://shop.example.com/web/login?token=t',
    resetUrl: 'https://shop.example.com/web/auth/reset?token=t',
    userName: 'Anna',
    logoCid: 'cartlify-logo',
    expiresInText: '24 hours',
    year: '2031',
    orderId: '42',
    orderUrl: 'https://shop.example.com/orders/42',
    paidAt: '17 October 2026 at 18:05 UTC',
    items: [{ name: 'Lamp', quantity: '2', unitPrice: '€1.00', lineTotal: '€2.00' }],
    total: '€2.00',
    shippingAddress: 'Main st 1',
    pickup: 'Main street 1, Mon-Fri 10:00-18:00',
    deliveryLine: '€4.99',
    carrier: 'DHL',
    trackingNumber: 'JD0146',
    trackingUrl: 'https://track.example.com/JD0146',
    // how the mail of a delivered order says the order came to the buyer
    statement: 'is delivered',
    heading: 'Order delivered',
    recipient: 'Anna Koval, +380501234567',
    // the files of the terms and of the contract a paid order carries
    attachedLine: 'The terms and the contract you accepted are attached to this mail.',
    // the goods of a paid order that are not taken back, or only while sealed
    noRightLine: 'No right of withdrawal applies to these goods:',
    noRightItems: [{ name: 'Flowers', reason: 'goods that spoil or expire quickly' }],
    conditionalLine: 'You may withdraw from these goods only while the condition holds:',
    conditionalItems: [{ name: 'Disc', reason: 'sealed recordings, until the seal is broken' }],
    // the offer to withdraw in the mails of an order, with the link that carries the code
    withdrawalLine: 'You may withdraw from the contract without giving a reason. Withdraw here:',
    withdrawalUrl: 'https://shop.example.com/orders/42/withdrawal#K7QM-4XTP-9RHD',
    // the products a delivered order asks to rate
    hasRatings: 'yes',
    ratings: [{ name: 'Lamp', reviewUrl: 'https://shop.example.com/products/7#reviews' }],
    // the i18next-resolved phrases every converted template now takes as plain strings
    title: 'Cartlify — Verify email',
    preview: 'Confirm your email for Cartlify.',
    leadTxt: 'Verify your email for Cartlify.',
    greeting: 'Hi Anna,',
    body: 'Please confirm your email address to finish setting up your account.',
    button: 'Verify email',
    validity: 'This link is valid for 24 hours.',
    openLinkTxt: 'Open this link:',
    openLinkFallback: 'If the button does not work, open this link:',
    ignoreEmail: 'If you did not request this, ignore this email.',
    questionsIntro: 'Questions? Write to us in the chat on our site',
    orTo: 'or to',
    seeOrderTxt: 'See your order:',
    viewOrderButton: 'View order',
    withdrawContract: 'Withdraw from the contract',
    itemHeader: 'Item',
    qtyHeader: 'Qty',
    priceHeader: 'Price',
    totalHeader: 'Total',
    recipientLabel: 'Recipient',
    deliveryLabel: 'Delivery',
    shippingToLabel: 'Shipping to',
    pickupAtLabel: 'Pick up at',
    paidOn: 'Paid on 17 October 2026',
    carrierLabel: 'Carrier',
    trackingNumberLabel: 'Tracking number',
    followParcelLabel: 'Follow your parcel',
    deliveredToLabel: 'Delivered to',
    collectedAtLabel: 'Collected at',
    ratingsIntro: 'How is it? Rate what you bought, it helps other buyers choose:',
    rateButton: 'Rate Lamp',
  };

  it.each([
    'auth/verifyEmail.html',
    'auth/verifyEmail.txt',
    'auth/resetPassword.html',
    'auth/resetPassword.txt',
    'orders/orderPaid.html',
    'orders/orderPaid.txt',
    'orders/orderShipped.html',
    'orders/orderShipped.txt',
    'orders/orderDelivered.html',
    'orders/orderDelivered.txt',
  ])('renders %s without leaving a mark behind', (file) => {
    const out = renderTemplate(file, values);

    expect(out).not.toContain('{{');
    expect(out).toContain('Cartlify');
  });

  it('keeps windows line endings of the checkout out of the mail', () => {
    expect(renderTemplate('auth/verifyEmail.txt', values)).not.toContain('\r');
  });

  // every mail says where to write: the chat, or the address the shop answers from
  it('ends every mail with the chat and the address of the shop, given or of the settings', () => {
    const own = renderTemplate('auth/verifyEmail.txt', {
      ...values,
      supportEmail: 'help@shop.example.com',
    });
    const set = renderTemplate('orders/orderShipped.html', values);
    const none = renderTemplate('auth/resetPassword.txt', { ...values, supportEmail: '' });

    expect(own).toContain(
      'Questions? Write to us in the chat on our site or to help@shop.example.com.',
    );
    expect(set).toContain('Questions? Write to us in the chat on our site');
    expect(none).toContain('Questions? Write to us in the chat on our site.');
    for (const out of [own, set, none]) expect(out).not.toContain('not monitored');
  });
});
