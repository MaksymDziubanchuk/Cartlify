import { describe, expect, it } from '@jest/globals';

import { buildReturnChangedTemplate } from '@services/email/templates/returns/returnChanged.template.js';
import { buildReturnClosedTemplate } from '@services/email/templates/returns/returnClosed.template.js';
import { buildReturnReimbursedTemplate } from '@services/email/templates/returns/returnReimbursed.template.js';
import { buildReturnRefundFailedTemplate } from '@services/email/templates/returns/returnRefundFailed.template.js';
import { buildReturnReceivedTemplate } from '@services/email/templates/returns/returnReceived.template.js';
import { buildReturnRefundedTemplate } from '@services/email/templates/returns/returnRefunded.template.js';

const orderUrl = 'https://shop.example.com/orders/42';
const supportEmail = 'support@shop.example.com';

// the three mails of the money of a statement: the money is back, the statement is closed, the money
// could not go to the card. Each says where to write, with a neutral line, and links the order

describe('buildReturnRefundedTemplate', () => {
  const base = {
    orderId: 42,
    orderUrl,
    items: [
      { name: 'Desk lamp', quantity: 2 },
      { name: 'Notebook', quantity: 1 },
    ],
    amount: '25.5',
    currency: 'eur',
    supportEmail,
  };

  it('names the order in the subject and the sum in both versions', () => {
    const { subject, text, html } = buildReturnRefundedTemplate(base);

    expect(subject).toBe('Cartlify — Money returned for order #42');
    expect(text).toContain('We returned €25.50 for your Cartlify order #42.');
    expect(html).toContain('€25.50');
  });

  it('lists the items with their units', () => {
    const { text, html } = buildReturnRefundedTemplate(base);

    expect(text).toContain('- Desk lamp x 2');
    expect(text).toContain('- Notebook x 1');
    expect(html).toContain('Desk lamp');
  });

  it('says it goes back the way the buyer paid, unless it was sent outside the app', () => {
    expect(buildReturnRefundedTemplate(base).text).toContain('It goes back the way you paid.');

    const outside = buildReturnRefundedTemplate({
      ...base,
      outsideMethod: 'bank_transfer',
      sentOn: new Date('2026-11-02T10:05:00Z'),
    });
    expect(outside.text).toContain('We sent it by a bank transfer on 2 November 2026.');
    expect(outside.text).not.toContain('the way you paid');
  });

  it.each([
    ['cash', 'cash'],
    ['other', 'another way'],
  ])('names the way %s as %s', (method, words) => {
    expect(buildReturnRefundedTemplate({ ...base, outsideMethod: method }).text).toContain(
      `We sent it by ${words}.`,
    );
  });

  it('mentions the delivery only when it went back too', () => {
    expect(buildReturnRefundedTemplate(base).text).not.toContain('delivery');
    expect(buildReturnRefundedTemplate({ ...base, deliveryAmount: '5.00' }).text).toContain(
      'The delivery is included: €5.00.',
    );
  });

  it('says where to write, links the order and greets by name when there is one', () => {
    const { text, html } = buildReturnRefundedTemplate({ ...base, userName: 'Anna' });

    expect(text).toContain(`Questions? Write to us in the chat on our site or to ${supportEmail}.`);
    expect(text).toContain(orderUrl);
    expect(html).toContain(`href="${orderUrl}"`);
    expect(text.startsWith('Hi Anna,')).toBe(true);
  });

  it('refuses no order link and no items', () => {
    expect(() => buildReturnRefundedTemplate({ ...base, orderUrl: ' ' })).toThrow(
      'ORDER_URL_REQUIRED',
    );
    expect(() => buildReturnRefundedTemplate({ ...base, items: [] })).toThrow(
      'ORDER_ITEMS_REQUIRED',
    );
  });
});

describe('buildReturnRefundedTemplate and the way back', () => {
  it('says the cost of sending the goods back was taken off, when it was', () => {
    const { text, html } = buildReturnRefundedTemplate({
      orderId: 42,
      orderUrl,
      items: [{ name: 'Desk lamp', quantity: 1 }],
      amount: '6',
      deductionAmount: '4',
      currency: 'eur',
      supportEmail,
    });

    expect(text).toContain('We returned €6.00');
    expect(text).toContain(
      'The cost of sending the goods back, €4.00, is taken off: the contract says you pay it.',
    );
    expect(html).toContain('is taken off');
  });

  it('says nothing of the way back when nothing was taken off', () => {
    const { text } = buildReturnRefundedTemplate({
      orderId: 42,
      orderUrl,
      items: [{ name: 'Desk lamp', quantity: 1 }],
      amount: '10',
      deductionAmount: 0,
      currency: 'eur',
      supportEmail,
    });

    expect(text).not.toContain('taken off');
  });
});

