import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { BadRequestError, ForbiddenError, InternalError } from '@utils/errors.js';

import { readReturnCard } from './helpers/returnCard.helper.js';
import { returnErrorOf } from './helpers/returnErrors.helper.js';
import {
  sendReturnMoneyEmail,
  sendReturnReimbursedEmail,
} from './helpers/returnMoneyMail.helper.js';

import type { RefundReturnOutsideDto, ReturnDto } from 'types/dto/returns.dto.js';

// root records that the money a statement owes went back outside the app (a bank transfer, cash,
// another way), on the day it really went: the rows whose money is owed and the way back the shop
// owes, money the buyer already has first. The money journal gets the parts of it, the journal of
// the admins the line of root with those lines. The buyer is mailed that the money is back, that the
// statement is closed when this was the last of it, or that the way back was paid back when it was
// all of it
export async function markReturnRefundedOutside({
  actorId,
  actorRole,
  returnId,
  itemIds,
  method,
  note,
  at,
  returnShippingDeduction,
  log,
}: RefundReturnOutsideDto): Promise<ReturnDto> {
  assertAdminActor(actorId, actorRole);
  // root, or an admin root allowed to handle the money: the guard of the route asks the database,
  // and the function of the database checks it again
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');

  const day = new Date(at);
  if (Number.isNaN(day.getTime())) throw new BadRequestError('RETURN_OUTSIDE_AT_INVALID');

  let done: { itemIds: number[]; amount: string };
  let card: ReturnDto;
  try {
    ({ done, card } = await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });

      const [row] = await db.$queryRaw<
        { done: { itemIds: number[]; amount: string } }[]
      >(Prisma.sql`
        select cartlify.mark_return_refunded_outside(
          ${returnId}::int,
          ${itemIds ?? null}::int[],
          ${method}::cartlify."OutsideMethod",
          ${note}::text,
          (${day.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
          ${returnShippingDeduction ?? null}::numeric
        ) as done
      `);

      const read = await readReturnCard(db, returnId, actorRole);
      if (!read) throw new InternalError({ reason: 'RETURN_NOT_FOUND_AFTER_OUTSIDE' });

      // the lines this step wrote: the money outside the app of the statement at the moment of the
      // transaction
      const written = await db.$queryRaw<{ id: number }[]>(Prisma.sql`
        select l.id from cartlify.money_log as l
        where l."returnId" = ${returnId}::int and l.event = 'money.outside'
          and l."createdAt" = (now() at time zone 'UTC')::timestamp(3)
        order by l.id
      `);

      await writeAdminAuditLog(db, {
        actorId,
        actorRole,
        entityType: 'order',
        entityId: read.orderId,
        action: 'OTHER',
        event: 'return.refund_outside',
        changes: [
          { field: 'returnId', old: null, new: returnId },
          {
            field: 'moneyLogIds',
            old: null,
            new: written.map((line) => line.id),
          },
          {
            field: 'refund',
            old: null,
            new: {
              method,
              at: day.toISOString(),
              itemIds: row!.done.itemIds,
              amount: row!.done.amount,
            },
          },
          // the note is a field of its own: the anonymizer of the dev copy blanks the notes by name
          { field: 'note', old: null, new: note },
        ],
      });

      // the card again: its history ends with the line just written
      return { done: row!.done, card: (await readReturnCard(db, returnId, actorRole))! };
    }));
  } catch (err) {
    throw returnErrorOf(err);
  }

  if (done.itemIds.length) await sendReturnMoneyEmail(returnId, done.itemIds, log);
  else await sendReturnReimbursedEmail(returnId, log);

  return card;
}
