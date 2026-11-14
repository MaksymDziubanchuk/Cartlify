import { Prisma } from '@prisma/client';

import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { tx } from '@db/client.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { getPaymentProvider } from '@routes/api/payments/providers/index.js';
import { settleMoneyRefund } from '@routes/api/payments/services/helpers/settleMoneyRefund.helper.js';
import { failureOf } from '@helpers/failureOf.js';

import { returnErrorOf } from './helpers/returnErrors.helper.js';
import { sendReturnMoneyEmail } from './helpers/returnMoneyMail.helper.js';
import {
  linesOfMovement,
  linesOfTransfer,
  type RefundActor,
  type StartedRefund,
} from './helpers/returnRefund.helper.js';
import { getReturn } from './getReturn.service.js';

import type { PaymentProviderName } from '@routes/api/payments/providers/types.js';
import type { ReturnMailLogger } from './helpers/sendReturnByShopEmail.helper.js';
import type { RefundReturnDto, ReturnDto } from 'types/dto/returns.dto.js';

// an admin or a root gives the money of the rows of a statement back to the buyer (or the way back
// left alone, by a transfer of its own), in three steps:
// 1. one transaction checks the rows, works out the sum (the delivery goes with the row that makes
//    the order whole, the way back the buyer owes is taken off, money already sent another way is
//    used first) and writes the transfer in parts into the money journal, in transit, under a new
//    key of the request;
// 2. the provider is asked outside any transaction, with that key, so a request asked twice is one
//    transfer;
// 3. the answer settles the lines and the rows (settle_money_refund).
// With no answer the lines stay in transit and the worker asks again with the same key; a webhook
// of the provider settles them too. The answer of this request is the card, which shows where each
// row stands and the movements of the money
export async function refundReturn({
  actorId,
  actorRole,
  returnId,
  itemIds,
  reductions,
  returnShippingDeduction,
  log,
}: RefundReturnDto): Promise<ReturnDto> {
  assertAdminActor(actorId, actorRole);

  await giveMoneyBack({
    returnId,
    actor: { id: actorId, role: actorRole },
    ...(itemIds ? { itemIds } : {}),
    ...(reductions ? { reductions } : {}),
    ...(returnShippingDeduction !== undefined ? { returnShippingDeduction } : {}),
    log,
  });

  return getReturn({ actorId, actorRole, returnId });
}

type TransferArgs = {
  returnId: number;
  actor: RefundActor;
  itemIds?: number[];
  reductions?: Array<{ itemId: number; amount: number; note?: string }>;
  returnShippingDeduction?: number;
};

type TransferLogger = ReturnMailLogger & { error: (obj: unknown, msg?: string) => void };

// The three steps of a refund for the actor given: an admin or root, or the system for a buyer's own
// withdrawal from a paid order (nobody is signed in who may give money back), for what is left of
// an order after a dispute the bank decided, or for an order cancelled by the system. A transfer a
// person starts is a line of the journal of the admins with the lines of the money journal it
// wrote; the work of the system is in the money journal only
export async function giveMoneyBack({
  log,
  ...args
}: TransferArgs & { log: TransferLogger }): Promise<void> {
  let started: StartedRefund;
  try {
    started = await tx((db) => beginReturnTransfer(db, args));
  } catch (err) {
    throw returnErrorOf(err);
  }

  await finishReturnTransfer(started, args.actor, log);
}

// the first step, in the transaction of the caller (a decision of root that ties money to a
// statement and pays its rows in one go): the transfer is written in parts into the money journal,
// in transit, and the journal of the admins keeps a transfer a person starts. The refusals of the
// database are the caller's to answer (returnErrorOf)
export async function beginReturnTransfer(
  db: Prisma.TransactionClient,
  { returnId, actor, itemIds, reductions, returnShippingDeduction }: TransferArgs,
): Promise<StartedRefund> {
  if (actor) await setUserContext(db, { userId: actor.id, role: actor.role });
  else await setAdminContext(db);

  const [row] = await db.$queryRaw<{ started: StartedRefund }[]>(Prisma.sql`
    select cartlify.begin_return_refund(
      ${returnId}::int,
      ${itemIds ?? null}::int[],
      ${reductions ? JSON.stringify(reductions) : null}::jsonb,
      ${returnShippingDeduction ?? null}::numeric
    ) as started
  `);
  const begun = row!.started;
  if (!actor) return begun;

  // a lowered sum is a decision of root: the journal keeps each row with its sums and reason
  for (const lowered of begun.lowered) {
    await writeAdminAuditLog(db, {
      actorId: actor.id,
      actorRole: actor.role,
      entityType: 'order',
      entityId: begun.orderId,
      action: 'OTHER',
      event: 'return.amount_lower',
      changes: [
        { field: 'returnId', old: null, new: begun.returnId },
        {
          field: 'amount',
          old: null,
          new: { itemId: lowered.itemId, from: lowered.from, to: lowered.to },
        },
        ...(lowered.note ? [{ field: 'note', old: null, new: lowered.note }] : []),
      ],
    });
  }

  await writeAdminAuditLog(db, {
    actorId: actor.id,
    actorRole: actor.role,
    entityType: 'order',
    entityId: begun.orderId,
    action: 'OTHER',
    event: 'return.refund',
    changes: [
      { field: 'returnId', old: null, new: begun.returnId },
      {
        field: 'moneyLogIds',
        old: null,
        // a way back left alone names no row: its transfer is found by its key
        new:
          begun.itemIds.length > 0
            ? await linesOfMovement(db, 'money.refund', begun.returnId, begun.itemIds[0]!)
            : await linesOfTransfer(db, begun.key!),
      },
      {
        field: 'refund',
        old: null,
        new: {
          amount: begun.amount,
          itemIds: begun.itemIds,
          ...(Number(begun.deduction) > 0 ? { returnShippingDeduction: begun.deduction } : {}),
          ...(Number(begun.covered) > 0 ? { covered: begun.covered } : {}),
        },
      },
    ],
  });

  return begun;
}

// the other two steps, after the commit of the first: the provider is asked with the key, and its
// answer settles the lines; money already sent another way paid all of it, or the provider did not
// answer, asks nothing
export async function finishReturnTransfer(
  started: StartedRefund,
  actor: RefundActor,
  log: TransferLogger,
): Promise<void> {
  const returnId = started.returnId;

  // money already sent another way paid all of it: nothing to ask, the rows are refunded
  if (started.settled || !started.key) {
    await sendReturnMoneyEmail(returnId, started.itemIds, log);
    return;
  }

  const answer = await getPaymentProvider(started.provider as PaymentProviderName).refundPayment({
    orderId: started.orderId,
    paymentId: started.paymentId,
    amount: started.amount,
    key: started.key,
  });

  // no answer: the lines stay in transit for the worker
  if (answer.status === 'pending' && answer.refundId === null) return;

  // the money may be on its way already: a failure to settle is logged and left to the worker
  try {
    await settleMoneyRefund({ key: started.key, answer, actor }, log);
  } catch (err) {
    log.error({ ...failureOf(err), returnId, key: started.key }, 'return refund was not settled');
  }
}
