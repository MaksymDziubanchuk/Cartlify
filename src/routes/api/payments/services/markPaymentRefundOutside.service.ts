import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@utils/errors.js';

import { lockLateRefund, readLateRefundById } from './helpers/lateRefundRows.helper.js';
import { sendPaymentRefundOutsideEmail } from './helpers/paymentRefundMails.helper.js';

import type {
  MarkPaymentRefundOutsideDto,
  PaymentRefundOutsideDto,
} from 'types/dto/payments.dto.js';

// Root records that the money of a late payment whose refund failed went back to the buyer another
// way (a bank transfer, cash, another way), on the day it really went. Only a refund that failed and
// is not marked yet: the refund leaves the alert of the failed refunds and the buyer is mailed how
// much, how and when. Two marks at the same time wait for each other, the second finds the first
export async function markPaymentRefundOutside({
  actorId,
  actorRole,
  refundId,
  method,
  note,
  at,
  log,
}: MarkPaymentRefundOutsideDto): Promise<PaymentRefundOutsideDto> {
  assertAdminActor(actorId, actorRole);
  if (actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');

  const day = new Date(at);
  if (Number.isNaN(day.getTime())) throw new BadRequestError('LATE_REFUND_OUTSIDE_AT_INVALID');

  const row = await tx(
    async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

      // the payment names the lock, so the refund is found before it, and read again after it
      const found = await readLateRefundById(db, refundId);
      if (!found) throw new NotFoundError('LATE_REFUND_NOT_FOUND');

      await lockLateRefund(db, found.paymentId);
      const current = await readLateRefundById(db, refundId);
      if (!current) throw new NotFoundError('LATE_REFUND_NOT_FOUND');

      if (current.state === 'outside') throw new ConflictError('LATE_REFUND_ALREADY_MARKED');
      if (current.state !== 'failed') throw new ConflictError('LATE_REFUND_NOT_FAILED');

      // the money went on a day that has come, by the clock of the database that dates the lines,
      // and not before the refund was made
      const [clock] = await db.$queryRaw<{ now: Date }[]>`
        select (now() at time zone 'UTC') as now
      `;
      if (day.getTime() > clock!.now.getTime() || day.getTime() < current.createdAt.getTime()) {
        throw new BadRequestError('LATE_REFUND_OUTSIDE_AT_INVALID');
      }

      await writeAdminAuditLog(db, {
        actorId,
        actorRole,
        entityType: 'order',
        entityId: current.orderId,
        action: 'OTHER',
        event: 'order.refund_late_outside',
        changes: [
          {
            field: 'refund',
            old: null,
            new: {
              initiator: 'root',
              provider: current.provider,
              paymentId: current.paymentId,
              refundId: current.refundId,
              amount: current.amount,
              currency: current.currency,
              method,
              at: day.toISOString(),
            },
          },
          // the note is a field of its own: the anonymizer of the dev copy blanks the notes by name
          { field: 'note', old: null, new: note },
        ],
      });

      return current;
    },
    {
      maxRetries: 3,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 1500,
      timeout: 10_000,
    },
  );

  if (row.currency) {
    await sendPaymentRefundOutsideEmail(
      {
        orderId: row.orderId,
        userId: row.userId,
        amount: row.amount,
        currency: row.currency,
        method,
        sentOn: day,
      },
      log,
    );
  }

  return {
    refundId,
    orderId: row.orderId,
    userId: row.userId,
    provider: row.provider,
    paymentId: row.paymentId,
    amount: Number(row.amount),
    currency: row.currency,
    state: 'outside',
    failure: row.failure,
    failureText: row.failureText,
    outside: { method, note, at: day.toISOString(), by: Number(actorId) },
  };
}
