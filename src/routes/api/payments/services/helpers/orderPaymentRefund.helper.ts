import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';

import { getPaymentProvider } from '../../providers/index.js';
import {
  sendPaymentRefundedEmail,
  type PaymentRefundedMailLogger,
} from './sendPaymentRefundedEmail.helper.js';

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

// logged: the refund has its line in the audit log; created: this call wrote it, the earlier
// deliveries of the event did not; userId: the buyer it is recorded for
type RefundAuditResult = { logged: boolean; created: boolean; userId: number | null };

// the line of the audit log that records the refund of this payment
const refundMarkerOf = (provider: PaymentProviderName, paymentId: string) =>
  JSON.stringify([{ field: 'refund', new: { provider, paymentId } }]);

// the money of this payment went back already: a provider that delivers its event again later
// must not make the order take it, the buyer has it back (until the refunds have a table of
// their own, the audit log line is the record)
async function isPaymentRefunded(args: {
  provider: PaymentProviderName;
  paymentId: string;
  orderId: number;
}): Promise<boolean> {
  return tx(async (db) => {
    await setAdminContext(db);

    const recorded = await db.$queryRaw<{ id: number }[]>`
      select id
      from cartlify.admin_audit_log
      where "entityType" = 'order'::cartlify."AdminAuditEntityType"
        and "entityId" = ${args.orderId}::int
        and action = 'OTHER'::cartlify."AdminAuditAction"
        and meta @> ${refundMarkerOf(args.provider, args.paymentId)}::jsonb
      limit 1
    `;

    return recorded.length > 0;
  });
}

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
}: WriteOrderRefundAuditLogArgs): Promise<RefundAuditResult> {
  return tx(
    async (db) => {
      // set admin context: audit log accepts and shows records only for admin context
      await setAdminContext(db);
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

      // skip when this payment is already recorded, a provider can deliver the same event more than once
      const refundMarker = refundMarkerOf(provider, paymentId);

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
        return { logged: true, created: false, userId: null };
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
        return { logged: false, created: false, userId: null };
      }

      await writeAdminAuditLog(db, {
        actorId: userId,
        actorRole: 'USER',
        entityType: 'order',
        entityId: orderId,
        action: 'OTHER',
        event: 'order.refund_late',
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

      return { logged: true, created: true, userId };
    },
    {
      maxRetries: 3,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 1500,
      timeout: 10_000,
    },
  );
}

// return money for a payment that the order could not take, and tell the buyer once
async function refundLatePayment(
  args: RefundLatePaymentArgs,
  log: PaymentRefundedMailLogger,
): Promise<{ refundId: string | null; logged: boolean }> {
  // refund first: if the audit write fails, the event is delivered again and the refund is not repeated
  const { refundId } = await getPaymentProvider(args.provider).refundPayment({
    orderId: args.orderId,
    paymentId: args.paymentId,
  });

  const { logged, created, userId } = await writeOrderRefundAuditLog({ ...args, refundId });

  // the first record of this refund mails the buyer; a delivery of the same event again does not
  if (created && userId !== null && args.currency) {
    await sendPaymentRefundedEmail(
      {
        orderId: args.orderId,
        userId,
        amount: args.amount,
        currency: args.currency,
        reason: args.reason,
      },
      log,
    );
  }

  return { refundId, logged };
}

export { isPaymentRefunded, refundLatePayment };
