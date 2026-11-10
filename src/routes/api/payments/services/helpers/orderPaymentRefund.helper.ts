import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { failureOf } from '@helpers/failureOf.js';

import { getPaymentProvider } from '../../providers/index.js';
import { lockLateRefund } from './lateRefundRows.helper.js';
import { refundWholePayment } from './refundWholePayment.helper.js';
import { settleLateRefund } from './settleLateRefund.helper.js';

import type { PaymentProviderName, RefundAnswer } from '../../providers/types.js';
import type { PaymentRefundMailLogger } from './paymentRefundMails.helper.js';
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
        and event = 'order.refund_late'
        and meta @> ${refundMarkerOf(args.provider, args.paymentId)}::jsonb
      limit 1
    `;

    return recorded.length > 0;
  });
}

// write refund into admin audit log, once per payment: whether the refund is on the record now
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

      // two deliveries of the event at the same time wait for each other: the second finds the line
      await lockLateRefund(db, paymentId);

      // skip when this payment is already recorded, a provider can deliver the same event more than once
      const refundMarker = refundMarkerOf(provider, paymentId);

      const recorded = await db.$queryRaw<{ id: number }[]>`
        select id
        from cartlify.admin_audit_log
        where "entityType" = 'order'::cartlify."AdminAuditEntityType"
          and "entityId" = ${orderId}::int
          and action = 'OTHER'::cartlify."AdminAuditAction"
          and event = 'order.refund_late'
          and meta @> ${refundMarker}::jsonb
        limit 1
      `;

      if (recorded.length > 0) return { logged: true };

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
      if (userId === null) return { logged: false };

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

      return { logged: true };
    },
    {
      maxRetries: 3,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 1500,
      timeout: 10_000,
    },
  );
}

// where the refund stands once its line is written: the answer to the request when the money is
// sent already or the refund failed at once, otherwise the provider is asked again, because the event that ends the refund may
// have come before the line was there to find. A provider that cannot be asked is no failure of the
// payment (the refund is made): the refund stays as it is, the event that ends it comes later and
// the alert of the refunds not sent covers the rest
async function answerAfterLine(
  refund: RefundAnswer,
  args: RefundLatePaymentArgs,
  log: PaymentRefundMailLogger,
): Promise<RefundAnswer> {
  // a refund that failed at once is settled as the failure it is
  if (refund.status === 'failed') return refund;

  if (refund.status === 'succeeded' || refund.refundId === null) {
    return { refundId: refund.refundId, status: 'succeeded' };
  }

  try {
    return await getPaymentProvider(args.provider).getRefund(refund.refundId);
  } catch (err) {
    log.warn(
      { ...failureOf(err), orderId: args.orderId, paymentId: args.paymentId },
      'the state of the refund of a late payment was not read',
    );

    return { refundId: refund.refundId, status: 'pending' };
  }
}

// return money for a payment that the order could not take, record it, and tell the buyer once the
// money is sent (settleLateRefund)
async function refundLatePayment(
  args: RefundLatePaymentArgs,
  log: PaymentRefundMailLogger,
): Promise<{ refundId: string | null; logged: boolean }> {
  // refund first: if the audit write fails, the event is delivered again and the refund is not repeated
  const refund = await refundWholePayment({
    provider: args.provider,
    paymentId: args.paymentId,
    orderId: args.orderId,
    amount: args.amount,
  });

  const { logged } = await writeOrderRefundAuditLog({ ...args, refundId: refund.refundId });

  // the refund is on the record: its end, if it came, is told now
  if (logged) {
    await settleLateRefund(
      { provider: args.provider, refundId: refund.refundId, paymentId: args.paymentId },
      await answerAfterLine(refund, args, log),
      log,
    );
  }

  return { refundId: refund.refundId, logged };
}

export { isPaymentRefunded, refundLatePayment };
