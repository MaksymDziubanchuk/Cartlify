import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';

import { getPaymentProvider } from '../../providers/index.js';

import type { PaymentProviderName } from '../../providers/types.js';
import type { PayOrderRefundReason } from './orderPaymentTx.helper.js';

type RefundLatePaymentArgs = {
  // who took the money and the id of the payment there
  provider: PaymentProviderName;
  paymentId: string;
  orderId: number;
  // order owner from the payment page, used when the order row is already deleted
  fallbackUserId: number | null;
  reason: PayOrderRefundReason;
  amount: string;
  currency: string | null;
};

type WriteOrderRefundAuditLogArgs = RefundLatePaymentArgs & {
  refundId: string | null;
};

// write refund into admin audit log, once per payment
async function writeOrderRefundAuditLog({
  provider,
  paymentId,
  orderId,
  fallbackUserId,
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

      // skip when this payment is already recorded, a provider can deliver the same event more than once
      const refundMarker = JSON.stringify([{ field: 'refund', new: { provider, paymentId } }]);

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

      // order can be deleted by its owner before a late payment arrives: use the payment page then
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
              provider,
              paymentId,
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
async function refundLatePayment(
  args: RefundLatePaymentArgs,
): Promise<{ refundId: string | null; logged: boolean }> {
  // refund first: if the audit write fails, the event is delivered again and the refund is not repeated
  const { refundId } = await getPaymentProvider(args.provider).refundPayment({
    orderId: args.orderId,
    paymentId: args.paymentId,
  });

  const { logged } = await writeOrderRefundAuditLog({ ...args, refundId });

  return { refundId, logged };
}

export { refundLatePayment };
