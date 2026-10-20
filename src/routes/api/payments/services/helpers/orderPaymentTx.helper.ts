import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { InternalError } from '@utils/errors.js';
import { PAYMENT_WEBHOOK_GRACE_MS } from '@routes/api/orders/services/helpers/index.js';

import type { PaymentProviderName } from '../../providers/types.js';

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

type PayOrderArgs = {
  // who took the money and the id of the payment there
  provider: PaymentProviderName;
  paymentId: string;
  orderId: number;
  // decimal string in the same units as order total
  paidAmount: string;
};

type UnconfirmOrderFromWebhookArgs = {
  orderId: number;
  // keep the reservation until the payment webhook grace window is over
  waitForPaymentGrace: boolean;
};

function isPayOrderResult(value: unknown): value is PayOrderResult {
  return typeof value === 'string' && (PAY_ORDER_RESULTS as readonly string[]).includes(value);
}

// record a payment a provider reported for the order
async function payOrder({
  provider,
  paymentId,
  orderId,
  paidAmount,
}: PayOrderArgs): Promise<PayOrderResult> {
  return tx(
    async (db) => {
      // set admin context: pay_order is a system-side function and refuses any other context
      await setAdminContext(db);
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

      // db function decides everything under row locks:
      // - waiting order with active reservation is paid from reserved stock
      // - order that lost its reservation is paid only when every item is still in stock
      // - an order whose payment is recorded answers whether it is the same payment (the same
      //   provider and id) or another one, also after it was shipped, delivered or cancelled
      // - anything else answers why the order cannot take the money
      const rows = await db.$queryRaw<{ result: string | null }[]>`
        select cartlify.pay_order(
          ${orderId}::int,
          ${provider}::cartlify."PaymentProvider",
          ${paymentId},
          ${paidAmount}::numeric
        ) as result
      `;

      const result = rows[0]?.result;

      // require known answer from db function
      if (!isPayOrderResult(result)) {
        throw new InternalError({
          reason: 'PAY_ORDER_RESULT_UNKNOWN',
          provider,
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

// unconfirm a waiting order whose payment page a provider reported closed or failed
async function unconfirmOrderFromWebhook({
  orderId,
  waitForPaymentGrace,
}: UnconfirmOrderFromWebhookArgs): Promise<{ unconfirmedNow: boolean; orderFound: boolean }> {
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
      // this is not a failure, an error answer would make the provider deliver the same event again
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
      // worker closes the payment page right at reservation end and the provider reports it at once,
      // while a payment made at the last moment can still be on its way: it must find the stock reserved
      // an event of an old page of a re-confirmed order is skipped the same way, its reservation is still running
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

export { payOrder, unconfirmOrderFromWebhook };
export type { PayOrderResult, PayOrderRefundReason };
