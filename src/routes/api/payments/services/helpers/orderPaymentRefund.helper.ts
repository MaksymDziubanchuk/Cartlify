import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import stripe from '@config/stripe.js';
import { InternalError } from '@utils/errors.js';

import type { PayOrderRefundReason } from './orderPaymentTx.helper.js';

type RefundOrderPaymentArgs = {
  orderId: number;
  // order owner from checkout metadata, used when the order row is already deleted
  fallbackUserId: number | null;
  paymentIntentId: string;
  reason: PayOrderRefundReason;
  amount: string;
  currency: string | null;
};

type RefundStripePaymentArgs = {
  orderId: number;
  paymentIntentId: string;
};

type WriteOrderRefundAuditLogArgs = RefundOrderPaymentArgs & {
  refundId: string | null;
};

// refund the whole stripe payment
async function refundStripePayment({
  orderId,
  paymentIntentId,
}: RefundStripePaymentArgs): Promise<{ refundId: string | null }> {
  try {
    // one key per payment: a repeated webhook delivery returns the same refund instead of a second one
    // params stay constant for this key, stripe rejects a reused key with other params
    const refund = await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        metadata: {
          entityType: 'order',
          entityId: String(orderId),
        },
      },
      { idempotencyKey: `refund:${paymentIntentId}` },
    );

    return { refundId: refund.id };
  } catch (err) {
    // money is already back, e.g. webhook was redelivered after stripe forgot the idempotency key
    if ((err as { code?: unknown } | null)?.code === 'charge_already_refunded') {
      return { refundId: null };
    }

    // any other failure must reach stripe as an error, so the webhook is delivered again
    throw new InternalError(
      {
        reason: 'STRIPE_REFUND_FAILED',
        orderId,
        paymentIntentId,
      },
      err,
    );
  }
}

// write refund into admin audit log, once per payment
async function writeOrderRefundAuditLog({
  orderId,
  fallbackUserId,
  paymentIntentId,
  refundId,
  reason,
  amount,
  currency,
}: WriteOrderRefundAuditLogArgs): Promise<{ logged: boolean }> {
  return tx(
    async (db) => {
      // set admin context: audit log accepts and shows records only for admin context
      await setAdminContext(db);
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

      // skip when this payment is already recorded, stripe can deliver the same event more than once
      const refundMarker = JSON.stringify([{ field: 'refund', new: { paymentIntentId } }]);

      const recorded = await db.$queryRaw<{ id: number }[]>`
        select id
        from cartlify.admin_audit_log
        where "entityType" = 'order'::cartlify."AdminAuditEntityType"
          and "entityId" = ${orderId}::int
          and action = 'OTHER'::cartlify."AdminAuditAction"
          and meta @> ${refundMarker}::jsonb
        limit 1
      `;

      if (recorded.length > 0) {
        return { logged: true as const };
      }

      // record actor is the buyer who gets the money back
      const order = await db.order.findUnique({
        where: { id: orderId },
        select: { userId: true },
      });

      let userId = order?.userId ?? null;

      // order can be deleted by its owner before a late payment arrives: use checkout metadata then
      if (userId === null && fallbackUserId !== null) {
        const user = await db.user.findUnique({
          where: { id: fallbackUserId },
          select: { id: true },
        });

        userId = user?.id ?? null;
      }

      // audit log requires an existing user as actor
      if (userId === null) {
        return { logged: false as const };
      }

      await writeAdminAuditLog(db, {
        actorId: userId,
        actorRole: 'USER',
        entityType: 'order',
        entityId: orderId,
        action: 'OTHER',
        changes: [
          {
            field: 'refund',
            old: null,
            new: {
              initiator: 'system',
              reason,
              amount,
              currency,
              paymentIntentId,
              refundId,
            },
          },
        ],
      });

      return { logged: true as const };
    },
    {
      maxRetries: 3,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 1500,
      timeout: 10_000,
    },
  );
}

// return money for a payment that the order could not take
async function refundOrderPaymentFromStripeWebhook(
  args: RefundOrderPaymentArgs,
): Promise<{ refundId: string | null; logged: boolean }> {
  // refund first: if the audit write fails, the webhook is delivered again and the refund is not repeated
  const { refundId } = await refundStripePayment({
    orderId: args.orderId,
    paymentIntentId: args.paymentIntentId,
  });

  const { logged } = await writeOrderRefundAuditLog({ ...args, refundId });

  return { refundId, logged };
}

export { refundOrderPaymentFromStripeWebhook, refundStripePayment };
