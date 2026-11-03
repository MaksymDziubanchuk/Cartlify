import { describe, expect, it } from '@jest/globals';

import {
  buildReturnByShopTemplate,
  type ReturnByShopTemplateArgs,
} from '@services/email/templates/returns/returnByShop.template.js';

const orderUrl = 'https://shop.example.com/orders/42';

const registered = (
  overrides: Partial<ReturnByShopTemplateArgs> = {},
): ReturnByShopTemplateArgs => ({
  orderId: 42,
  orderUrl,
  items: [
    { name: 'Desk lamp', quantity: 2 },
    { name: 'Notebook', quantity: 1 },
  ],
  reason: 'defect',
  statedAt: new Date('2026-11-02T10:05:00Z'),
  supportEmail: 'support@shop.example.com',
  ...overrides,
});

// the mail that says the shop registered a return for the order: what, why, when, where to write
describe('buildReturnByShopTemplate', () => {
  it('names the shop and the order in the subject', () => {
    expect(buildReturnByShopTemplate(registered()).subject).toBe(
      'Cartlify — Return of order #42 registered',
    );
  });

  it('lists the items with their units in both versions', () => {
    const { text, html } = buildReturnByShopTemplate(registered());

    expect(text).toContain('- Desk lamp x 2');
    expect(text).toContain('- Notebook x 1');
    for (const part of ['Desk lamp', 'Notebook']) expect(html).toContain(part);
  });

  it.each([
    ['defect', 'a defect of the goods'],
    ['wrong_item', 'the wrong item'],
    ['damaged', 'damage of the goods'],
    ['goodwill', 'a return the shop agreed to'],
    ['shop_cancel', 'the cancellation of your order by the shop'],
    ['refused', 'your refusal of the parcel'],
  ] as const)('says why: %s is %s', (reason, words) => {
    const { text, html } = buildReturnByShopTemplate(registered({ reason }));

    expect(text).toContain(`Reason: ${words}.`);
    expect(html).toContain(words);
  });

  it('leaves the reason out when there is none to say', () => {
    const { reason: _given, ...none } = registered();
    for (const args of [none, registered({ reason: null }), registered({ reason: 'other' })]) {
      expect(buildReturnByShopTemplate(args).text).not.toContain('Reason:');
    }
  });

  it('gives the date and time of the statement in the zone of the shop, which it names (utc when none)', () => {
    const { text, html } = buildReturnByShopTemplate(registered());
    const kyiv = buildReturnByShopTemplate(registered({ timeZone: 'Europe/Kyiv' }));

    expect(text).toContain('Registered on 2 November 2026 at 10:05 (UTC).');
    expect(html).toContain('2 November 2026 at 10:05 (UTC)');
    expect(kyiv.text).toContain('Registered on 2 November 2026 at 12:05 (Europe/Kyiv).');
  });

  it('names the code of the statement in the subject and the text, only when there is one', () => {
    const { subject, text, html } = buildReturnByShopTemplate(registered({ code: 'R42-2' }));

    expect(subject.endsWith(' (R42-2)')).toBe(true);
    expect(text).toContain('Statement R42-2.');
    expect(html).toContain('Statement R42-2');
    expect(buildReturnByShopTemplate(registered()).text).not.toContain('Statement ');
  });

  it('says it extends an earlier statement, only when it does', () => {
    expect(buildReturnByShopTemplate(registered({ extended: true })).text).toContain(
      'It extends your earlier statement.',
    );
    expect(buildReturnByShopTemplate(registered()).text).not.toContain('extends');
  });

  it('puts the words of the admin in, only when there are some', () => {
    const { text } = buildReturnByShopTemplate(registered({ description: 'The box came open.' }));

    expect(text).toContain('Note: The box came open.');
    expect(buildReturnByShopTemplate(registered()).text).not.toContain('Note:');
  });

  it('says where to write with a neutral line, and puts the order link in both versions', () => {
    const { text, html } = buildReturnByShopTemplate(registered());

    expect(text).toContain(
      'Questions? Write to us in the chat on our site or to support@shop.example.com.',
    );
    expect(html).toContain('support@shop.example.com');
    expect(text).toContain(orderUrl);
    expect(html).toContain(`href="${orderUrl}"`);
  });

  it('keeps the plain text version free of html', () => {
    expect(buildReturnByShopTemplate(registered()).text).not.toMatch(/<[a-z]/);
  });

  it('escapes the names, the note and the user name in the html', () => {
    const { html } = buildReturnByShopTemplate(
      registered({
        items: [{ name: '<b>Lamp</b>', quantity: 1 }],
        description: '<script>x</script>',
        userName: '<i>Anna</i>',
      }),
    );

    expect(html).not.toContain('<b>Lamp</b>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<i>Anna</i>');
    expect(html).toContain('&lt;b&gt;Lamp&lt;/b&gt;');
  });

  it('greets the user by name, or without one', () => {
    expect(buildReturnByShopTemplate(registered({ userName: 'Anna' })).text).toContain('Hi Anna,');
    expect(buildReturnByShopTemplate(registered()).text).toContain('Hi,');
  });

  it('refuses a mail with no order link or no items', () => {
    expect(() => buildReturnByShopTemplate(registered({ orderUrl: ' ' }))).toThrow(
      'ORDER_URL_REQUIRED',
    );
    expect(() => buildReturnByShopTemplate(registered({ items: [] }))).toThrow(
      'ORDER_ITEMS_REQUIRED',
    );
  });
});
