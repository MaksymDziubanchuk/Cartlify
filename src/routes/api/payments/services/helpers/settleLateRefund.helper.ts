import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';

import { lockLateRefund, readLateRefund, type LateRefundRow } from './lateRefundRows.helper.js';
import {
  sendPaymentRefundedEmail,
  sendPaymentRefundFailedEmail,
  type PaymentRefundMailLogger,
} from './paymentRefundMails.helper.js';

import type { PaymentProviderName, RefundAnswer } from '../../providers/types.js';
import type { PayOrderRefundReason } from './orderPaymentTx.helper.js';

// what a late refund became by an answer of the provider: its money is sent, it failed, it stays as
// it was (a refund still on its way, the same end told again, an end after another), or the app made
// no such refund (one made by hand at the provider)
export type SettledLateRefund = 'sent' | 'failed' | 'unchanged' | 'unknown';

// the end of the refund of a late payment, told by the provider: right after the refund is made when
// the provider already says it succeeded, or by its event later. Each end is written once, with
// the buyer mailed once after it, whatever the number of the answers and however many come at the
// same time: the changes of the state of one refund wait for each other (a lock on its payment) and
// the second finds the line of the first.
// - succeeded: the money is sent, once, unless the refund failed meanwhile (an old answer)
// - failed (also canceled): the refund failed, once, also after its money was sent: the bank of the
//   card sent it back
// - pending: nothing, the end has not come
export async function settleLateRefund(
  match: {
    provider: PaymentProviderName;
    // the id of the refund at the provider and the payment it is for: either finds the refund
    refundId: string | null;
    paymentId: string | null;
  },
  answer: RefundAnswer,
  log: PaymentRefundMailLogger,
): Promise<SettledLateRefund> {
  if (answer.status === 'pending') return 'unchanged';

  const settled = await tx(
    async (db) => {
      await setAdminContext(db);
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

      // the payment names the lock, so the refund is found before it, and read again after it: the
      // state is the one the last change under the lock left
      const found = await readLateRefund(db, match);
      if (!found) return { result: 'unknown' as const };

      await lockLateRefund(db, found.paymentId);
      const row = await readLateRefund(db, match);
      if (!row) return { result: 'unknown' as const };

      if (answer.status === 'succeeded') {
        if (row.state !== 'created') return { result: 'unchanged' as const };

        await writeEnd(db, row, 'order.refund_late_sent', answer, {});
        return { result: 'sent' as const, row };
      }

      // failed: once, whether the money had been sent or not; after the mark of root nothing
      if (row.state !== 'created' && row.state !== 'sent') return { result: 'unchanged' as const };

      const sentBack = row.state === 'sent';
      const failure = answer.failure ?? 'unknown';
      await writeEnd(db, row, 'order.refund_late_failed', answer, {
        failure,
        failureText: answer.failureText ?? null,
        sentBack,
      });
      return { result: 'failed' as const, row, failure, sentBack };
    },
    {
      maxRetries: 3,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 1500,
      timeout: 10_000,
    },
  );

  // the mail follows the commit, once: only the call that wrote the line gets here with its row
  if (settled.result === 'sent' && settled.row.currency) {
    await sendPaymentRefundedEmail(
      {
        orderId: settled.row.orderId,
        userId: settled.row.userId,
        amount: settled.row.amount,
        currency: settled.row.currency,
        reason: settled.row.reason as PayOrderRefundReason,
      },
      log,
    );
  }

  if (settled.result === 'failed' && settled.row.currency) {
    await sendPaymentRefundFailedEmail(
      {
        orderId: settled.row.orderId,
        userId: settled.row.userId,
        amount: settled.row.amount,
        currency: settled.row.currency,
        failure: settled.failure,
        sentBack: settled.sentBack,
      },
      log,
    );
  }

  return settled.result;
}

// the line of the end, for the buyer it is recorded for, as the line of the refund itself is
async function writeEnd(
  db: Prisma.TransactionClient,
  row: LateRefundRow,
  event: 'order.refund_late_sent' | 'order.refund_late_failed',
  answer: RefundAnswer,
  more: Record<string, unknown>,
): Promise<void> {
  await writeAdminAuditLog(db, {
    actorId: row.userId,
    actorRole: 'USER',
    entityType: 'order',
    entityId: row.orderId,
    action: 'OTHER',
    event,
    changes: [
      {
        field: 'refund',
        old: null,
        new: {
          initiator: 'system',
          provider: row.provider,
          paymentId: row.paymentId,
          refundId: answer.refundId ?? row.refundId,
          amount: row.amount,
          currency: row.currency,
          ...more,
        },
      },
    ],
  });
}
