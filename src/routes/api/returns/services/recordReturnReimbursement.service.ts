import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { BadRequestError, ForbiddenError, InternalError } from '@utils/errors.js';

import { readReturnCard } from './helpers/returnCard.helper.js';
import { returnErrorOf } from './helpers/returnErrors.helper.js';
import { sendReturnReimbursedEmail } from './helpers/returnMoneyMail.helper.js';

import type { RecordReturnReimbursementDto, ReturnDto } from 'types/dto/returns.dto.js';

// root records that the shop gave the buyer back what they paid the carrier for the way back,
// outside the app (a payment of the card cannot be more than the order was paid), on the day it
// really went: the shop pays the way back and the buyer paid the carrier. The buyer is mailed
export async function recordReturnReimbursement({
  actorId,
  actorRole,
  returnId,
  amount,
  method,
  note,
  at,
  log,
}: RecordReturnReimbursementDto): Promise<ReturnDto> {
  assertAdminActor(actorId, actorRole);
  if (actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');

  const day = new Date(at);
  if (Number.isNaN(day.getTime())) throw new BadRequestError('RETURN_OUTSIDE_AT_INVALID');

  let card: ReturnDto;
  try {
    card = await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });

      const [row] = await db.$queryRaw<{ done: { orderId: number; amount: string } }[]>(
        Prisma.sql`
          select cartlify.record_return_reimbursement(
            ${returnId}::int,
            ${amount}::numeric,
            ${method}::cartlify."ReturnOutsideMethod",
            ${note}::text,
            (${day.toISOString()}::timestamptz AT TIME ZONE 'UTC')
          ) as done
        `,
      );

      await writeAdminAuditLog(db, {
        actorId,
        actorRole,
        entityType: 'order',
        entityId: row!.done.orderId,
        action: 'OTHER',
        event: 'return.shipping_reimburse',
        changes: [
          { field: 'returnId', old: null, new: returnId },
          {
            field: 'reimbursement',
            old: null,
            new: { amount: row!.done.amount, method, at: day.toISOString() },
          },
          // the note is a field of its own: the anonymizer of the dev copy blanks the notes by name
          { field: 'note', old: null, new: note },
        ],
      });

      const read = await readReturnCard(db, returnId, actorRole);
      if (!read) throw new InternalError({ reason: 'RETURN_NOT_FOUND_AFTER_REIMBURSEMENT' });
      return read;
    });
  } catch (err) {
    throw returnErrorOf(err);
  }

  await sendReturnReimbursedEmail(returnId, log);

  return card;
}
