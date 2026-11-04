import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { InternalError } from '@utils/errors.js';

import { sendReturnMoneyEmail, sendReturnRefundFailedEmail } from './returnMoneyMail.helper.js';

import type { RefundAnswer } from '@routes/api/payments/providers/types.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';
import type { ReturnMailLogger } from './sendReturnByShopEmail.helper.js';

// what begin_return_refund (db/05) says to ask the provider for
export type StartedRefund = {
  key: string;
  returnId: number;
  orderId: number;
  provider: string;
  paymentId: string;
  amount: string;
  itemIds: number[];
  // the rows root lowered in this call, for the journal of the admins
  lowered: Array<{ itemId: number; from: string; to: string; note: string | null }>;
  // the cost of the way back taken off the transfer
  deduction: string;
};

// what finish_return_refund (db/05) says it did; changed is false when no row waited for the key
export type FinishedRefund = {
  changed: boolean;
  status: string;
  returnId?: number;
  orderId?: number;
  itemIds?: number[];
  amount?: string;
  // the cost of the way back the buyer owes, taken off the transfer
  deduction?: string;
  // the provider took back a refund it had made (the bank of the card sent the money back): the
  // rows are not refunded again
  reversed?: boolean;
};

// who settles a transfer: the admin whose request it is, or the system (the payment webhook, the
// worker) when the provider tells the end later
export type RefundActor = { id: UserId; role: Role } | null;

// Settles the transfer of this key by what the provider answered (the last of the three steps of a
// refund; the webhook and the worker call it too). The rows change in one transaction with the line
// of the admin log; the mail follows the commit. It is safe to call twice: only rows still pending
// under the key are settled, so the second call changes nothing and mails nothing
export async function settleReturnRefund({
  key,
  answer,
  actor,
  log,
}: {
  key: string;
  answer: RefundAnswer;
  actor: RefundActor;
  log: ReturnMailLogger;
}): Promise<FinishedRefund> {
  const finished = await tx(async (db) => {
    if (actor) await setUserContext(db, { userId: actor.id, role: actor.role });
    else await setAdminContext(db);

    const [row] = await db.$queryRaw<{ finished: FinishedRefund }[]>(Prisma.sql`
      select cartlify.finish_return_refund(
        ${key}::uuid,
        ${answer.status}::text,
        ${answer.refundId}::text,
        ${answer.failure ?? null}::cartlify."ReturnRefundFailure",
        ${answer.failureText ?? null}::text
      ) as finished
    `);
    const result = row!.finished;

    // a transfer that went back or failed is a line of the log; one still pending is not an event yet
    if (result.changed && result.orderId !== undefined && result.returnId !== undefined) {
      // the system acts for the buyer of the order, as a payment given back late does
      const owner = actor
        ? null
        : await db.order.findUnique({ where: { id: result.orderId }, select: { userId: true } });
      if (!actor && !owner) {
        throw new InternalError({ reason: 'RETURN_ORDER_OWNER_MISSING', orderId: result.orderId });
      }

      await writeAdminAuditLog(db, {
        actorId: actor ? actor.id : owner!.userId,
        actorRole: actor ? actor.role : 'USER',
        entityType: 'order',
        entityId: result.orderId,
        action: 'OTHER',
        event: answer.status === 'succeeded' ? 'return.refund' : 'return.refund_failed',
        changes: [
          { field: 'returnId', old: null, new: result.returnId },
          {
            field: 'refund',
            old: null,
            new: {
              initiator: actor ? 'admin' : 'system',
              amount: result.amount,
              // the cost of the way back the buyer owes, taken off the transfer
              ...(result.deduction && Number(result.deduction) > 0
                ? { returnShippingDeduction: result.deduction }
                : {}),
              refundId: answer.refundId,
              itemIds: result.itemIds,
              ...(answer.status === 'failed'
                ? { failure: answer.failure, failureText: answer.failureText }
                : {}),
              // the money had gone and the bank of the card sent it back
              ...(result.reversed ? { sentBack: true } : {}),
            },
          },
        ],
      });
    }

    return result;
  });

  if (finished.changed && finished.returnId !== undefined && finished.itemIds) {
    if (answer.status === 'succeeded') {
      await sendReturnMoneyEmail(finished.returnId, finished.itemIds, log);
    } else if (answer.status === 'failed' && answer.failure === 'card_unavailable') {
      await sendReturnRefundFailedEmail(
        finished.returnId,
        finished.itemIds,
        log,
        finished.reversed === true,
      );
    }
  }

  return finished;
}
