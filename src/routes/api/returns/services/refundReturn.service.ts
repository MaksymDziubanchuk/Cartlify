import { Prisma } from '@prisma/client';

import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { tx } from '@db/client.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { getPaymentProvider } from '@routes/api/payments/providers/index.js';
import { failureOf } from '@helpers/failureOf.js';

import { returnErrorOf } from './helpers/returnErrors.helper.js';
import {
  settleReturnRefund,
  type RefundActor,
  type StartedRefund,
} from './helpers/returnRefund.helper.js';
import { getReturn } from './getReturn.service.js';

import type { PaymentProviderName } from '@routes/api/payments/providers/types.js';
import type { ReturnMailLogger } from './helpers/sendReturnByShopEmail.helper.js';
import type { RefundReturnDto, ReturnDto } from 'types/dto/returns.dto.js';

// an admin or a root gives the money of the rows of a statement back to the buyer, in three steps:
// 1. one transaction checks the rows, works out the sum (the delivery goes with the row that makes
//    the order whole) and puts them on their way under a new key of the transfer;
// 2. the provider is asked outside any transaction, with that key, so a request asked twice is one
//    transfer;
// 3. a second transaction settles the rows by the answer.
// With no answer the rows stay on their way and the worker asks again with the same key; a webhook
// of the provider settles them too. The answer of this request is the card, which shows where each
// row stands (a failed transfer shows why)
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

// The three steps of a refund for the actor given: an admin, or the system for a buyer's own
// withdrawal from a paid order (nobody is signed in who may give money back). With the system as
// the actor the money is given back in the name of the shop, and the log names the buyer
export async function giveMoneyBack({
  returnId,
  actor,
  itemIds,
  reductions,
  returnShippingDeduction,
  log,
}: {
  returnId: number;
  actor: RefundActor;
  itemIds?: number[];
  reductions?: Array<{ itemId: number; amount: number; note?: string }>;
  returnShippingDeduction?: number;
  log: ReturnMailLogger & { error: (obj: unknown, msg?: string) => void };
}): Promise<void> {
  let started: StartedRefund;
  try {
    started = await tx(async (db) => {
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

      // a lowered sum is a decision of root: the journal keeps each row with its sums and reason
      for (const lowered of begun.lowered) {
        await writeAdminAuditLog(db, {
          actorId: actor!.id,
          actorRole: actor!.role,
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

      return begun;
    });
  } catch (err) {
    throw returnErrorOf(err);
  }

  const answer = await getPaymentProvider(started.provider as PaymentProviderName).refundPayment({
    orderId: started.orderId,
    paymentId: started.paymentId,
    amount: started.amount,
    key: `refund:${started.key}`,
  });

  // the money may be on its way already: a failure to settle is logged and left to the worker
  try {
    await settleReturnRefund({ key: started.key, answer, actor, log });
  } catch (err) {
    log.error({ ...failureOf(err), returnId, key: started.key }, 'return refund was not settled');
  }
}
