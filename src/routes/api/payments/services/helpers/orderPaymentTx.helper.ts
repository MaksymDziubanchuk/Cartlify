import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { InternalError } from '@utils/errors.js';
import { PAYMENT_WEBHOOK_GRACE_MS } from '@routes/api/orders/services/helpers/index.js';

// answers of db pay_order function
const PAY_ORDER_RESULTS = [
  'PAID',
  'ALREADY_PAID_SAME_PAYMENT',
  'ALREADY_PAID_OTHER_PAYMENT',
  'ORDER_NOT_FOUND',
  'ORDER_NOT_PAYABLE',
  'AMOUNT_MISMATCH',
  'OUT_OF_STOCK',
] as const;

type PayOrderResult = (typeof PAY_ORDER_RESULTS)[number];

// answers that mean the order cannot take the money, so it must be returned
type PayOrderRefundReason = Exclude<PayOrderResult, 'PAID' | 'ALREADY_PAID_SAME_PAYMENT'>;

type PayOrderFromStripeWebhookArgs = {
  orderId: number;
  paymentIntentId: string;
  // decimal string in the same units as order total
  paidAmount: string;
};

type UnconfirmOrderFromStripeWebhookArgs = {
  orderId: number;
  // keep the reservation until the payment webhook grace window is over
  waitForPaymentGrace: boolean;
};

function isPayOrderResult(value: unknown): value is PayOrderResult {
  return typeof value === 'string' && (PAY_ORDER_RESULTS as readonly string[]).includes(value);
}

// finalize paid order from stripe webhook
async function payOrderFromStripeWebhook({
  orderId,
  paymentIntentId,
  paidAmount,
}: PayOrderFromStripeWebhookArgs): Promise<PayOrderResult> {
  return tx(
    async (db) => {
      // set admin context: pay_order is a system-side function and refuses any other context
      await setAdminContext(db);
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

      // db function decides everything under row locks:
      // - waiting order with active reservation is paid from reserved stock
      // - order that lost its reservation is paid only when every item is still in stock
      // - already paid order answers whether it is the same payment or another one
      // - anything else answers why the order cannot take the money
      const rows = await db.$queryRaw<{ result: string | null }[]>`
        select cartlify.pay_order(
          ${orderId}::int,
          ${paymentIntentId},
          ${paidAmount}::numeric
        ) as result
      `;

      const result = rows[0]?.result;

      // require known answer from db function
      if (!isPayOrderResult(result)) {
        throw new InternalError({
          reason: 'STRIPE_PAY_ORDER_RESULT_UNKNOWN',
          orderId,
          result,
        });
      }

      return result;
    },
    {
      maxRetries: 3,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 1500,
      timeout: 10_000,
    },
  );
}

// unconfirm waiting order from stripe webhook
async function unconfirmOrderFromStripeWebhook({
  orderId,
  waitForPaymentGrace,
}: UnconfirmOrderFromStripeWebhookArgs): Promise<{ unconfirmedNow: boolean; orderFound: boolean }> {
  return tx(
    async (db) => {
      // set admin context for system-side order read
      await setAdminContext(db);
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

      // load current order state
      const order = await db.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          status: true,
          confirmed: true,
          reservationExpiresAt: true,
        },
      });

      // order is already deleted by its owner: nothing to unconfirm
      // this is not a failure, an error answer would make stripe redeliver the same event for days
      if (!order) {
        return { unconfirmedNow: false as const, orderFound: false as const };
      }

      // skip already paid order
      if (order.status === 'paid') {
        return { unconfirmedNow: false as const, orderFound: true as const };
      }

      // skip order that no longer needs unconfirm
      if (!order.confirmed || order.status !== 'waiting') {
        return { unconfirmedNow: false as const, orderFound: true as const };
      }

      // keep the reservation until the payment webhook grace window is over
      // worker closes the stripe session right at reservation end and stripe reports it at once,
      // while a payment made at the last moment can still be on its way: it must find the stock reserved
      // an event from an old session of a re-confirmed order is skipped the same way, its reservation is still running
      // the reservation itself is released by the order timeout worker after the same window
      if (
        waitForPaymentGrace &&
        order.reservationExpiresAt &&
        Date.now() <= order.reservationExpiresAt.getTime() + PAYMENT_WEBHOOK_GRACE_MS
      ) {
        return { unconfirmedNow: false as const, orderFound: true as const };
      }

      // keep admin context: unconfirm_order is a system-side function and refuses any other context
      await db.$executeRaw`select cartlify.unconfirm_order(${orderId}::int)`;

      return { unconfirmedNow: true as const, orderFound: true as const };
    },
    {
      maxRetries: 3,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 1500,
      timeout: 10_000,
    },
  );
}

export { payOrderFromStripeWebhook, unconfirmOrderFromStripeWebhook };
export type { PayOrderResult, PayOrderRefundReason };
