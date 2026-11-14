import { describe, expect, it } from '@jest/globals';

import { buildReturnSentBackTemplate } from '@services/email/templates/returns/returnSentBack.template.js';

const orderUrl = 'https://shop.example.com/orders/42';
const supportEmail = 'support@shop.example.com';

// the mail of the goods the shop did not accept and sent back to the buyer: the units, the parcel
// they go in, where to write, and the order linked

const base = {
  orderId: 42,
  orderUrl,
  items: [
    { name: 'Desk lamp', quantity: 2 },
    { name: 'Notebook', quantity: 1 },
  ],
  carrier: 'DHL',
  trackingNumber: 'JD0146000900',
  supportEmail,
};

describe('buildReturnSentBackTemplate', () => {
  it('names the order in the subject and lists the units sent back in both versions', () => {
    const { subject, text, html } = buildReturnSentBackTemplate(base);

    expect(subject).toBe('Cartlify — We sent goods of order #42 back to you');
    expect(text).toContain(
      'We did not take back these goods of your Cartlify order #42, so we sent them back to you:',
    );
    expect(text).toContain('- Desk lamp x 2');
    expect(text).toContain('- Notebook x 1');
    expect(html).toContain('Desk lamp');
  });

  it('tells the carrier and the number of the parcel, and a link to follow it when there is one', () => {
    const plain = buildReturnSentBackTemplate(base);
    const linked = buildReturnSentBackTemplate({
      ...base,
      trackingUrl: 'https://track.example.com/JD0146000900',
    });

    expect(plain.text).toContain('The parcel goes with DHL, number JD0146000900.');
    expect(plain.text).not.toContain('Follow the parcel');
    expect(linked.text).toContain('Follow the parcel: https://track.example.com/JD0146000900');
    expect(linked.html).toContain('href="https://track.example.com/JD0146000900"');
  });

  it('names only the carrier of a parcel without a number, and no parcel at all without a carrier', () => {
    const carrierOnly = buildReturnSentBackTemplate({ ...base, trackingNumber: null });
    const none = buildReturnSentBackTemplate({ ...base, carrier: null, trackingNumber: null });

    expect(carrierOnly.text).toContain('The parcel goes with DHL.');
    expect(none.text).not.toContain('The parcel goes with');
  });

  it('names the statement, says where to write, links the order and greets by name when there is one', () => {
    const { subject, text, html } = buildReturnSentBackTemplate({
      ...base,
      code: 'W42-2',
      userName: 'Anna',
    });

    expect(subject.endsWith(' (W42-2)')).toBe(true);
    expect(text).toContain('Statement W42-2.');
    expect(text).toContain('Anna');
    expect(text).toContain(orderUrl);
    expect(html).toContain(`href="${orderUrl}"`);
    expect(text).toContain(`Questions? Write to us in the chat on our site or to ${supportEmail}.`);
  });

  it('refuses no order link and no units', () => {
    expect(() => buildReturnSentBackTemplate({ ...base, orderUrl: ' ' })).toThrow(
      'ORDER_URL_REQUIRED',
    );
    expect(() => buildReturnSentBackTemplate({ ...base, items: [] })).toThrow(
      'ORDER_ITEMS_REQUIRED',
    );
  });

  // the dictionary of the recipient's own language (src/locales), English unless told
  it('writes in the language given, English by default', () => {
    const uk = buildReturnSentBackTemplate({ ...base, locale: 'uk' });
    const es = buildReturnSentBackTemplate({ ...base, locale: 'es' });

    expect(uk.subject).toContain('надіслали вам назад товар');
    expect(uk.text).toContain('Посилку везе DHL, номер JD0146000900.');
    expect(es.subject).toContain('Te devolvimos productos');
    expect(es.text).toContain('El paquete va con DHL, número JD0146000900.');
  });
});
