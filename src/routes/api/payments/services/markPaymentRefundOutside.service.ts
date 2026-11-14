import { Prisma } from '@prisma/client';

import { getPgMessage, tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
} from '@utils/errors.js';

import {
  MONEY_REFUNDS,
  moneyRefundById,
  returnsLeftOf,
  type MoneyRefundRow,
} from './helpers/moneyRefunds.helper.js';
import { sendPaymentRefundOutsideEmail } from './helpers/paymentRefundMails.helper.js';
import { refundItemOf } from './listPaymentRefunds.service.js';

import type {
  MarkPaymentRefundOutsideDto,
  PaymentRefundOutsideDto,
} from 'types/dto/payments.dto.js';

// what mark_payment_refund_outside (db/05) says it wrote
type MarkedOutside = { id: number; refundLineId: number };

// the refusals of the database function, as the answers of the route
const REFUSALS: Record<string, () => Error> = {
  PAYMENT_REFUND_NOT_FOUND: () => new NotFoundError('PAYMENT_REFUND_NOT_FOUND'),
  PAYMENT_REFUND_NOT_FAILED: () => new ConflictError('PAYMENT_REFUND_NOT_FAILED'),
  PAYMENT_REFUND_ALREADY_MARKED: () => new ConflictError('PAYMENT_REFUND_ALREADY_MARKED'),
  PAYMENT_REFUND_DISPUTED: () => new ConflictError('PAYMENT_REFUND_DISPUTED'),
  PAYMENT_REFUND_OUTSIDE_AT_INVALID: () => new BadRequestError('PAYMENT_REFUND_OUTSIDE_AT_INVALID'),
  PAYMENT_REFUND_OUTSIDE_NOTE_REQUIRED: () =>
    new BadRequestError('PAYMENT_REFUND_OUTSIDE_NOTE_REQUIRED'),
  PAYMENT_REFUND_FORBIDDEN: () => new ForbiddenError('PAYMENT_REFUND_FORBIDDEN'),
};

// Root records that the money of a refund that failed (of a late payment, or made by hand in the
// dashboard of the provider) went to the buyer another way (a bank transfer, cash, another way), on
// the day it really went. The refund is named by the id of the list of the refunds (its first line
// in the money journal); only one whose last word is a failure, once. The money journal gets the
// line money.outside that names the refund (mark_payment_refund_outside, db/05), the journal of the
// admins the line of root that names both lines (payment.refund_outside), and the buyer is mailed
// how much, how and when. Two marks at the same time wait for each other, the second is refused
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
  // root, or an admin root allowed to handle the money: the guard of the route asks the database,
  // and the function of the database checks it again
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');

  const day = new Date(at);
  if (Number.isNaN(day.getTime())) throw new BadRequestError('PAYMENT_REFUND_OUTSIDE_AT_INVALID');

  let row: MoneyRefundRow;
  let left: Map<number, string>;
  try {
    ({ row, left } = await tx(
      async (db) => {
        await setUserContext(db, { userId: actorId, role: actorRole });
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        const [marked] = await db.$queryRaw<{ marked: MarkedOutside }[]>(Prisma.sql`
          select cartlify.mark_payment_refund_outside(
            ${refundId}::int,
            ${method}::cartlify."OutsideMethod",
            ${note}::text,
            (${day.toISOString()}::timestamptz AT TIME ZONE 'UTC')
          ) as marked
        `);

        const [refund] = await db.$queryRaw<MoneyRefundRow[]>(Prisma.sql`
          select t.* from ${MONEY_REFUNDS} as t where ${moneyRefundById(refundId)}
        `);
        if (!refund) throw new InternalError({ reason: 'PAYMENT_REFUND_NOT_FOUND_AFTER_OUTSIDE' });

        await writeAdminAuditLog(db, {
          actorId,
          actorRole,
          entityType: 'order',
          entityId: refund.orderId,
          action: 'OTHER',
          event: 'payment.refund_outside',
          changes: [
            {
              field: 'moneyLogIds',
              old: null,
              new: [marked!.marked.refundLineId, marked!.marked.id],
            },
            {
              field: 'refund',
              old: null,
              new: {
                purpose: refund.purpose,
                provider: refund.provider,
                paymentId: refund.paymentId,
                refundId: refund.refundId,
                amount: refund.amount,
                currency: refund.currency,
                method,
                at: day.toISOString(),
              },
            },
            // the note is a field of its own: the anonymizer of the dev copy blanks the notes by name
            { field: 'note', old: null, new: note },
          ],
        });

        // what its open statement still has to send
        return { row: refund, left: await returnsLeftOf(db, [refund]) };
      },
      {
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        timeout: 10_000,
      },
    ));
  } catch (err) {
    const refusal = REFUSALS[String(getPgMessage(err) ?? '')];
    throw refusal ? refusal() : err;
  }

  if (row.orderId !== null && row.userId !== null && row.currency) {
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
    ...refundItemOf(row, left),
    outside: { method, note, at: day.toISOString(), by: Number(actorId) },
  };
}