// the code of the statement the buyer sees in every mail of it, the same the admins see
describe('the code of the statement in the mails', () => {
  const builds: Array<
    [string, (code?: string) => { subject: string; text: string; html: string }]
  > = [
    [
      'refunded',
      (code) =>
        buildReturnRefundedTemplate({
          orderId: 42,
          orderUrl,
          items: [{ name: 'Desk lamp', quantity: 1 }],
          amount: 10,
          currency: 'eur',
          supportEmail,
          ...(code ? { code } : {}),
        }),
    ],
    [
      'closed',
      (code) =>
        buildReturnClosedTemplate({
          orderId: 42,
          orderUrl,
          refunded: [{ name: 'Desk lamp', quantity: 1 }],
          declined: [],
          refundedAmount: 10,
          currency: 'eur',
          supportEmail,
          ...(code ? { code } : {}),
        }),
    ],
    [
      'refund failed',
      (code) =>
        buildReturnRefundFailedTemplate({
          orderId: 42,
          orderUrl,
          amount: 10,
          currency: 'eur',
          supportEmail,
          ...(code ? { code } : {}),
        }),
    ],
    [
      'reimbursed',
      (code) =>
        buildReturnReimbursedTemplate({
          orderId: 42,
          orderUrl,
          amount: 6.5,
          currency: 'eur',
          method: 'cash',
          sentOn: new Date('2026-11-03T09:30:00Z'),
          supportEmail,
          ...(code ? { code } : {}),
        }),
    ],
  ];

  it.each(builds)('names it in the subject and the text of the mail %s', (_name, build) => {
    const { subject, text, html } = build('W42-2');

    expect(subject.endsWith(' (W42-2)')).toBe(true);
    expect(text).toContain('Statement W42-2.');
    expect(html).toContain('Statement W42-2');
    expect(build().subject).not.toContain('(');
    expect(build().text).not.toContain('Statement ');
  });
});

// what root kept of the price for the value the goods lost: a neutral line, never the note of root
describe('the money kept for the value the goods lost', () => {
  it('is told in the mail of the money and in the mail of the end', () => {
    const refunded = buildReturnRefundedTemplate({
      orderId: 42,
      orderUrl,
      items: [{ name: 'Desk lamp', quantity: 1 }],
      amount: 7,
      currency: 'eur',
      supportEmail,
      withheldAmount: 3,
      withheldItems: ['Desk lamp'],
    });
    const closed = buildReturnClosedTemplate({
      orderId: 42,
      orderUrl,
      refunded: [{ name: 'Desk lamp', quantity: 1 }],
      declined: [],
      refundedAmount: 7,
      currency: 'eur',
      supportEmail,
      withheldAmount: 3,
      withheldItems: ['Desk lamp'],
    });

    const line = 'We kept €3.00 of the price for the value the goods lost: Desk lamp.';
    expect(refunded.text).toContain(line);
    expect(refunded.html).toContain(line);
    expect(closed.text).toContain(line);
  });

  it('is not told when nothing was kept', () => {
    const { text } = buildReturnRefundedTemplate({
      orderId: 42,
      orderUrl,
      items: [{ name: 'Desk lamp', quantity: 1 }],
      amount: 10,
      currency: 'eur',
      supportEmail,
      withheldAmount: 0,
      withheldItems: [],
    });

    expect(text).not.toContain('We kept');
  });
});

