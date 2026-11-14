import { describe, expect, it } from '@jest/globals';

import {
  centsOfAmount,
  lateRefundKeyOf,
} from '@routes/api/payments/services/helpers/lateRefundKey.helper.js';

// the key of the request of the refund of a payment the order could not take: the provider keeps it
// as the key of its idempotency and in the metadata of the refund, so asking again with it gives the
// one refund. The first refund of a payment has one key; a refund of what is left after money went
// back another way (by hand in the dashboard, a dispute the shop lost) names the cents it is for, so
// it is a new request and never the first one again

describe('lateRefundKeyOf', () => {
  it('names the payment for the first refund', () => {
    expect(lateRefundKeyOf('pi_3QxYz')).toBe('refund:pi_3QxYz');
  });

  it('names the payment and the cents left for a refund of what is left', () => {
    expect(lateRefundKeyOf('pi_3QxYz', 2550)).toBe('refund:pi_3QxYz:2550');
  });

  it('gives another key for another sum left, and the same for the same', () => {
    expect(lateRefundKeyOf('pi_1', 100)).not.toBe(lateRefundKeyOf('pi_1', 101));
    expect(lateRefundKeyOf('pi_1', 100)).toBe(lateRefundKeyOf('pi_1', 100));
  });
});

describe('centsOfAmount', () => {
  it.each([
    ['51.00', 5100],
    ['10.15', 1015],
    ['0.01', 1],
    ['7', 700],
    ['7.5', 750],
    ['-25.50', -2550],
  ])('reads %s as %i cents without float math', (amount, cents) => {
    expect(centsOfAmount(amount)).toBe(cents);
  });

  it.each(['', 'abc', '1.234', '1,50', '--1', ' 1.00'])('refuses %p', (amount) => {
    let thrown: unknown;
    try {
      centsOfAmount(amount);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ details: { reason: 'MONEY_AMOUNT_INVALID', amount } });
  });
});
