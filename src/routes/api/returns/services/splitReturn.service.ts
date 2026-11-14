import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { InternalError } from '@utils/errors.js';

import { readReturnCard } from './helpers/returnCard.helper.js';
import { returnErrorOf } from './helpers/returnErrors.helper.js';
import { sendReturnSplitEmail } from './helpers/returnMoneyMail.helper.js';

import type { ReturnDto, SplitReturnDto } from 'types/dto/returns.dto.js';

// An admin or root takes units of a statement into a new statement of the order: the buyer sends
// them back in a parcel of their own (the parcel of the first came without them). The new statement
// keeps the moment, the person, the source and the basis of the first, with the next number; the
// buyer is mailed its code once it is kept. The answer is the card of the new statement
export async function splitReturn({
  actorId,
  actorRole,
  returnId,
  items,
  log,
}: SplitReturnDto): Promise<ReturnDto> {
  assertAdminActor(actorId, actorRole);

  let card: ReturnDto;
  try {
    card = await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });

      const [row] = await db.$queryRaw<{ id: number }[]>(Prisma.sql`
        select cartlify.split_return(${returnId}::int, ${JSON.stringify(items)}::jsonb) as id
      `);
      if (!row) throw new InternalError({ reason: 'RETURN_SPLIT_NOT_MADE' });

      const made = await readReturnCard(db, row.id, actorRole);
      if (!made) throw new InternalError({ reason: 'RETURN_NOT_FOUND_AFTER_SPLIT' });

      await writeAdminAuditLog(db, {
        actorId,
        actorRole,
        entityType: 'order',
        entityId: made.orderId,
        action: 'OTHER',
        event: 'return.split',
        changes: [
          { field: 'returnId', old: null, new: returnId },
          { field: 'splitId', old: null, new: row.id },
          { field: 'itemIds', old: null, new: made.items.map((item) => item.id) },
        ],
      });

      // the card again: its history begins with the line just written
      return (await readReturnCard(db, row.id, actorRole))!;
    });
  } catch (err) {
    throw returnErrorOf(err);
  }

  await sendReturnSplitEmail(card.id, log);

  return card;
}
