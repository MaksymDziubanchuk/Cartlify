import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { ForbiddenError, InternalError } from '@utils/errors.js';

import { readReturnCard } from './helpers/returnCard.helper.js';
import { returnErrorOf } from './helpers/returnErrors.helper.js';
import { sendReturnClosedEmail } from './helpers/returnMoneyMail.helper.js';

import type { CloseReturnDto, ReturnDto } from 'types/dto/returns.dto.js';

// root closes the rows of a statement that wait for goods that never came, without a refund: the
// money is refused with the code, the stock does not move. The statement keeps the code and the
// note; when no row waits any more it is closed, the order says so, and the buyer is mailed (the
// code in words, never the note)
export async function closeReturnRows({
  actorId,
  actorRole,
  returnId,
  itemIds,
  code,
  note,
  log,
}: CloseReturnDto): Promise<ReturnDto> {
  assertAdminActor(actorId, actorRole);
  // root, or an admin root allowed to handle the money: the guard of the route asks the database,
  // and the function of the database checks it again
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');

  let card: ReturnDto;
  try {
    card = await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });

      const [row] = await db.$queryRaw<
        { done: { itemIds: number[]; closed: boolean } }[]
      >(Prisma.sql`
        select cartlify.close_return_without_refund(
          ${returnId}::int,
          ${itemIds ?? null}::int[],
          ${code}::cartlify."ReturnCloseCode",
          ${note}::text
        ) as done
      `);

      const read = await readReturnCard(db, returnId, actorRole);
      if (!read) throw new InternalError({ reason: 'RETURN_NOT_FOUND_AFTER_CLOSE' });

      await writeAdminAuditLog(db, {
        actorId,
        actorRole,
        entityType: 'order',
        entityId: read.orderId,
        action: 'OTHER',
        event: 'return.close',
        changes: [
          { field: 'returnId', old: null, new: returnId },
          { field: 'closed', old: null, new: { code, itemIds: row!.done.itemIds } },
          // the note is a field of its own: the anonymizer of the dev copy blanks the notes by name
          { field: 'note', old: null, new: note },
        ],
      });

      // the card again: its history ends with the line just written
      return (await readReturnCard(db, returnId, actorRole))!;
    });
  } catch (err) {
    throw returnErrorOf(err);
  }

  if (card.closedAt) await sendReturnClosedEmail(returnId, log, { withCode: true });

  return card;
}
