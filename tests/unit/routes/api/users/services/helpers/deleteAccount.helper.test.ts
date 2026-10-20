import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { PaymentPageCloseResult } from '@routes/api/payments/providers/types.js';

// closing the payment page of an order the deletion cancelled: redis keeps the link from the order
// to its page, the provider that opened the page closes it and tells what happened to the money.
// Both are replaced here; how stripe answers is in its provider tests, the real calls in the
// payments tests
const isRedisReady = jest.fn<() => boolean>();
const cancelOrderReservationExpiry = jest.fn<(orderId: number) => Promise<void>>();
const getOrderPaymentPageLink =
  jest.fn<(orderId: number) => Promise<{ provider: 'stripe'; pageId: string } | null>>();
const deleteOrderPaymentPageLink = jest.fn<(orderId: number) => Promise<void>>();
const closePaymentPage = jest.fn<(pageId: string) => Promise<PaymentPageCloseResult>>();
const getPaymentProvider = jest.fn<(name: string) => { closePaymentPage: typeof closePaymentPage }>(
  () => ({ closePaymentPage }),
);

jest.unstable_mockModule('@redis/client.js', () => ({ isRedisReady }));
jest.unstable_mockModule('@routes/api/orders/services/helpers/orderTimeoutQueue.helper.js', () => ({
  cancelOrderReservationExpiry,
  getOrderPaymentPageLink,
  deleteOrderPaymentPageLink,
}));
jest.unstable_mockModule('@routes/api/payments/providers/index.js', () => ({
  getPaymentProvider,
  // the mail of the deletion names the money of the shop
  shopCurrency: () => 'eur',
}));

const { closeCheckoutOf } =
  await import('@routes/api/users/services/helpers/deleteAccount.helper.js');

const log = () => ({ warn: jest.fn(), error: jest.fn() });

beforeEach(() => {
  for (const mock of [
    isRedisReady,
    cancelOrderReservationExpiry,
    getOrderPaymentPageLink,
    deleteOrderPaymentPageLink,
    closePaymentPage,
    getPaymentProvider,
  ]) {
    mock.mockClear();
  }
  isRedisReady.mockReturnValue(true);
  cancelOrderReservationExpiry.mockResolvedValue(undefined);
  getOrderPaymentPageLink.mockResolvedValue({ provider: 'stripe', pageId: 'cs_test_1' });
  deleteOrderPaymentPageLink.mockResolvedValue(undefined);
  closePaymentPage.mockResolvedValue({ state: 'closed' });
});

describe('closeCheckoutOf', () => {
  it('closes the payment page: no money was taken, the timer and the link go', async () => {
    const logger = log();

    expect(await closeCheckoutOf(7, logger)).toBe('not_taken');

    expect(cancelOrderReservationExpiry).toHaveBeenCalledWith(7);
    expect(getPaymentProvider).toHaveBeenCalledWith('stripe');
    expect(closePaymentPage).toHaveBeenCalledWith('cs_test_1');
    expect(deleteOrderPaymentPageLink).toHaveBeenCalledWith(7);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // a page that is already paid cannot be closed; the order is gone, the payment event refunds it
  it('tells a payment that got through before the page was closed: it is refunded', async () => {
    closePaymentPage.mockResolvedValue({ state: 'paid' });

    expect(await closeCheckoutOf(7, log())).toBe('refunding');
    expect(deleteOrderPaymentPageLink).not.toHaveBeenCalled();
  });

  // a bank debit completes the page before the bank says yes or no: nothing is known yet
  it.each([
    ['a payment the bank has not decided on', { state: 'in_progress' }],
    ['a page the provider did not close', { state: 'open', cause: new Error('not closed') }],
  ] as const)('says nothing for sure about %s and warns', async (_case, closed) => {
    closePaymentPage.mockResolvedValue(closed);
    const logger = log();

    expect(await closeCheckoutOf(7, logger)).toBe('unknown');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 7, provider: 'stripe', state: closed.state }),
      'payment page of a cancelled order was not closed',
    );
    expect(deleteOrderPaymentPageLink).not.toHaveBeenCalled();
  });

  // the order may never have reached the payment page, or redis lost the link
  it('says nothing for sure when the order has no linked payment page', async () => {
    getOrderPaymentPageLink.mockResolvedValue(null);

    expect(await closeCheckoutOf(7, log())).toBe('unknown');
    expect(closePaymentPage).not.toHaveBeenCalled();
  });

  it('says nothing for sure and asks nobody while redis is down', async () => {
    isRedisReady.mockReturnValue(false);

    expect(await closeCheckoutOf(7, log())).toBe('unknown');
    expect(getOrderPaymentPageLink).not.toHaveBeenCalled();
    expect(closePaymentPage).not.toHaveBeenCalled();
  });

  it.each([
    ['redis fails', () => getOrderPaymentPageLink.mockRejectedValue(new Error('redis'))],
    [
      'the provider cannot be asked',
      () => closePaymentPage.mockRejectedValue(new Error('PAYMENT_PROVIDER_UNAVAILABLE')),
    ],
  ])(
    'never throws when %s: the deletion is done, the failure is logged',
    async (_case, arrange) => {
      arrange();
      const logger = log();

      expect(await closeCheckoutOf(7, logger)).toBe('unknown');
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: 7 }),
        'payment page of a cancelled order was not closed',
      );
    },
  );
});
