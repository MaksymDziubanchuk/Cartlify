import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// closing the payment page of an order the deletion cancelled: redis keeps the link from the order
// to its page, stripe closes it and tells what happened to the money. Both are replaced here, the
// real calls need the stripe test account (payments tests)
const isRedisReady = jest.fn<() => boolean>();
const cancelOrderReservationExpiry = jest.fn<(orderId: number) => Promise<void>>();
const getOrderPaymentSessionLink = jest.fn<(orderId: number) => Promise<string | null>>();
const deleteOrderPaymentSessionLink = jest.fn<(orderId: number) => Promise<void>>();
const expireCheckoutSession = jest.fn<(args: { sessionId: string }) => Promise<void>>();
const readCheckoutSessionStatus =
  jest.fn<
    (sessionId: string) => Promise<{ status: 'open' | 'complete' | 'expired'; paid: boolean }>
  >();

jest.unstable_mockModule('@redis/client.js', () => ({ isRedisReady }));
jest.unstable_mockModule('@routes/api/orders/services/helpers/orderTimeoutQueue.helper.js', () => ({
  cancelOrderReservationExpiry,
  getOrderPaymentSessionLink,
  deleteOrderPaymentSessionLink,
}));
jest.unstable_mockModule('@routes/api/payments/services/helpers/checkoutSession.helper.js', () => ({
  expireCheckoutSession,
  readCheckoutSessionStatus,
}));

const { closeCheckoutOf } =
  await import('@routes/api/users/services/helpers/deleteAccount.helper.js');

const log = () => ({ warn: jest.fn(), error: jest.fn() });

beforeEach(() => {
  for (const mock of [
    isRedisReady,
    cancelOrderReservationExpiry,
    getOrderPaymentSessionLink,
    deleteOrderPaymentSessionLink,
    expireCheckoutSession,
    readCheckoutSessionStatus,
  ]) {
    mock.mockReset();
  }
  isRedisReady.mockReturnValue(true);
  cancelOrderReservationExpiry.mockResolvedValue(undefined);
  getOrderPaymentSessionLink.mockResolvedValue('cs_test_1');
  deleteOrderPaymentSessionLink.mockResolvedValue(undefined);
  expireCheckoutSession.mockResolvedValue(undefined);
});

describe('closeCheckoutOf', () => {
  it('closes the payment page: no money was taken, the timer and the link go', async () => {
    const logger = log();

    expect(await closeCheckoutOf(7, logger)).toBe('not_taken');

    expect(cancelOrderReservationExpiry).toHaveBeenCalledWith(7);
    expect(expireCheckoutSession).toHaveBeenCalledWith({ sessionId: 'cs_test_1' });
    expect(deleteOrderPaymentSessionLink).toHaveBeenCalledWith(7);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // stripe refuses to close a page that is already paid; the order is gone, the webhook refunds
  it('tells a payment that got through before the page was closed: it is refunded', async () => {
    expireCheckoutSession.mockRejectedValue(new Error('only open sessions can be expired'));
    readCheckoutSessionStatus.mockResolvedValue({ status: 'complete', paid: true });

    expect(await closeCheckoutOf(7, log())).toBe('refunding');
    expect(readCheckoutSessionStatus).toHaveBeenCalledWith('cs_test_1');
  });

  it('counts a page that was already closed as no money taken', async () => {
    expireCheckoutSession.mockRejectedValue(new Error('already expired'));
    readCheckoutSessionStatus.mockResolvedValue({ status: 'expired', paid: false });

    expect(await closeCheckoutOf(7, log())).toBe('not_taken');
    expect(deleteOrderPaymentSessionLink).toHaveBeenCalledWith(7);
  });

  // a bank debit completes the page before the bank says yes or no: nothing is known yet
  it.each([
    [
      'a complete page whose payment the bank has not confirmed',
      { status: 'complete', paid: false },
    ],
    ['a page that stayed open', { status: 'open', paid: false }],
  ] as const)('says nothing for sure about %s and warns', async (_case, state) => {
    expireCheckoutSession.mockRejectedValue(new Error('not closed'));
    readCheckoutSessionStatus.mockResolvedValue(state);
    const logger = log();

    expect(await closeCheckoutOf(7, logger)).toBe('unknown');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 7, status: state.status }),
      'payment page of a cancelled order was not closed',
    );
  });

  // the order may never have reached the payment page, or redis lost the link
  it('says nothing for sure when the order has no linked payment page', async () => {
    getOrderPaymentSessionLink.mockResolvedValue(null);

    expect(await closeCheckoutOf(7, log())).toBe('unknown');
    expect(expireCheckoutSession).not.toHaveBeenCalled();
  });

  it('says nothing for sure and asks nobody while redis is down', async () => {
    isRedisReady.mockReturnValue(false);

    expect(await closeCheckoutOf(7, log())).toBe('unknown');
    expect(getOrderPaymentSessionLink).not.toHaveBeenCalled();
    expect(expireCheckoutSession).not.toHaveBeenCalled();
  });

  it.each([
    ['redis fails', () => getOrderPaymentSessionLink.mockRejectedValue(new Error('redis'))],
    [
      'stripe cannot be read either',
      () => {
        expireCheckoutSession.mockRejectedValue(new Error('stripe'));
        readCheckoutSessionStatus.mockRejectedValue(new Error('stripe'));
      },
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
