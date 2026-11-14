import { isRedisReady } from '@redis/client.js';
import {
  cancelOrderReservationExpiry,
  deleteOrderPaymentPageLink,
} from '@routes/api/orders/services/helpers/orderTimeoutQueue.helper.js';

import { isLatePayment } from './latePayments.helper.js';
import { refundLatePayment } from './orderPaymentRefund.helper.js';
import { payOrder } from './orderPaymentTx.helper.js';
import { sendOrderPaidEmail } from './sendOrderPaidEmail.helper.js';

import type { PaidPage, PaymentProviderName } from '../../providers/types.js';
import type { PaymentRefundMailLogger } from './paymentRefundMails.helper.js';

// the page was settled before: the payment is one the order could not take and its money goes
// back (or went back), the order never takes it
export type SettledPaidPage = { skipped?: 'REFUNDED' };

// nothing waits for a paid order: its reservation timers and the link of its page go. A leftover
// timer is harmless (it touches only a waiting order), so redis, down or dropping the connection
// in the middle, never fails a payment that is recorded: the error answer would make the provider
// deliver the event again, that delivery is a repeated one and the buyer would never get the mail
async function dropPaidOrderTimers(orderId: number, log: PaymentRefundMailLogger): Promise<void> {
  if (!isRedisReady()) return;

  try {
    await cancelOrderReservationExpiry(orderId);
    await deleteOrderPaymentPageLink(orderId);
  } catch (err) {
    log.warn(
      { orderId, err: { code: (err as { code?: unknown })?.code } },
      'paid order cleanup in redis failed, its timers stay until they run out',
    );
  }
}

// The money of a payment page is taken: the one step for the payment event of the provider and for
// the reservation timer that found the page paid while its event did not come (the data of the page
// read from the provider either way). The database decides what the payment means for the order
// (pay_order): paid now (the timers go, the buyer is mailed once), the same payment again (what a
// failed cleanup left goes now), or the order cannot take the money and it goes back (a late
// payment). A payment recorded as late is never offered to the order again: a later delivery of
// its event must not sell the order, also when the stock came back meanwhile. A technical failure
// throws, so the event is delivered again or the timer runs again
export async function settlePaidPage(
  provider: PaymentProviderName,
  page: PaidPage,
  log: PaymentRefundMailLogger,
): Promise<SettledPaidPage> {
  if (await isLatePayment(page.paymentId)) return { skipped: 'REFUNDED' };

  const result = await payOrder({
    provider,
    paymentId: page.paymentId,
    orderId: page.orderId,
    paidAmount: page.amount,
    currency: page.currency,
  });

  if (result === 'PAID') {
    await dropPaidOrderTimers(page.orderId, log);

    // the payment is committed; the mail never fails the payment, a failure is only logged. A
    // repeated delivery answers ALREADY_PAID_SAME_PAYMENT, so the buyer gets one mail
    await sendOrderPaidEmail(page.orderId, log);
    return {};
  }

  if (result === 'ALREADY_PAID_SAME_PAYMENT') {
    await dropPaidOrderTimers(page.orderId, log);
    return {};
  }

  // every other answer means the order cannot take this money, so it goes back in full: paid by
  // another payment, cannot be paid, the amount differs from the items, out of stock, the order is gone
  await refundLatePayment(
    {
      provider,
      paymentId: page.paymentId,
      orderId: page.orderId,
      fallbackUserId: page.userId,
      reason: result,
      amount: page.amount,
      currency: page.currency,
    },
    log,
  );
  return {};
}