describe('buildReturnChangedTemplate', () => {
  const base = { orderId: 42, code: 'W42-1', supportEmail, userName: 'Anna Koval' };

  // the person of a form without the code may not be the buyer: the mail tells neither who took the
  // goods over nor which they are
  it('tells the person of the statement its goods are handled in another statement, with the code', () => {
    const { subject, text, html } = buildReturnChangedTemplate({ ...base, allTaken: false });

    expect(subject).toBe('Cartlify — Your statement for order #42 changed (W42-1)');
    expect(text.startsWith('Hi Anna Koval,')).toBe(true);
    expect(text).toContain('Statement W42-1.');
    expect(text).toContain(
      'Some of the goods of your statement are now handled in another statement of this order',
    );
    expect(text).toContain('the rest of yours stays as it was');
    expect(text).not.toContain('buyer');
    expect(html).toContain('Statement W42-1');
    // no page: the person of a form without the code may have no account
    expect(text).not.toContain('https://');
  });

  it('says the statement is closed when every unit left it', () => {
    const { text, html } = buildReturnChangedTemplate({ ...base, allTaken: true });

    expect(text).toContain('All the goods of your statement are now handled in another statement');
    expect(text).toContain('yours is closed');
    expect(html).toContain('yours is closed');
  });

  it('escapes the name in the html', () => {
    const { html } = buildReturnChangedTemplate({
      ...base,
      allTaken: false,
      userName: '<b>Anna</b>',
    });

    expect(html).not.toContain('<b>Anna</b>');
    expect(html).toContain('&lt;b&gt;Anna&lt;/b&gt;');
  });
});

describe('buildReturnReimbursedTemplate', () => {
  it('tells the buyer what the shop paid back for sending the goods back, how and when', () => {
    const { subject, text, html } = buildReturnReimbursedTemplate({
      orderId: 42,
      orderUrl,
      amount: 6.5,
      currency: 'eur',
      method: 'cash',
      sentOn: new Date('2026-11-03T09:30:00Z'),
      supportEmail,
    });

    expect(subject).toBe('Cartlify — We paid back the cost of sending order #42 back');
    expect(text).toContain('We paid you back €6.50, the cost of sending the goods');
    expect(text).toContain('We sent it by cash on 3 November 2026.');
    expect(html).toContain('We sent it by cash on 3 November 2026.');
    expect(text).toContain(`Questions? Write to us in the chat on our site or to ${supportEmail}.`);
  });
});

describe('buildReturnClosedTemplate', () => {
  const base = {
    orderId: 42,
    orderUrl,
    refunded: [{ name: 'Desk lamp', quantity: 1 }],
    declined: [{ name: 'Notebook', quantity: 2, why: 'the package was opened' }],
    refundedAmount: '10',
    currency: 'eur',
    supportEmail,
  };

  it('lists what went back and what did not, with the reason of each refusal', () => {
    const { subject, text, html } = buildReturnClosedTemplate(base);

    expect(subject).toBe('Cartlify — Return of order #42 is closed');
    expect(text).toContain('€10.00 went back to you.');
    expect(text).toContain('Returned to you:\n- Desk lamp x 1');
    expect(text).toContain('Not returned:\n- Notebook x 2 (the package was opened)');
    expect(html).toContain('the package was opened');
  });

  it('says no money is returned when nothing went back, and leaves the list of the returned out', () => {
    const { text } = buildReturnClosedTemplate({ ...base, refunded: [], refundedAmount: 0 });

    expect(text).toContain('No money is returned for this statement.');
    expect(text).not.toContain('Returned to you:');
  });

  it('leaves the list of the declined out when every unit went back', () => {
    const { text } = buildReturnClosedTemplate({ ...base, declined: [] });

    expect(text).not.toContain('Not returned:');
  });

  it.each([
    ['buyer_changed_mind', 'You let us know that you no longer wish to return the goods.'],
    ['not_buyer', 'We could not match the statement to your purchase.'],
    ['goods_not_returned', 'We did not receive the goods back.'],
    ['other', 'The shop closed the statement.'],
  ])('tells the code %s in words, never the note of the shop', (code, words) => {
    const { text } = buildReturnClosedTemplate({ ...base, closeCode: code });

    expect(text).toContain(words);
  });

  it('says nothing of a code when the statement closed by itself', () => {
    expect(buildReturnClosedTemplate(base).text).not.toContain('The shop closed the statement.');
  });

  it('says the goods are handled in another statement for units a statement of the buyer took over', () => {
    expect(buildReturnClosedTemplate({ ...base, closeCode: 'stated_again' }).text).toContain(
      'The goods are handled in another statement of this order.',
    );
  });

  it('names no goods for a statement whose sender the shop did not check, the money and the code stay', () => {
    const { text, html } = buildReturnClosedTemplate({
      ...base,
      closeCode: 'not_buyer',
      hideItems: true,
    });

    for (const part of ['Desk lamp', 'Notebook', 'Returned to you:', 'Not returned:']) {
      expect(text).not.toContain(part);
      expect(html).not.toContain(part);
    }
    expect(text).toContain('€10.00 went back to you.');
    expect(text).toContain('We could not match the statement to your purchase.');
  });

  it('refuses a statement with no units at all', () => {
    expect(() => buildReturnClosedTemplate({ ...base, refunded: [], declined: [] })).toThrow(
      'ORDER_ITEMS_REQUIRED',
    );
  });
});

