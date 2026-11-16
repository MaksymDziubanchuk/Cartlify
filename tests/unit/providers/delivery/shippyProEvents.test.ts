import { describe, expect, it } from '@jest/globals';

import { readShippyProEvents } from '@providers/delivery/shippypro/shippyProEvents.js';

import { shippyProWebhookBody } from '../../../helpers/shippyPro.js';

// the moment of an event of ShippyPro: its date in seconds, or the time the event came when it
// gives none a date can be
const RECEIVED = new Date('2026-11-16T10:00:00.000Z');
const parcel = { parcelId: '1234', reference: '7-1', trackingNumber: 'TN1' };
const atOf = (date: number) =>
  readShippyProEvents(shippyProWebhookBody('tracking', parcel, { date }), RECEIVED)?.[0]?.at;

describe('the moment of an event of ShippyPro', () => {
  it('is the date of the event', () => {
    expect(atOf(1_794_800_000)).toEqual(new Date(1_794_800_000_000));
  });

  it('is the time the event came when its date is none a date can be', () => {
    expect(atOf(100_000_000_000_000_000)).toEqual(RECEIVED);
  });

  it('is the time the event came for a date of a year of five digits: milliseconds sent as seconds', () => {
    expect(atOf(1_794_800_000_000)).toEqual(RECEIVED);
  });
});

describe('the kind of an event of ShippyPro', () => {
  const kindOf = (body: Record<string, unknown>) =>
    readShippyProEvents(body, RECEIVED)?.[0]?.kind ?? null;
  const byCode = (code: number) =>
    kindOf(shippyProWebhookBody('tracking', parcel, { code, extendedCode: null }));

  it('reads its code when it has no extended code: on the way, at the courier, a failed attempt, delivered', () => {
    expect([2, 3, 4, 6, 1].map(byCode)).toEqual([
      'collected',
      'collected',
      'collected',
      'delivered',
      null,
    ]);
  });

  it('has none for an event the shop does not act on', () => {
    expect(kindOf({ Event: 'ORDER_ARCHIVED', OrderID: 1234, TransactionID: '7-1' })).toBeNull();
  });
});
