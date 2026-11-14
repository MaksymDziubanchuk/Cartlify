import { describe, expect, it } from '@jest/globals';

import {
  disputeEvidenceOf,
  type DisputeFacts,
} from '@routes/api/payments/services/helpers/disputeEvidence.helper.js';

// The draft of the evidence the app puts on a dispute:
// the order and its items, the delivery (the carrier, the number, when it was sent and
// delivered), the refunds of the payment (the day, the sum, the number of the provider) and the
// statement of return, if there is one (the day, what became of the goods). A person reads it in the
// dashboard of the provider and submits it: nothing of the shop's own (notes, keys, ids of its
// journals) is in it, only what the facts give

const facts = (overrides: Partial<DisputeFacts> = {}): DisputeFacts => ({
  orderId: 42,
  late: false,
  paidAt: new Date('2026-11-01T10:00:00.000Z'),
  total: '25.00',
  currency: 'eur',
  items: [
    { name: 'Desk lamp', quantity: 2, unitPrice: '10.00' },
    { name: 'Lamp bulb', quantity: 1, unitPrice: '0.00' },
  ],
  deliveryPrice: '5.00',
  customer: { name: 'Anna Koval', email: 'anna@example.com' },
  shipments: [],
  refunds: [],
  statements: [],
  ...overrides,
});

describe('disputeEvidenceOf', () => {
  it('describes the order, its items, the delivery and the total', () => {
    const evidence = disputeEvidenceOf(facts());

    expect(evidence.productDescription).toBe(
      'Order #42, paid on 2026-11-01: 2 x Desk lamp at 10.00 EUR; 1 x Lamp bulb at 0.00 EUR; ' +
        'delivery 5.00 EUR; total 25.00 EUR.',
    );
    expect(evidence.customerName).toBe('Anna Koval');
    expect(evidence.customerEmailAddress).toBe('anna@example.com');
  });

  it('leaves out the delivery when it was free, and the buyer it does not know', () => {
    const evidence = disputeEvidenceOf(
      facts({ deliveryPrice: '0.00', customer: { name: null, email: null } }),
    );

    expect(evidence.productDescription).not.toContain('delivery');
    expect(evidence).not.toHaveProperty('customerName');
    expect(evidence).not.toHaveProperty('customerEmailAddress');
  });

  it('gives the send of the order: the carrier, the number, the day it was sent and delivered', () => {
    const evidence = disputeEvidenceOf(
      facts({
        shipments: [
          {
            carrier: 'DHL',
            trackingNumber: 'JD0146000123',
            shippedAt: new Date('2026-11-02T09:00:00.000Z'),
            deliveredAt: new Date('2026-11-04T15:00:00.000Z'),
          },
        ],
      }),
    );

    expect(evidence).toMatchObject({
      shippingCarrier: 'DHL',
      shippingTrackingNumber: 'JD0146000123',
      shippingDate: '2026-11-02',
    });
    expect(evidence.uncategorizedText).toContain('Delivered on 2026-11-04.');
  });

  it('says the order was not sent yet when it was not', () => {
    const evidence = disputeEvidenceOf(facts());

    expect(evidence).not.toHaveProperty('shippingCarrier');
    expect(evidence.uncategorizedText).toContain('The order was not sent.');
  });

  it('lists the refunds of the payment with their day, sum and number at the provider', () => {
    const evidence = disputeEvidenceOf(
      facts({
        refunds: [
          {
            at: new Date('2026-11-03T08:00:00.000Z'),
            amount: '10.00',
            refundId: 're_3QxYzHand',
            state: 'sent',
          },
        ],
      }),
    );

    expect(evidence.uncategorizedText).toContain(
      'Refunds of this payment: 2026-11-03, 10.00 EUR, re_3QxYzHand (sent).',
    );
  });

  it('says when nothing of the payment was refunded', () => {
    expect(disputeEvidenceOf(facts()).uncategorizedText).toContain(
      'No refund of this payment was made.',
    );
  });

  it('tells the statement of return with what became of its goods and money', () => {
    const evidence = disputeEvidenceOf(
      facts({
        statements: [
          {
            code: 'W42-1',
            statedAt: new Date('2026-11-05T12:00:00.000Z'),
            rows: [{ name: 'Desk lamp', quantity: 2, goods: 'to_stock', money: 'not_refunded' }],
          },
        ],
      }),
    );

    expect(evidence.uncategorizedText).toContain(
      'Statement of return W42-1 of 2026-11-05: 2 x Desk lamp, goods received, money not sent yet.',
    );
  });

  it('tells a payment the order could not take', () => {
    const evidence = disputeEvidenceOf(facts({ late: true }));

    expect(evidence.uncategorizedText).toContain(
      'This payment came after the order could no longer take it: it is not the payment of the order, the shop gives it back.',
    );
  });

  it('keeps each text within what the provider takes', () => {
    const many = Array.from({ length: 3000 }, (_, i) => ({
      name: `Item ${i} with a long name`,
      quantity: 1,
      unitPrice: '1.00',
    }));

    const evidence = disputeEvidenceOf(facts({ items: many }));

    expect(evidence.productDescription!.length).toBeLessThanOrEqual(20_000);
    expect(evidence.productDescription!.endsWith('…')).toBe(true);
  });
});
