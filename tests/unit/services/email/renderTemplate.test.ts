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
    recipient: 'Anna Koval, +380501234567',
    // the files of the terms and of the contract a paid order carries
    attachedLine: 'The terms and the contract you accepted are attached to this mail.',
    // the products a delivered order asks to rate
    hasRatings: 'yes',
    ratings: [{ name: 'Lamp', reviewUrl: 'https://shop.example.com/products/7#reviews' }],
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
    'orders/orderCancelled.html',
    'orders/orderCancelled.txt',
  ])('renders %s without leaving a mark behind', (file) => {
    const out = renderTemplate(file, values);

    expect(out).not.toContain('{{');
    expect(out).toContain('Cartlify');
  });

  it('keeps windows line endings of the checkout out of the mail', () => {
    expect(renderTemplate('auth/verifyEmail.txt', values)).not.toContain('\r');
  });
});
