import { describe, expect, it } from '@jest/globals';

import { buildOrderDeliveredTemplate } from '@services/email/templates/orders/orderDelivered.template.js';
import { buildOrderPaidTemplate } from '@services/email/templates/orders/orderPaid.template.js';
import { buildOrderShippedTemplate } from '@services/email/templates/orders/orderShipped.template.js';
import { withdrawalOfferOf } from '@services/email/templates/orders/withdrawalNotice.js';

// the offer to withdraw in the mails of an order: a sentence and the link of the page of withdrawal
// (its code after the #), in the mails of the payment, the shipment and the delivery

const orderUrl = 'https://shop.example.com/orders/42';
const withdrawalUrl = 'https://shop.example.com/orders/42/withdrawal#K7QM-4XTP-9RHD';

const items = [
  { name: 'Desk lamp', quantity: 1, unitPrice: 10, totalPrice: 10, withdrawal: 'allowed' as const },
  {
    name: 'Fresh cake',
    quantity: 1,
    unitPrice: 5,
    totalPrice: 5,
    withdrawal: 'perishable' as const,
  },
];
const base = { orderId: 42, orderUrl, items, total: 15, currency: 'eur' };

describe('withdrawalOfferOf', () => {
  it('has the days after the delivery for a paid and a shipped order, and the contract when it has no days', () => {
    const paid = withdrawalOfferOf('paid', items, { withdrawalUrl, withdrawalDays: 14 });
    expect(paid.withdrawalLine).toBe(
      'You may withdraw from the contract without giving a reason: before the goods are sent, and for 14 days after you receive them. Withdraw here:',
    );
    expect(paid.withdrawalUrl).toBe(withdrawalUrl);

    expect(withdrawalOfferOf('shipped', items, { withdrawalUrl, withdrawalDays: 16 })).toEqual({
      withdrawalLine:
        'You may withdraw from the contract without giving a reason for 16 days after you receive the goods. Withdraw here:',
      withdrawalUrl,
    });
    expect(
      withdrawalOfferOf('shipped', items, { withdrawalUrl, withdrawalDays: null }).withdrawalLine,
    ).toContain('for the period of your contract after');
  });

  it('names the last day of a delivered order in the time zone of the shop', () => {
    // 23:59 in Kyiv is 21:59 in utc, the same day; in Auckland it is the next day in utc
    const endsAt = new Date('2026-11-17T21:59:59.999Z');

    expect(
      withdrawalOfferOf('delivered', items, {
        withdrawalUrl,
        withdrawalEndsAt: endsAt,
        timeZone: 'Europe/Kyiv',
      }).withdrawalLine,
    ).toBe(
      'You may withdraw from the contract without giving a reason until 17 November 2026. Withdraw here:',
    );
    expect(
      withdrawalOfferOf('delivered', items, {
        withdrawalUrl,
        withdrawalEndsAt: endsAt,
        timeZone: 'Pacific/Auckland',
      }).withdrawalLine,
    ).toContain('until 18 November 2026');
  });

  it('does not say "after you receive" in the mail of a delivered order that has no end of the period', () => {
    expect(withdrawalOfferOf('delivered', items, { withdrawalUrl, withdrawalDays: 18 })).toEqual({
      withdrawalLine:
        'You may withdraw from the contract without giving a reason for 18 days after the delivery. Withdraw here:',
      withdrawalUrl,
    });
  });

  it('carries the code only in the link: not in the sentence, and in the html only in the href', () => {
    const code = 'K7QM-4XTP-9RHD';
    for (const build of [
      () =>
        buildOrderPaidTemplate({
          ...base,
          paidAt: new Date('2026-11-03T10:00:00Z'),
          withdrawalUrl,
          withdrawalDays: 14,
        }),
      () => buildOrderShippedTemplate({ ...base, withdrawalUrl, withdrawalDays: 14 }),
      () =>
        buildOrderDeliveredTemplate({
          ...base,
          withdrawalUrl,
          withdrawalEndsAt: new Date('2026-11-17T21:59:59.999Z'),
        }),
    ]) {
      const { text, html } = build();

      expect(text.split(code)).toHaveLength(2);
      expect(text.replace(withdrawalUrl, '')).not.toContain(code);
      expect(html.replace(`href="${withdrawalUrl}"`, '')).not.toContain(code);
    }
  });

  it('offers nothing without a link or when no item has the right', () => {
    const none = { withdrawalLine: '', withdrawalUrl: '' };

    expect(withdrawalOfferOf('paid', items, { withdrawalDays: 14 })).toEqual(none);
    expect(
      withdrawalOfferOf('paid', [items[1]!, { name: 'News', withdrawal: 'periodical' }], {
        withdrawalUrl,
        withdrawalDays: 14,
      }),
    ).toEqual(none);
  });

  it('offers it for an item of the conditional kind: the right holds while the condition does', () => {
    expect(
      withdrawalOfferOf('paid', [{ name: 'Film', withdrawal: 'sealed_media' }], { withdrawalUrl })
        .withdrawalUrl,
    ).toBe(withdrawalUrl);
  });
});

