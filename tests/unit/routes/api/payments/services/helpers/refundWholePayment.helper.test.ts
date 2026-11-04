import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { stripeProvider } from '@routes/api/payments/providers/stripe/stripe.provider.js';
import { refundWholePayment } from '@routes/api/payments/services/helpers/refundWholePayment.helper.js';

import { rejectedBy } from '../../../../../../helpers/errors.js';

// the whole payment of an order given back at once, for the two places that return all of it: a
// payment the order could not take, and the cancel of a paid order. One key per payment, so a
// delivery of the event again or a second click gives the money back once

afterEach(() => {
  jest.restoreAllMocks();
});

const args = { provider: 'stripe', paymentId: 'pi_test_1', orderId: 12, amount: '25.00' } as const;

describe('refundWholePayment', () => {
  it('asks the provider for the whole amount with one key per payment', async () => {
    const refund = jest
      .spyOn(stripeProvider, 'refundPayment')
      .mockResolvedValue({ refundId: 're_1', status: 'succeeded' });

    expect(await refundWholePayment(args)).toEqual({ refundId: 're_1' });
    expect(refund).toHaveBeenCalledWith({
      orderId: 12,
      paymentId: 'pi_test_1',
      amount: '25.00',
      key: 'refund:pi_test_1',
    });
  });

  // a refund that is on its way counts as made: the bank of the card takes a few days
  it('takes a refund that is on its way as made', async () => {
    jest
      .spyOn(stripeProvider, 'refundPayment')
      .mockResolvedValue({ refundId: 're_2', status: 'pending' });

    expect(await refundWholePayment(args)).toEqual({ refundId: 're_2' });
  });

  it('answers no refund for a payment that was refunded before', async () => {
    jest.spyOn(stripeProvider, 'refundPayment').mockResolvedValue({
      refundId: null,
      status: 'failed',
      failure: 'unknown',
      failureText: 'refunded',
      alreadyRefunded: true,
    });

    expect(await refundWholePayment(args)).toEqual({ refundId: null });
  });

  // the money did not go back: the order must not become cancelled, the event must come again
  it('fails with PAYMENT_REFUND_FAILED when the money did not go back', async () => {
    jest.spyOn(stripeProvider, 'refundPayment').mockResolvedValue({
      refundId: 're_3',
      status: 'failed',
      failure: 'card_unavailable',
      failureText: 'expired_or_canceled_card',
    });

    expect(await rejectedBy(() => refundWholePayment(args))).toMatchObject({
      details: {
        reason: 'PAYMENT_REFUND_FAILED',
        provider: 'stripe',
        paymentId: 'pi_test_1',
        orderId: 12,
        refundId: 're_3',
        refundStatus: 'failed',
      },
    });
  });

  it('fails with PAYMENT_REFUND_FAILED when the provider does not answer: the same key asks again later', async () => {
    jest
      .spyOn(stripeProvider, 'refundPayment')
      .mockResolvedValue({ refundId: null, status: 'pending' });

    expect(await rejectedBy(() => refundWholePayment(args))).toMatchObject({
      details: { reason: 'PAYMENT_REFUND_FAILED', refundId: null, refundStatus: 'pending' },
    });
  });
});
