import { describe, expect, it } from '@jest/globals';

import { buildReturnSplitTemplate } from '@services/email/templates/returns/returnSplit.template.js';

const orderUrl = 'https://shop.example.com/orders/42';
const supportEmail = 'support@shop.example.com';

// the mail of the goods that left a statement for one of their own: they go back in a parcel of
// their own, the new code names them, and the buyer tells of that parcel for it

const base = {
  orderId: 42,
  orderUrl,
  code: 'W42-2',
  fromCode: 'W42-1',
  items: [{ name: 'Desk lamp', quantity: 2 }],
  supportEmail,
};

describe('buildReturnSplitTemplate', () => {
  it('names the new statement in the subject and the text, and the one the goods left', () => {
    const { subject, text, html } = buildReturnSplitTemplate(base);

    expect(subject).toBe('Cartlify — A statement of its own for goods of order #42 (W42-2)');
    expect(text).toContain('Statement W42-2.');
    expect(text).toContain(
      'These goods of your Cartlify order #42 are not in the parcel of statement W42-1, so they have a statement of their own:',
    );
    expect(html).toContain('W42-1');
  });

  it('lists the units and asks for a parcel of their own', () => {
    const { text, html } = buildReturnSplitTemplate(base);

    expect(text).toContain('- Desk lamp x 2');
    expect(text).toContain(
      'Send them back in a parcel of their own and tell us its carrier and number for this statement on the page of the order.',
    );
    expect(html).toContain('Desk lamp');
  });

  it('says where to write, links the order and greets by name when there is one', () => {
    const { text, html } = buildReturnSplitTemplate({ ...base, userName: 'Anna' });

    expect(text).toContain('Anna');
    expect(text).toContain(orderUrl);
    expect(html).toContain(`href="${orderUrl}"`);
    expect(text).toContain(`Questions? Write to us in the chat on our site or to ${supportEmail}.`);
  });

  it('refuses no order link, no codes and no units', () => {
    expect(() => buildReturnSplitTemplate({ ...base, orderUrl: ' ' })).toThrow(
      'ORDER_URL_REQUIRED',
    );
    expect(() => buildReturnSplitTemplate({ ...base, code: ' ' })).toThrow('RETURN_CODE_REQUIRED');
    expect(() => buildReturnSplitTemplate({ ...base, fromCode: '' })).toThrow(
      'RETURN_CODE_REQUIRED',
    );
    expect(() => buildReturnSplitTemplate({ ...base, items: [] })).toThrow('ORDER_ITEMS_REQUIRED');
  });

  // the dictionary of the recipient's own language (src/locales), English unless told
  it('writes in the language given, English by default', () => {
    const uk = buildReturnSplitTemplate({ ...base, locale: 'uk' });
    const es = buildReturnSplitTemplate({ ...base, locale: 'es' });

    expect(uk.subject).toContain('Окрема заява для товару замовлення #42');
    expect(uk.text).toContain('не в посилці заяви W42-1');
    expect(es.subject).toContain('Una declaración propia para productos del pedido #42');
    expect(es.text).toContain('no están en el paquete de la declaración W42-1');
  });
});