describe('buildReturnRefundFailedTemplate', () => {
  const base = { orderId: 42, orderUrl, amount: 25, currency: 'eur', supportEmail };

  it('says the money could not go to the card and that the shop will write about another way', () => {
    const { subject, text, html } = buildReturnRefundFailedTemplate(base);

    expect(subject).toBe('Cartlify — We could not return the money for order #42');
    expect(text).toContain('We could not return €25.00 for your Cartlify order #42');
    expect(text).toContain('We will contact you about another way to return it.');
    expect(html).toContain('€25.00');
  });

  it('tells a buyer told the money was returned that the bank of the card sent it back', () => {
    const sentBack = 'The money we returned earlier was sent back to us by the bank of the card';

    const back = buildReturnRefundFailedTemplate({ ...base, sentBack: true });
    const plain = buildReturnRefundFailedTemplate(base);

    expect(back.text).toContain(sentBack);
    expect(back.html).toContain(sentBack);
    expect(plain.text).not.toContain(sentBack);
    expect(plain.html).not.toContain(sentBack);
  });

  it('keeps the words of the provider out of the mail', () => {
    const { text } = buildReturnRefundFailedTemplate(base);

    expect(text).not.toMatch(/expired_or_canceled_card|lost_or_stolen_card/);
  });

  it('says where to write and links the order', () => {
    const { text, html } = buildReturnRefundFailedTemplate(base);

    expect(text).toContain(`Questions? Write to us in the chat on our site or to ${supportEmail}.`);
    expect(html).toContain(`href="${orderUrl}"`);
  });
});