describe.each([
  ['paid', buildOrderPaidTemplate, 'before the goods are sent'],
  ['shipped', buildOrderShippedTemplate, 'after you receive the goods'],
] as const)('the mail of a %s order', (_stage, build, phrase) => {
  it('tells the buyer they may withdraw and links the page, in both versions', () => {
    const { text, html } = build({ ...base, withdrawalUrl, withdrawalDays: 14 } as never);

    expect(text).toContain(phrase);
    expect(text).toContain(`Withdraw here:\n${withdrawalUrl}`);
    expect(text).toContain('for 14 days');
    expect(html).toContain(`href="${withdrawalUrl}"`);
    expect(html).toContain('Withdraw from the contract');
    // the order link stays
    expect(text).toContain(`See your order:\n${orderUrl}`);
  });

  it('has no offer without a link', () => {
    const { text, html } = build({ ...base } as never);

    expect(text).not.toContain('Withdraw here');
    expect(html).not.toContain('Withdraw from the contract');
  });
});

describe('the mails of a shipped and a delivered order name the items without the right', () => {
  it.each([
    ['shipped', buildOrderShippedTemplate],
    ['delivered', buildOrderDeliveredTemplate],
  ] as const)('the %s one', (_stage, build) => {
    const { text, html } = build({ ...base, withdrawalUrl } as never);

    expect(text).toContain('No right of withdrawal applies to these goods:');
    expect(text).toContain('- Fresh cake: goods that spoil or expire quickly');
    expect(text).not.toContain('- Desk lamp: ');
    expect(html).toContain('goods that spoil or expire quickly');
  });

  it.each([
    ['shipped', buildOrderShippedTemplate],
    ['delivered', buildOrderDeliveredTemplate],
  ] as const)(
    'the %s one says nothing of it when the items may all be taken back',
    (_stage, build) => {
      const { text, html } = build({
        ...base,
        items: [{ name: 'Desk lamp', quantity: 1, totalPrice: 10, withdrawal: 'allowed' }],
      } as never);

      expect(text).not.toContain('No right of withdrawal');
      expect(html).not.toContain('No right of withdrawal');
    },
  );
});

describe('the mail of a delivered order', () => {
  it('names the last day of the period and links the page', () => {
    const { text, html } = buildOrderDeliveredTemplate({
      ...base,
      withdrawalUrl,
      withdrawalEndsAt: new Date('2026-11-17T21:59:59.999Z'),
      timeZone: 'Europe/Kyiv',
    });

    expect(text).toContain('until 17 November 2026. Withdraw here:');
    expect(text).toContain(`Withdraw here:\n${withdrawalUrl}`);
    expect(html).toContain(`href="${withdrawalUrl}"`);
  });

  it('keeps the offer after the invitation to rate', () => {
    const { text } = buildOrderDeliveredTemplate({
      ...base,
      items: items.map((item) => ({ ...item, reviewUrl: 'https://shop.example.com/products/1' })),
      withdrawalUrl,
    });

    expect(text.indexOf('How is it?')).toBeGreaterThan(-1);
    expect(text.indexOf('Withdraw here:')).toBeGreaterThan(text.indexOf('How is it?'));
  });
});