describe('buildReturnReceivedTemplate', () => {
  const base = {
    orderId: 42,
    orderUrl,
    items: [{ name: 'Desk lamp', quantity: 2 }],
    statedAt: new Date('2026-11-02T10:05:00Z'),
    supportEmail,
    beforeShipment: false,
    returnAddress: 'Warehouse 5, 01001 Kyiv',
    sendBy: new Date('2026-11-16T10:05:00Z'),
    shippingPaidBy: 'buyer' as const,
  };

  it('is the notice of the statement with its date and time in utc, and lists what it names', () => {
    const { subject, text, html } = buildReturnReceivedTemplate(base);

    expect(subject).toBe('Cartlify — Withdrawal from order #42 registered');
    expect(text).toContain('on 2 November 2026 at 10:05 (UTC).');
    expect(text).toContain('- Desk lamp x 2');
    expect(html).toContain('2 November 2026 at 10:05 (UTC)');
  });

  // the time zone of the shop: the time of the statement names it, the day to send by is its day
  it('tells the dates in the zone of the shop and names it', () => {
    const { text } = buildReturnReceivedTemplate({
      ...base,
      timeZone: 'Europe/Kyiv',
      sendBy: new Date('2026-11-16T23:30:00Z'),
    });

    expect(text).toContain('on 2 November 2026 at 12:05 (Europe/Kyiv).');
    expect(text).toContain('17 November 2026');
  });

  it('tells a buyer whose goods were sent where to send them, by when, who pays and what to write after', () => {
    const { text } = buildReturnReceivedTemplate(base);

    expect(text).toContain('Please send the goods back to us.');
    expect(text).toContain('Send them to: Warehouse 5, 01001 Kyiv');
    expect(text).toContain('Send them back by 16 November 2026.');
    expect(text).toContain('You pay the carrier for sending them back.');
    expect(text).toContain('write the carrier and the number in your order');
  });

  // the account may be gone by the time the parcel is sent: the page of the code needs no sign-in
  it('gives a buyer of an account the page of the parcel too, for when the account is gone', () => {
    const proofUrl = 'https://shop.example.com/orders/42/withdrawal?return=7#ABCD-EFGH-JKLM';
    const { text, html } = buildReturnReceivedTemplate({ ...base, proofUrl });

    expect(text).toContain('write the carrier and the number in your order');
    expect(text).toContain('if you no longer have the account, on the page of this link:');
    expect(text).toContain(proofUrl);
    expect(html).toContain(`href="${proofUrl}"`);
    expect(html).toContain(`href="${orderUrl}"`);
  });

  it('gives no page of the parcel when the goods stay with the shop', () => {
    const proofUrl = 'https://shop.example.com/orders/42/withdrawal?return=7#ABCD-EFGH-JKLM';
    const { text } = buildReturnReceivedTemplate({ ...base, beforeShipment: true, proofUrl });

    expect(text).not.toContain(proofUrl);
  });

  it('says the shop pays the carrier when the contract says so, and nothing when it says nothing', () => {
    expect(buildReturnReceivedTemplate({ ...base, shippingPaidBy: 'shop' }).text).toContain(
      'We pay the carrier for sending them back',
    );
    expect(buildReturnReceivedTemplate({ ...base, shippingPaidBy: null }).text).not.toContain(
      'carrier for sending',
    );
  });

  it('leaves the address out when the shop published none', () => {
    expect(buildReturnReceivedTemplate({ ...base, returnAddress: null }).text).not.toContain(
      'Send them to',
    );
  });

  it('tells a buyer whose order was not sent that the goods stay and the money follows, with nothing to send', () => {
    const { text } = buildReturnReceivedTemplate({ ...base, beforeShipment: true });

    expect(text).toContain('Your order had not been sent, so the goods stay with us.');
    for (const part of ['Send them to', 'Send them back by', 'carrier', 'write the carrier']) {
      expect(text).not.toContain(part);
    }
  });

  it('says where to write, links the order and refuses no link or no items', () => {
    const { text, html } = buildReturnReceivedTemplate(base);

    expect(text).toContain(`Questions? Write to us in the chat on our site or to ${supportEmail}.`);
    expect(text).toContain(`See your order:\n${orderUrl}`);
    expect(html).toContain(`href="${orderUrl}"`);
    expect(html).toContain('View order');
    expect(() => buildReturnReceivedTemplate({ ...base, orderUrl: ' ' })).toThrow(
      'ORDER_URL_REQUIRED',
    );
    expect(() => buildReturnReceivedTemplate({ ...base, items: [] })).toThrow(
      'ORDER_ITEMS_REQUIRED',
    );
  });

  describe('for a statement of the public form', () => {
    const proofUrl = 'https://shop.example.com/orders/42/withdrawal?return=12#K7QM-4XTP-9RHD';
    const { orderUrl: _account, ...withoutOrder } = base;
    const form = { ...withoutOrder, publicForm: true, userName: 'Anna Koval' };

    it('links no order, greets by the name of the form and links the page of the parcel when it has the code', () => {
      const { text, html } = buildReturnReceivedTemplate({ ...form, proofUrl });

      expect(text.startsWith('Hi Anna Koval,')).toBe(true);
      expect(text).not.toContain('See your order');
      // the only link of the mail is the one of the parcel
      expect(text.match(/https:\/\/\S+/g)).toEqual([proofUrl]);
      expect(text).toContain('write the carrier and the number on the page of the link below');
      expect(text).toContain(`Tell us about the parcel here:\n${proofUrl}`);
      expect(html).toContain(`href="${proofUrl}"`);
      expect(html).toContain('Write the parcel');
      expect(html).not.toContain('View order');
    });

    it('has no link at all when the goods are not on their way back, or when it has no code', () => {
      for (const args of [{ ...form, proofUrl, beforeShipment: true }, { ...form }]) {
        const { text, html } = buildReturnReceivedTemplate(args);

        expect(text).not.toContain('https://');
        expect(html).not.toContain('Write the parcel');
        expect(html).not.toContain('View order');
        expect(text).toContain(
          `Questions? Write to us in the chat on our site or to ${supportEmail}.`,
        );
      }
    });

    it('tells a statement an admin checks by hand that nothing is sent yet, names no goods, and says whom to write if it was not them', () => {
      const { text, html } = buildReturnReceivedTemplate({ ...form, manualCheck: true, proofUrl });

      expect(text).toContain('Our team checks your statement against the order and writes to you.');
      expect(text).toContain('Please do not send anything until then.');
      expect(text).toContain('If you did not make this statement, write to us.');
      // anybody who knows the number of an order and the name of its recipient can send one: the
      // mail does not tell what the order holds
      expect(text).not.toContain('Desk lamp');
      expect(html).not.toContain('Desk lamp');
      expect(html).not.toContain('>Qty<');
      expect(() =>
        buildReturnReceivedTemplate({ ...form, manualCheck: true, items: [] }),
      ).not.toThrow();
      for (const part of ['Send them to', 'Send them back by', 'carrier', 'https://']) {
        expect(text).not.toContain(part);
      }
    });
  });
});
